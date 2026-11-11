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
 * The repair is never silent: each repaired message, tool definition or system
 * prompt emits one `warn` line (provider, role, tool name, count, never the
 * text) and increments `clerum_llm_request_text_repaired_total`, once the
 * whole request has been repaired and before the provider method is called.
 * A repair that would make two keys of one object equal is not done: the
 * request is refused before dispatch with
 * {@link RequestTextKeyCollisionError}, which the provider classifies as
 * `LLM_REQUEST_TEXT_REJECTED`, and no repair is reported for it. The provider
 * can still refuse or fail a repaired request before dispatch (over-deep or
 * cyclic input, see `repairDeep`); its repairs are then already logged and
 * counted.
 *
 * The wrap runs in the provider's public methods, before any request is built,
 * so the subscription providers hash the repaired request and control-api and
 * the proxies re-derive the same hash. Well-formed input passes through as the
 * same references, so its requests and hashes are unchanged.
 */
import { Counter } from 'prom-client'
import { LlmErrorCode } from '../core/errors'
import type { SystemPromptParts } from '../core/reasoning/systemPrompt'
import type { ChatMessage, MessageContentPart, ToolDefinition } from '../core/types'
import { logger } from '../logger'
import type { LlmProvider } from './registryCore'
import type { ClassifiedError, SingleTurnProvider } from './types'

export const clerumLlmRequestTextRepairedTotal = new Counter({
  name: 'clerum_llm_request_text_repaired_total',
  help: 'Lone UTF-16 surrogates replaced with U+FFFD before an LLM provider call.',
  labelNames: ['provider', 'role'] as const,
})

/** With the `u` flag, `\p{Cs}` matches only the surrogates that are not part of a pair. */
const LONE_SURROGATE = /\p{Cs}/gu

type Tally = { units: number; keyCollisions: number }

function newTally(): Tally {
  return { units: 0, keyCollisions: 0 }
}

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

function isContainer(value: unknown): value is unknown[] | Record<string, unknown> {
  return Array.isArray(value) || isPlainObject(value)
}

type ArrayFrame = {
  kind: 'array'
  src: unknown[]
  index: number
  out: unknown[] | undefined
  /** The child container being walked, as read from `src` on the way down. */
  child: unknown
}

type ObjectFrame = {
  kind: 'object'
  src: Record<string, unknown>
  keys: string[]
  index: number
  outKeys: string[]
  values: unknown[]
  changed: boolean
  keyRepaired: boolean
  skipKeys: ReadonlySet<string> | undefined
  child: unknown
}

type Frame = ArrayFrame | ObjectFrame

function newFrame(src: unknown[] | Record<string, unknown>, skipKeys?: ReadonlySet<string>): Frame {
  if (Array.isArray(src)) return { kind: 'array', src, index: 0, out: undefined, child: undefined }
  const keys = Object.keys(src)
  return {
    kind: 'object',
    src,
    keys,
    index: 0,
    outKeys: new Array<string>(keys.length),
    values: new Array<unknown>(keys.length),
    changed: false,
    keyRepaired: false,
    skipKeys,
    child: undefined,
  }
}

