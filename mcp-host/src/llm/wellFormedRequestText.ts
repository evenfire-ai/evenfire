/**
 * Well-formed request text at the provider boundary (issue #1433).
 *
 * A lone UTF-16 surrogate has no UTF-8 encoding. `JSON.stringify` emits it as
 * an escape such as `\ud83d`, and every provider rejects the whole request
 * with HTTP 400 (Anthropic: "unexpected end of hex escape"; Codex and Grok
 * upstreams: plain 400). Text reaches a request from MCP tool results, user and
 * channel messages, replayed history and approval snapshots, so the only point
 * that covers every path is the provider itself: `makeProvider` wraps each
 * provider it builds with {@link withWellFormedRequestText}.
 *
 * A lone surrogate is replaced with U+FFFD (`String.prototype.toWellFormed`).
 * The repair is never silent: each repaired message emits one `warn` line
 * (provider, role, tool name, count, never the text) and increments
 * `clerum_llm_request_text_repaired_total`.
 *
 * The wrap runs in the provider's public methods, before any request is built,
 * so the subscription providers hash the repaired request and control-api and
 * the proxies re-derive the same hash. Well-formed input passes through as the
 * same references, so its requests and hashes are unchanged.
 */
import { Counter } from 'prom-client'
import type { SystemPromptParts } from '../core/reasoning/systemPrompt'
import type { ChatMessage, MessageContentPart, ToolDefinition } from '../core/types'
import { logger } from '../logger'
import type { LlmProvider } from './registryCore'
import type { SingleTurnProvider } from './types'

export const clerumLlmRequestTextRepairedTotal = new Counter({
  name: 'clerum_llm_request_text_repaired_total',
  help: 'Lone UTF-16 surrogates replaced with U+FFFD before an LLM provider call.',
  labelNames: ['provider', 'role'] as const,
})

/** With the `u` flag, `\p{Cs}` matches only the surrogates that are not part of a pair. */
const LONE_SURROGATE = /\p{Cs}/gu

type Tally = { units: number }

