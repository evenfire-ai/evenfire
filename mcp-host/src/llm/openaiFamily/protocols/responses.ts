/**
 * `/responses` wire protocol. Requests never store conversation state at the
 * provider (`store: false`); the reasoning the model produced inside a tool
 * loop travels back as encrypted items attached to the assistant message
 * (`provider_continuation`) and is replayed only to the driver that made it.
 */
import { createHash } from 'node:crypto'
import type OpenAI from 'openai'
import { LlmError, LlmErrorCode } from '../../../core/errors'
import {
  type CompletionResponse,
  type ChatMessage as CoreChatMessage,
  FinishReason,
  type ProviderContinuation,
  type ToolCall,
  type ToolCompletionResponse,
} from '../../../core/types'
import { logger } from '../../../logger'
import type { ResolvedModelParams } from '../modelParamPolicy'
import { isUsageReported, parseArguments } from '../shared'
import type { DecodeContext, DriverIdentity, EncodeContext, WireProtocol } from './types'

type ResponsesPayload = OpenAI.Responses.ResponseCreateParamsNonStreaming
type ResponsesResult = OpenAI.Responses.Response
type InputItem = OpenAI.Responses.ResponseInputItem
type LayoutEntry = ProviderContinuation['layout'][number]

/**
 * Bounds what one assistant message carries at rest (it is persisted with an
 * approval snapshot) and inside the visual request budget. Above it the
 * continuity is dropped: the API accepts a function call without its reasoning.
 */
export const CONTINUATION_REASONING_MAX_BYTES = 256 * 1024

const OPENAI_RESPONSES = 'openai-responses' as const

/**
 * A 2xx whose `status` is neither `completed` nor `incomplete`. Not retryable
 * by default: the same request gets the same answer. The transient provider
 * codes are classified as their HTTP status would be, so a failure reported
 * inside a 2xx behaves like the equivalent 5xx/429.
 */
export class OpenAIResponseFailedError extends LlmError {
  constructor(provider: string, status: string | undefined, providerCode: string | undefined) {
    const transient = providerCode === undefined ? undefined : TRANSIENT_CODES.get(providerCode)
    super(
      `OpenAI response finished with status '${status ?? 'missing'}'` +
        (providerCode ? ` (${providerCode})` : ''),
      provider,
      transient ?? LlmErrorCode.InvalidResponse,
      transient !== undefined,
      undefined,
      undefined,
      providerCode
    )
    this.name = 'OpenAIResponseFailedError'
  }
}

const TRANSIENT_CODES: ReadonlyMap<string, LlmErrorCode> = new Map([
  ['server_error', LlmErrorCode.ModelOverloaded],
  ['rate_limit_exceeded', LlmErrorCode.RateLimited],
])

// ─── Shared pieces ──────────────────────────────────────────