/** The repaired container of a finished frame, or its source when nothing under it changed. */
function finishFrame(frame: Frame, tally: Tally): unknown {
  if (frame.kind === 'array') return frame.out ?? frame.src
  if (!frame.changed) return frame.src
  const out: Record<string, unknown> =
    Object.getPrototypeOf(frame.src) === null ? Object.create(null) : {}
  for (let i = 0; i < frame.keys.length; i++) {
    const key = frame.outKeys[i]
    // Two keys that repair to the same text, or a repaired key equal to an
    // untouched one: writing both would silently drop a value.
    if (frame.keyRepaired && Object.prototype.hasOwnProperty.call(out, key)) {
      tally.keyCollisions += 1
    }
    // defineProperty keeps a key such as "__proto__" an ordinary own property.
    Object.defineProperty(out, key, {
      value: frame.values[i],
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return out
}

/**
 * `root` with every string repaired, object keys included. Arrays and plain
 * objects are walked; anything else (numbers, AbortSignal, Buffers) is
 * returned as is. Returns the same reference when nothing under it changed and
 * a shallow copy along the changed path otherwise, so inputs are never mutated.
 * `skipKeys` names keys whose values are left untouched at the top level only.
 *
 * The walk uses an explicit stack, so no nesting depth makes it fail; the
 * parsers behind the providers keep their own depth limits.
 *
 * Most input is JSON-decoded data, which is a tree. A container that is
 * already on the current path (a cycle) is kept as is, unrepaired, and not
 * entered; every provider arm then refuses or fails the request before
 * dispatch. A container reachable along several paths is walked once per path
 * and its lone units are counted once per path. For objects that all
 * reference each other the number of paths grows factorially with their
 * count. Code-built tool schemas do reuse sub-objects (for example
 * `workflow/toolSchemas/dashboard.ts`); each reuse is walked once per path. No
 * producer of cyclic input, or of objects that all reference each other, is
 * known, so the walk does not guard against it (#1433).
 */
function repairDeep<T>(root: T, tally: Tally, skipKeys?: ReadonlySet<string>): T {
  if (typeof root === 'string') return repairString(root, tally) as T
  if (!isContainer(root)) return root
  const stack: Frame[] = [newFrame(root, skipKeys)]
  const onPath = new Set<unknown>([root])
  let done: unknown
  let hasDone = false
  for (;;) {
    const frame = stack[stack.length - 1]
    if (hasDone) {
      hasDone = false
      const i = frame.index - 1
      if (frame.kind === 'array') {
        if (done !== frame.child) {
          frame.out ??= frame.src.slice()
          frame.out[i] = done
        }
      } else {
        if (done !== frame.child) frame.changed = true
        frame.values[i] = done
      }
      frame.child = undefined
    }
    const length = frame.kind === 'array' ? frame.src.length : frame.keys.length
    let descended = false
    while (frame.index < length) {
      const i = frame.index++
      let item: unknown
      if (frame.kind === 'array') {
        item = frame.src[i]
      } else {
        const key = frame.keys[i]
        const repairedKey = repairString(key, tally)
        if (repairedKey !== key) {
          frame.changed = true
          frame.keyRepaired = true
        }
        frame.outKeys[i] = repairedKey
        item = frame.src[key]
        if (frame.skipKeys?.has(key)) {
          frame.values[i] = item
          continue
        }
      }
      if (typeof item === 'string') {
        const repaired = repairString(item, tally)
        if (frame.kind === 'array') {
          if (repaired !== item) {
            frame.out ??= frame.src.slice()
            frame.out[i] = repaired
          }
        } else {
          if (repaired !== item) frame.changed = true
          frame.values[i] = repaired
        }
        continue
      }
      if (!isContainer(item) || onPath.has(item)) {
        if (frame.kind === 'object') frame.values[i] = item
        continue
      }
      frame.child = item
      onPath.add(item)
      stack.push(newFrame(item))
      descended = true
      break
    }
    if (descended) continue
    done = finishFrame(frame, tally)
    hasDone = true
    onPath.delete(frame.src)
    stack.pop()
    if (stack.length === 0) return done as T
  }
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

/**
 * The request was not sent: repairing its text would have made two keys of
 * one object equal, which would silently drop a value. The message names the
 * tool or role and never the keys or the text.
 */
export class RequestTextKeyCollisionError extends Error {
  override readonly name = 'RequestTextKeyCollisionError'
  readonly provider: LlmProvider
  readonly role: string
  readonly toolName: string | undefined
  readonly toolCallId: string | undefined

  constructor(fields: {
    provider: LlmProvider
    role: string
    toolName?: string
    toolCallId?: string
  }) {
    const subject =
      fields.role === 'tool_definition'
        ? `the definition of tool '${fields.toolName ?? 'unnamed'}'`
        : `the ${fields.role} message${fields.toolName !== undefined ? ` for tool '${fields.toolName}'` : ''}`
    super(
      `Request not sent: ${subject} has object keys that become identical after invalid Unicode (lone UTF-16 surrogates) is replaced. The keys must be distinct.`
    )
    this.provider = fields.provider
    this.role = fields.role
    this.toolName = fields.toolName
    this.toolCallId = fields.toolCallId
  }
}

type RepairSignal = {
  role: string
  units: number
  toolName?: string
  toolCallId?: string
}

/** The repairs of one provider call, reported only once the whole request is repaired. */
type RepairRun = { provider: LlmProvider; signals: RepairSignal[] }

function reportRepairs(run: RepairRun): void {
  for (const { role, units, toolName, toolCallId } of run.signals) {
    clerumLlmRequestTextRepairedTotal.inc({ provider: run.provider, role }, units)
    logger.warn(
      {
        component: 'LLM',
        provider: run.provider,
        role,
        ...(toolName !== undefined ? { toolName } : {}),
        ...(toolCallId !== undefined ? { toolCallId } : {}),
        repairedUnits: units,
      },
      'Replaced lone UTF-16 surrogates with U+FFFD before provider dispatch'
    )
  }
}

function repairMessages(messages: ChatMessage[], run: RepairRun): ChatMessage[] {
  let out: ChatMessage[] | undefined
  for (let i = 0; i < messages.length; i++) {
    const tally = newTally()
    const repaired = repairMessage(messages[i], tally)
    if (repaired === messages[i]) continue
    const toolName = repaired.role === 'tool' ? repaired.name : undefined
    if (tally.keyCollisions > 0) {
      throw new RequestTextKeyCollisionError({
        provider: run.provider,
        role: repaired.role,
        toolName,
        toolCallId: repaired.tool_call_id,
      })
    }
    out ??= messages.slice()
    out[i] = repaired
    run.signals.push({
      role: repaired.role,
      units: tally.units,
      toolName,
      toolCallId: repaired.tool_call_id,
    })
  }
  return out ?? messages
}

function repairTools(tools: ToolDefinition[], run: RepairRun): ToolDefinition[] {
  let out: ToolDefinition[] | undefined
  for (let i = 0; i < tools.length; i++) {
    const tally = newTally()
    const repaired = repairDeep(tools[i], tally)
    if (repaired === tools[i]) continue
    if (tally.keyCollisions > 0) {
      throw new RequestTextKeyCollisionError({
        provider: run.provider,
        role: 'tool_definition',
        toolName: repaired.name,
      })
    }
    out ??= tools.slice()
    out[i] = repaired
    run.signals.push({ role: 'tool_definition', units: tally.units, toolName: repaired.name })
  }
  return out ?? tools
}

function repairSystemParts(parts: SystemPromptParts, run: RepairRun): SystemPromptParts {
  const tally = newTally()
  const stable = repairString(parts.stable, tally)
  const context = repairString(parts.context, tally)
  if (stable === parts.stable && context === parts.context) return parts
  run.signals.push({ role: 'system_prompt', units: tally.units })
  return { ...parts, stable, context }
}

/** Same descriptor as a class method, so `Object.keys(provider)` does not change. */
function defineOwnMethod(target: object, name: string, value: unknown): void {
  Object.defineProperty(target, name, {
    value,
    enumerable: false,
    writable: true,
    configurable: true,
  })
}

/**
 * Make `provider` send only well-formed text. The request methods the instance
 * has, and `classifyError`, are overridden in place as non-enumerable own
 * properties, so optional methods that are absent stay absent, `Object.keys`
 * and `this` are unchanged for every other member, and the object stays an
 * instance of its class. The overrides are `async`: a request refused by the
 * repair reaches the caller as a rejected promise, which `classifyError`
 * reports as `LLM_REQUEST_TEXT_REJECTED`, never dispatched and not retryable.
 */
export function withWellFormedRequestText<T extends SingleTurnProvider>(provider: T): T {
  const providerType = provider.getProviderType()
  const newRun = (): RepairRun => ({ provider: providerType, signals: [] })

  const completeSingleTurn = provider.completeSingleTurn.bind(provider)
  const repairedCompleteSingleTurn: SingleTurnProvider['completeSingleTurn'] = async (
    messages,
    options
  ) => {
    const run = newRun()
    const repairedMessages = repairMessages(messages, run)
    reportRepairs(run)
    return completeSingleTurn(repairedMessages, options)
  }
  defineOwnMethod(provider, 'completeSingleTurn', repairedCompleteSingleTurn)

  const completeSingleTurnWithTools = provider.completeSingleTurnWithTools.bind(provider)
  const repairedWithTools: SingleTurnProvider['completeSingleTurnWithTools'] = async (
    messages,
    tools,
    options
  ) => {
    const run = newRun()
    const repairedMessages = repairMessages(messages, run)
    const repairedTools = repairTools(tools, run)
    reportRepairs(run)
    return completeSingleTurnWithTools(repairedMessages, repairedTools, options)
  }
  defineOwnMethod(provider, 'completeSingleTurnWithTools', repairedWithTools)

  if (provider.completeSingleTurnWithToolsAndCache) {
    const withToolsAndCache = provider.completeSingleTurnWithToolsAndCache.bind(provider)
    const repairedWithToolsAndCache: NonNullable<
      SingleTurnProvider['completeSingleTurnWithToolsAndCache']
    > = async (parts, messages, tools, options) => {
      const run = newRun()
      const repairedParts = repairSystemParts(parts, run)
      const repairedMessages = repairMessages(messages, run)
      const repairedTools = repairTools(tools, run)
      reportRepairs(run)
      return withToolsAndCache(repairedParts, repairedMessages, repairedTools, options)
    }
    defineOwnMethod(provider, 'completeSingleTurnWithToolsAndCache', repairedWithToolsAndCache)
  }

  if (provider.completeSingleTurnAndCache) {
    const andCache = provider.completeSingleTurnAndCache.bind(provider)
    const repairedAndCache: NonNullable<SingleTurnProvider['completeSingleTurnAndCache']> = async (
      parts,
      messages,
      options
    ) => {
      const run = newRun()
      const repairedParts = repairSystemParts(parts, run)
      const repairedMessages = repairMessages(messages, run)
      reportRepairs(run)
      return andCache(repairedParts, repairedMessages, options)
    }
    defineOwnMethod(provider, 'completeSingleTurnAndCache', repairedAndCache)
  }

  const classifyError = provider.classifyError.bind(provider)
  const classifyWithRefusal: SingleTurnProvider['classifyError'] = err =>
    err instanceof RequestTextKeyCollisionError
      ? ({
          code: LlmErrorCode.RequestTextRejected,
          retryable: false,
          message: err.message,
          providerCode: 'request_text_key_collision',
          // The repair runs before the inner method, so nothing left the process.
          providerDispatched: false,
        } satisfies ClassifiedError)
      : classifyError(err)
  defineOwnMethod(provider, 'classifyError', classifyWithRefusal)

  return provider
}