function repairString(value: string, tally: Tally): string {
  if (value.isWellFormed()) return value
  tally.units += value.match(LONE_SURROGATE)?.length ?? 0
  return value.toWellFormed()
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * `value` with every string repaired, object keys included. Arrays and plain
 * objects are walked; anything else (numbers, AbortSignal, Buffers) is
 * returned as is. Returns the same reference when nothing under it changed and
 * a shallow copy along the changed path otherwise, so inputs are never mutated.
 * `skipKeys` names keys whose values are left untouched at this level only.
 */
function repairDeep<T>(value: T, tally: Tally, skipKeys?: ReadonlySet<string>): T {
  if (typeof value === 'string') return repairString(value, tally) as T
  if (Array.isArray(value)) {
    let out: unknown[] | undefined
    for (let i = 0; i < value.length; i++) {
      const repaired = repairDeep(value[i], tally)
      if (repaired !== value[i]) {
        out ??= value.slice()
        out[i] = repaired
      }
    }
    return (out ?? value) as T
  }
  if (!isPlainObject(value)) return value
  let changed = false
  const entries: Array<[string, unknown]> = []
  for (const [key, item] of Object.entries(value)) {
    const repairedKey = repairString(key, tally)
    const repaired = skipKeys?.has(key) ? item : repairDeep(item, tally)
    if (repairedKey !== key || repaired !== item) changed = true
    entries.push([repairedKey, repaired])
  }
  if (!changed) return value
  const out: Record<string, unknown> =
    Object.getPrototypeOf(value) === null ? Object.create(null) : {}
  // defineProperty keeps a key such as "__proto__" an ordinary own property.
  for (const [key, item] of entries) {
    Object.defineProperty(out, key, {
      value: item,
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return out as T
}

/** Image bytes are base64 and the MIME type is an enum: neither can hold a lone surrogate. */
const IMAGE_OPAQUE_KEYS: ReadonlySet<string> = new Set(['data', 'mimeType'])

function repairPart(part: MessageContentPart, tally: Tally): MessageContentPart {
  return part.type === 'image'
    ? repairDeep(part, tally, IMAGE_OPAQUE_KEYS)
    : repairDeep(part, tally)
}

function repairMessage(message: ChatMessage, tally: Tally): ChatMessage {
  const { contentParts, ...rest } = message
  const repairedRest = repairDeep(rest, tally)
  let repairedParts = contentParts
  if (contentParts) {
    let out: MessageContentPart[] | undefined
    for (let i = 0; i < contentParts.length; i++) {
      const repaired = repairPart(contentParts[i], tally)
      if (repaired !== contentParts[i]) {
        out ??= contentParts.slice()
        out[i] = repaired
      }
    }
    repairedParts = out ?? contentParts
  }
  if (repairedRest === rest && repairedParts === contentParts) return message
  return contentParts ? { ...repairedRest, contentParts: repairedParts } : repairedRest
}

type RepairSignal = {
  provider: LlmProvider
  role: string
  units: number
  toolName?: string
  toolCallId?: string
}

function reportRepair({ provider, role, units, toolName, toolCallId }: RepairSignal): void {
  clerumLlmRequestTextRepairedTotal.inc({ provider, role }, units)
  logger.warn(
    {
      component: 'LLM',
      provider,
      role,
      ...(toolName !== undefined ? { toolName } : {}),
      ...(toolCallId !== undefined ? { toolCallId } : {}),
      repairedUnits: units,
    },
    'Replaced lone UTF-16 surrogates with U+FFFD before provider dispatch'
  )
}

function repairMessages(messages: ChatMessage[], provider: LlmProvider): ChatMessage[] {
  let out: ChatMessage[] | undefined
  for (let i = 0; i < messages.length; i++) {
    const tally: Tally = { units: 0 }
    const repaired = repairMessage(messages[i], tally)
    if (repaired === messages[i]) continue
    out ??= messages.slice()
    out[i] = repaired
    reportRepair({
      provider,
      role: repaired.role,
      units: tally.units,
      toolName: repaired.role === 'tool' ? repaired.name : undefined,
      toolCallId: repaired.tool_call_id,
    })
  }
  return out ?? messages
}

function repairTools(tools: ToolDefinition[], provider: LlmProvider): ToolDefinition[] {
  let out: ToolDefinition[] | undefined
  for (let i = 0; i < tools.length; i++) {
    const tally: Tally = { units: 0 }
    const repaired = repairDeep(tools[i], tally)
    if (repaired === tools[i]) continue
    out ??= tools.slice()
    out[i] = repaired
    reportRepair({ provider, role: 'tool_definition', units: tally.units, toolName: repaired.name })
  }
  return out ?? tools
}

function repairSystemParts(parts: SystemPromptParts, provider: LlmProvider): SystemPromptParts {
  const tally: Tally = { units: 0 }
  const stable = repairString(parts.stable, tally)
  const context = repairString(parts.context, tally)
  if (stable === parts.stable && context === parts.context) return parts
  reportRepair({ provider, role: 'system_prompt', units: tally.units })
  return { ...parts, stable, context }
}

/**
 * Make `provider` send only well-formed text. The request methods the instance
 * has are overridden in place, as own properties, so optional methods that are
 * absent stay absent, `this` is unchanged for every other member, and the
 * object stays an instance of its class.
 */
export function withWellFormedRequestText<T extends SingleTurnProvider>(provider: T): T {
  const providerType = provider.getProviderType()

  const completeSingleTurn = provider.completeSingleTurn.bind(provider)
  provider.completeSingleTurn = (messages, options) =>
    completeSingleTurn(repairMessages(messages, providerType), options)

  const completeSingleTurnWithTools = provider.completeSingleTurnWithTools.bind(provider)
  provider.completeSingleTurnWithTools = (messages, tools, options) =>
    completeSingleTurnWithTools(
      repairMessages(messages, providerType),
      repairTools(tools, providerType),
      options
    )

  if (provider.completeSingleTurnWithToolsAndCache) {
    const withToolsAndCache = provider.completeSingleTurnWithToolsAndCache.bind(provider)
    provider.completeSingleTurnWithToolsAndCache = (parts, messages, tools, options) =>
      withToolsAndCache(
        repairSystemParts(parts, providerType),
        repairMessages(messages, providerType),
        repairTools(tools, providerType),
        options
      )
  }

  if (provider.completeSingleTurnAndCache) {
    const andCache = provider.completeSingleTurnAndCache.bind(provider)
    provider.completeSingleTurnAndCache = (parts, messages, options) =>
      andCache(
        repairSystemParts(parts, providerType),
        repairMessages(messages, providerType),
        options
      )
  }

  return provider
}