function hasContent(content: unknown): boolean {
  return typeof content === 'string' && content.length > 0
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .filter(k => (value as Record<string, unknown>)[k] !== undefined)
      .map(k => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * The same function runs on the decoded response and on the message being
 * encoded. Between the two the loop turns `content: null` into `''`; both are
 * "no content", so presence, not the text, is what the digest covers: a
 * redaction of the text keeps the reasoning, a removed or added text does not.
 */
export function continuationDigest(
  toolCalls: readonly ToolCall[] | null | undefined,
  content: unknown
): string {
  const canonical = canonicalJson({
    tool_calls: (toolCalls ?? []).map(tc => ({
      id: tc.id,
      name: tc.name,
      arguments: tc.arguments,
    })),
    hasContent: hasContent(content),
  })
  return createHash('sha256').update(canonical).digest('hex')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// The continuation crossed persistence and hook boundaries as plain data, so
// its shape is checked rather than trusted.
function sameOwner(owner: unknown, identity: DriverIdentity): boolean {
  return (
    isPlainObject(owner) &&
    owner.provider === identity.provider &&
    owner.protocol === identity.protocol &&
    owner.model === identity.model &&
    owner.epoch === identity.epoch
  )
}

const RESPONSES_MIN_OUTPUT_TOKENS = 16

/**
 * Responses rejects `max_output_tokens` below 16 with a 400 (16 itself is
 * accepted), while callers can legitimately ask for less. Raising the limit to
 * the minimum keeps the turn alive instead of failing it, so a configured cap
 * below 16 yields up to 16 output tokens on this protocol.
 */
function tokenLimit(maxTokens: number | undefined): { max_output_tokens?: number } {
  if (maxTokens === undefined) return {}
  return {
    max_output_tokens:
      maxTokens < RESPONSES_MIN_OUTPUT_TOKENS ? RESPONSES_MIN_OUTPUT_TOKENS : maxTokens,
  }
}

function temperatureField(
  temperature: number | undefined,
  params: ResolvedModelParams
): { temperature?: number } {
  return params.temperature === 'pass' && temperature !== undefined ? { temperature } : {}
}

/**
 * Fixed on every request: nothing is retained provider-side, so the encrypted
 * reasoning has to come back in the response to be replayable. Models without
 * reasoning ignore `include`.
 */
function stateless(): { store: false; include: OpenAI.Responses.ResponseIncludable[] } {
  return { store: false, include: ['reasoning.encrypted_content'] }
}

// ─── Encode ─────────────────────────────────────────────────

function plainAssistantItems(m: CoreChatMessage, calls: readonly ToolCall[]): InputItem[] {
  const items: InputItem[] = []
  if (hasContent(m.content)) {
    items.push({ type: 'message', role: 'assistant', content: m.content })
  }
  for (const tc of calls) {
    items.push({
      type: 'function_call',
      call_id: tc.id,
      name: tc.name,
      arguments: JSON.stringify(tc.arguments),
    })
  }
  return items
}

/** Rebuilt field by field, so nothing but a reasoning item reaches the wire. */
function reasoningItem(item: unknown): InputItem | null {
  if (
    !isPlainObject(item) ||
    item.type !== 'reasoning' ||
    typeof item.id !== 'string' ||
    typeof item.encrypted_content !== 'string' ||
    !Array.isArray(item.summary)
  ) {
    return null
  }
  return {
    type: 'reasoning',
    id: item.id,
    summary: item.summary,
    encrypted_content: item.encrypted_content,
  } as InputItem
}

/** `null` when the layout does not describe exactly this message's calls and text. */
function replayLayout(
  layout: unknown,
  m: CoreChatMessage,
  calls: readonly ToolCall[]
): InputItem[] | null {
  if (!Array.isArray(layout)) return null
  const byCallId = new Map(calls.map(tc => [tc.id, tc]))
  const replayed = new Set<string>()
  const items: InputItem[] = []
  for (const entry of layout as unknown[]) {
    if (!isPlainObject(entry)) return null
    if (entry.kind === 'reasoning') {
      const item = reasoningItem(entry.item)
      if (!item) return null
      items.push(item)
    } else if (entry.kind === 'function_call') {
      if (typeof entry.call_id !== 'string' || typeof entry.id !== 'string') return null
      const tc = byCallId.get(entry.call_id)
      if (!tc || replayed.has(tc.id)) return null
      replayed.add(tc.id)
      items.push({
        type: 'function_call',
        id: entry.id,
        call_id: tc.id,
        name: tc.name,
        arguments: JSON.stringify(tc.arguments),
      })
    } else if (entry.kind === 'message') {
      if (typeof entry.id !== 'string' || !hasContent(m.content)) return null
      // The exact shape the API accepted when replayed with `store: false`;
      // the SDK type also demands output-only fields (`status`, `annotations`).
      items.push({
        type: 'message',
        role: 'assistant',
        id: entry.id,
        content: [{ type: 'output_text', text: m.content }],
      } as unknown as InputItem)
    } else {
      return null
    }
  }
  return replayed.size === calls.length ? items : null
}

function assistantToolCallItems(
  m: CoreChatMessage,
  calls: readonly ToolCall[],
  identity: DriverIdentity
): InputItem[] {
  const continuation = m.provider_continuation
  if (!continuation) return plainAssistantItems(m, calls)
  let reason: string
  if (!isPlainObject(continuation) || !sameOwner(continuation.owner, identity)) {
    reason = 'owner_mismatch'
  } else if (continuation.digest !== continuationDigest(calls, m.content)) {
    reason = 'digest_mismatch'
  } else {
    const replay = replayLayout(continuation.layout, m, calls)
    if (replay) return replay
    reason = 'layout_mismatch'
  }
  logger.debug({ provider: identity.provider, reason }, 'Responses continuity not replayed')
  return plainAssistantItems(m, calls)
}

function userItem(m: CoreChatMessage): InputItem {
  if (!m.contentParts?.length) return { type: 'message', role: 'user', content: m.content }
  return {
    type: 'message',
    role: 'user',
    content: m.contentParts.map(part =>
      part.type === 'text'
        ? { type: 'input_text' as const, text: part.text }
        : {
            type: 'input_image' as const,
            image_url: `data:${part.mimeType};base64,${part.data}`,
            detail: 'auto' as const,
          }
    ),
  }
}

function convertMessages(
  messages: readonly CoreChatMessage[],
  identity: DriverIdentity
): InputItem[] {
  return messages.flatMap((m): InputItem[] => {
    if (m.role === 'tool') {
      return [{ type: 'function_call_output', call_id: m.tool_call_id!, output: m.content }]
    }
    if (m.role === 'user') return [userItem(m)]
    if (m.role === 'assistant') {
      if (m.tool_calls?.length) return assistantToolCallItems(m, m.tool_calls, identity)
      return [{ type: 'message', role: 'assistant', content: m.content }]
    }
    // System messages stay in position: `instructions` would hoist the ones
    // the loop injects mid-conversation to the start.
    return [{ type: 'message', role: 'system', content: m.content }]
  })
}

// ─── Decode ─────────────────────────────────────────────────

const STATUSES_WITH_OUTPUT = new Set(['completed', 'incomplete'])

function assertDecodable(raw: ResponsesResult, ctx: DecodeContext): void {
  const status = (raw as { status?: unknown } | null)?.status
  if (typeof status === 'string' && STATUSES_WITH_OUTPUT.has(status)) return
  const error = (raw as { error?: { code?: unknown } | null } | null)?.error
  const providerCode = typeof error?.code === 'string' ? error.code : undefined
  const usage = (raw as { usage?: Partial<OpenAI.Responses.ResponseUsage> | null } | null)?.usage
  // Keys avoid "token": the logger redacts every key that contains it.
  logger.warn(
    {
      provider: ctx.provider,
      status: typeof status === 'string' ? status : null,
      providerCode: providerCode ?? null,
      inputUsage: usage?.input_tokens ?? null,
      outputUsage: usage?.output_tokens ?? null,
      totalUsage: usage?.total_tokens ?? null,
    },
    'OpenAI response did not complete'
  )
  throw new OpenAIResponseFailedError(
    ctx.provider,
    typeof status === 'string' ? status : undefined,
    providerCode
  )
}

function finishReason(raw: ResponsesResult, hasToolCalls: boolean): FinishReason {
  if (raw.status === 'completed') return hasToolCalls ? FinishReason.ToolUse : FinishReason.Stop
  switch (raw.incomplete_details?.reason) {
    case 'max_output_tokens':
      return FinishReason.Length
    case 'content_filter':
      return FinishReason.ContentFilter
    default:
      return FinishReason.Unknown
  }
}

function usageOf(raw: ResponsesResult) {
  return {
    usage: {
      input_tokens: raw.usage?.input_tokens ?? 0,
      output_tokens: raw.usage?.output_tokens ?? 0,
      total_tokens: raw.usage?.total_tokens ?? 0,
    },
    usage_reported:
      raw.usage != null && isUsageReported(raw.usage.input_tokens, raw.usage.output_tokens),
  }
}

interface DecodedOutput {
  content: string | null
  toolCalls: ToolCall[]
  layout: LayoutEntry[]
  /** Why the output cannot be replayed as-is; `null` when it can. */
  unreplayable: string | null
}

function isRawArguments(args: Record<string, unknown>, original: string): boolean {
  return Object.keys(args).length === 1 && args._raw === original
}

function decodeOutput(raw: ResponsesResult): DecodedOutput {
  const output: unknown[] = Array.isArray(raw.output) ? raw.output : []
  const texts: string[] = []
  const toolCalls: ToolCall[] = []
  const layout: LayoutEntry[] = []
  let unreplayable: string | null = output.length === 0 ? 'empty_output' : null
  let messages = 0
  const flag = (reason: string) => {
    unreplayable ??= reason
  }

  for (const item of output as Array<Record<string, unknown>>) {
    switch (item?.type) {
      case 'reasoning':
        if (typeof item.id !== 'string' || typeof item.encrypted_content !== 'string') {
          flag('reasoning_without_encrypted_content')
        }
        // Only the fields a stateless replay needs; the rest is response metadata.
        layout.push({
          kind: 'reasoning',
          item: {
            type: 'reasoning',
            id: item.id,
            summary: Array.isArray(item.summary) ? item.summary : [],
            encrypted_content: item.encrypted_content,
          },
        })
        break
      case 'function_call': {
        const original = typeof item.arguments === 'string' ? item.arguments : ''
        const args = parseArguments(original)
        const call: ToolCall = {
          id: String(item.call_id),
          name: String(item.name),
          arguments: args,
        }
        toolCalls.push(call)
        if (typeof item.id !== 'string' || typeof item.call_id !== 'string') flag('unknown_shape')
        // Valid JSON that is not an object (`null`, an array, a number) is
        // passed through as Chat does, but it is not a call shape to replay.
        if (!isPlainObject(args)) flag('non_object_arguments')
        else if (isRawArguments(args, original)) flag('unparseable_arguments')
        layout.push({ kind: 'function_call', call_id: call.id, id: String(item.id) })
        break
      }
      case 'message': {
        messages++
        if (messages > 1) flag('multiple_messages')
        const parts = Array.isArray(item.content)
          ? (item.content as Array<Record<string, unknown>>)
          : []
        for (const part of parts) {
          if (part?.type === 'output_text' && typeof part.text === 'string') texts.push(part.text)
          else flag('non_text_message_part')
        }
        if (typeof item.id !== 'string') flag('unknown_shape')
        layout.push({ kind: 'message', id: String(item.id) })
        break
      }
      default:
        flag('unknown_shape')
    }
  }

  const content = texts.length > 0 ? texts.join('') : null
  if (layout.at(-1)?.kind === 'reasoning') flag('trailing_reasoning')
  if (messages > 0 && !hasContent(content)) flag('empty_message')
  return { content, toolCalls, layout, unreplayable }
}

function continuationOf(
  raw: ResponsesResult,
  decoded: DecodedOutput,
  ctx: DecodeContext
): ProviderContinuation | undefined {
  // Only a tool-call turn is replayed by the loop; a text answer ends it.
  if (raw.status !== 'completed' || decoded.unreplayable || decoded.toolCalls.length === 0) {
    return undefined
  }
  const reasoningBytes = Buffer.byteLength(
    JSON.stringify(decoded.layout.filter(e => e.kind === 'reasoning').map(e => e.item)),
    'utf8'
  )
  if (reasoningBytes > CONTINUATION_REASONING_MAX_BYTES) {
    logger.warn(
      { provider: ctx.provider, reasoningBytes, limitBytes: CONTINUATION_REASONING_MAX_BYTES },
      'Responses continuity over size limit; dropped'
    )
    return undefined
  }
  return {
    owner: {
      provider: ctx.provider,
      protocol: OPENAI_RESPONSES,
      model: ctx.model,
      epoch: ctx.epoch,
    },
    layout: decoded.layout,
    digest: continuationDigest(decoded.toolCalls, decoded.content),
  }
}

// ─── Protocol ───────────────────────────────────────────────

export const responsesProtocol: WireProtocol<ResponsesPayload, ResponsesResult> = {
  id: OPENAI_RESPONSES,

  encodeText(input, ctx: EncodeContext) {
    // Text completions carry role + text only, never continuity.
    const items: InputItem[] = input.messages.map(m => ({
      type: 'message' as const,
      role: m.role as 'system' | 'user' | 'assistant',
      content: m.content,
    }))
    return {
      model: ctx.model,
      input: items,
      ...tokenLimit(input.max_tokens),
      ...temperatureField(input.temperature, ctx.params),
      ...stateless(),
    }
  },

  encodeTools(input, ctx: EncodeContext) {
    // Responses defaults `strict` to true, under which the model fills every
    // optional parameter of a non-strict MCP schema: it silently changes calls.
    const tools =
      input.tools.length > 0
        ? input.tools.map(t => ({
            type: 'function' as const,
            name: t.name,
            description: t.description,
            parameters: t.parameters,
            strict: false,
          }))
        : undefined
    return {
      model: ctx.model,
      input: convertMessages(input.messages, ctx),
      tools,
      tool_choice: tools
        ? ((input.tool_choice ?? 'auto') as OpenAI.Responses.ToolChoiceOptions)
        : undefined,
      ...tokenLimit(input.max_tokens),
      ...temperatureField(input.temperature, ctx.params),
      ...stateless(),
    }
  },

  decodeText(raw, ctx): CompletionResponse {
    assertDecodable(raw, ctx)
    const decoded = decodeOutput(raw)
    return {
      content: decoded.content ?? '',
      ...usageOf(raw),
      finish_reason: finishReason(raw, decoded.toolCalls.length > 0),
    }
  },

  decodeTools(raw, ctx): ToolCompletionResponse {
    assertDecodable(raw, ctx)
    const decoded = decodeOutput(raw)
    const continuation = continuationOf(raw, decoded, ctx)
    return {
      content: decoded.content,
      tool_calls: decoded.toolCalls.length > 0 ? decoded.toolCalls : null,
      ...usageOf(raw),
      finish_reason: finishReason(raw, decoded.toolCalls.length > 0),
      ...(continuation ? { provider_continuation: continuation } : {}),
    }
  },

  send(client, payload, signal) {
    return client.responses.create(payload, { signal })
  },
}
