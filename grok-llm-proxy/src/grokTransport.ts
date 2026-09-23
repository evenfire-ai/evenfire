import {
  type GrokCompletionRequestV1,
  LIMITS,
  hashGrokCompletionRequestV1,
  parseGrokCompletionRequestV1,
} from '@clerum/grok-provider-attempt-contract'
import type { FinalizeAttemptSuccess, RedeemAttemptSuccess } from './controlApiClient.js'
import { grokUpstreamHeaders } from './grokUpstreamHeaders.js'
import { logger } from './logger.js'
import {
  GROK_CATALOG_ORIGIN,
  GROK_COMPLETIONS_ORIGIN,
  OriginDeniedError,
  type OriginPolicyOptions,
  assertAllowedUpstreamUrl,
  fetchFrozenOrigin,
} from './originPolicy.js'
import { assertBoundedDeadline } from './requestLimits.js'
import { ToolNameMap } from './toolNameMap.js'
import { type SafeUsage, parseSafeUsage } from './usage.js'

export type StreamFrame =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; arguments: Record<string, unknown> }

/**
 * Receives mapped frames. Returning a promise signals client backpressure: the
 * SSE reader stops pulling upstream bytes until it settles (or the stream
 * aborts), so a slow consumer cannot make the proxy buffer an unbounded stream.
 */
export type FrameSink = (frame: StreamFrame) => void | Promise<void>

export type TransportTicket = {
  jti: string
  hostRef: string
  model: string
  requestHash: string
  providerAttemptId: string
}

/**
 * PROBE-GATED (B-M10). The Codex `/responses` wire rejects sampling fields, and
 * no live SuperGrok probe has yet confirmed that cli-chat-proxy.grok.com
 * `/v1/responses` accepts `temperature`. Until that probe passes, keep
 * `generation.temperature` in the authorize hash (request identity) but do
 * not send it upstream. `max_output_tokens` is bound by the transport contract
 * and is still sent. Flip to true only with recorded live-probe evidence.
 */
export const GROK_UPSTREAM_TEMPERATURE_PROBE_CONFIRMED: boolean = false

/**
 * Ceiling on the combined `arguments` text retained for every pending tool call
 * of one response, in UTF-8 bytes.
 *
 * `LIMITS.maxToolCalls` bounds how many calls a response may carry, never how
 * large each one is, and the SSE buffer guard cannot cover this: it bounds the
 * unparsed tail between two `\n\n` boundaries and is reset on every iteration,
 * so a long run of `response.function_call_arguments.delta` events grows the
 * proxy's heap and the response body without any ceiling.
 *
 * Read from `LIMITS.maxRequestBodyBytes` (#731) and counted in the same unit,
 * UTF-8 bytes (R9-5). The retained text is held in memory until the response
 * ends, so raising the contract cap raises this per-stream heap ceiling with
 * it.
 */
export const MAX_TOOL_CALL_ARGUMENT_BYTES: number = LIMITS.maxRequestBodyBytes

export class GrokTransportError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Readonly<Record<string, number | string>>
  ) {
    super(message)
    this.name = 'GrokTransportError'
  }
}

export type StreamGrokCompletionInput = {
  executionTicket: string
  requestHash: string
  request: unknown
  ticket: TransportTicket
  deadlineMs?: number
  maxDeadlineMs?: number
  signal?: AbortSignal
  redeem: (input: {
    executionTicket: string
    requestHash: string
    model: string
    hostRef: string
    operation: 'completion_stream'
  }) => Promise<RedeemAttemptSuccess>
  finalize: (input: {
    attemptReceipt: string
    receipt: {
      schemaVersion: 'grok-attempt-receipt.v1'
      providerAttemptId: string
      requestHash: string
      outcome: 'success' | 'canceled' | 'error' | 'unknown'
      usage?: SafeUsage
    }
  }) => Promise<FinalizeAttemptSuccess>
  fetchFn: typeof fetch
  lookup?: OriginPolicyOptions['lookup']
  onFrame?: FrameSink
}

export type StreamGrokCompletionResult = {
  outcome: 'success' | 'canceled' | 'error' | 'unknown'
  usage?: SafeUsage
}

export async function streamGrokCompletion(
  input: StreamGrokCompletionInput
): Promise<StreamGrokCompletionResult> {
  const parsed = parseGrokCompletionRequestV1(input.request)
  if (!parsed.ok) {
    throw new GrokTransportError('invalid_request', parsed.message)
  }
  const request = parsed.value
  const digest = hashGrokCompletionRequestV1(request)
  if (digest !== input.requestHash || input.ticket.requestHash !== input.requestHash) {
    throw new GrokTransportError('request_hash_mismatch', 'request hash does not match the ticket')
  }
  if (request.model !== input.ticket.model) {
    throw new GrokTransportError('model_not_allowed', 'request model does not match the ticket')
  }
  // A client that disconnected before dispatch must not consume the ticket:
  // nothing was redeemed, so there is no attempt receipt to finalize.
  if (input.signal?.aborted) {
    return { outcome: 'canceled' }
  }
  const redeemed = await input.redeem({
    executionTicket: input.executionTicket,
    requestHash: input.requestHash,
    model: request.model,
    hostRef: input.ticket.hostRef,
    operation: 'completion_stream',
  })
  if (redeemed.transport.servedModel !== request.model) {
    await finalizeQuietly(input, redeemed, 'error')
    throw new GrokTransportError('model_not_allowed', 'served model does not match the request')
  }
  const deadlineMs = Math.min(
    assertBoundedDeadline(input.deadlineMs ?? request.deadlineMs, input.maxDeadlineMs ?? 300_000),
    redeemed.transport.maxStreamDurationMs
  )

  const accessToken = redeemed.accessToken
  let outcome: StreamGrokCompletionResult['outcome'] = 'unknown'
  let usage: SafeUsage | undefined
  const started = Date.now()
  try {
    const streamed = await readUpstreamStream({
      request,
      accessToken,
      deadlineMs,
      signal: input.signal,
      fetchFn: input.fetchFn,
      lookup: input.lookup,
      onFrame: input.onFrame,
    })
    outcome = streamed.outcome
    usage = streamed.usage
    return { outcome, usage }
  } catch (err) {
    if (input.signal?.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
      outcome = 'canceled'
      return { outcome, usage }
    }
    if (err instanceof OriginDeniedError) {
      outcome = 'error'
      throw new GrokTransportError('origin_denied', err.message)
    }
    if (err instanceof GrokTransportError) {
      outcome = 'error'
      throw err
    }
    outcome = 'error'
    throw err
  } finally {
    void accessToken
    await finalizeQuietly(input, redeemed, outcome, usage)
    logger.info(
      {
        event: 'grok_proxy_attempt_closed',
        outcome,
        durationMs: Date.now() - started,
      },
      'grok stream finalized'
    )
  }
}

async function finalizeQuietly(
  input: StreamGrokCompletionInput,
  redeemed: RedeemAttemptSuccess,
  outcome: StreamGrokCompletionResult['outcome'],
  usage?: SafeUsage
): Promise<void> {
  const payload = {
    attemptReceipt: redeemed.attemptReceipt,
    receipt: {
      schemaVersion: 'grok-attempt-receipt.v1' as const,
      providerAttemptId: input.ticket.providerAttemptId,
      requestHash: input.requestHash,
      outcome,
      ...(usage ? { usage } : {}),
    },
  }
  try {
    await input.finalize(payload)
  } catch {
    try {
      await input.finalize(payload)
    } catch (err) {
      logger.error({ event: 'grok_proxy_finalize_failed', err }, 'finalize retry exhausted')
    }
  }
}

/**
 * A short, sanitized hint from a non-success upstream response. Upstream error
 * bodies carry the reason a request was refused (for example a required client
 * identity or an entitlement message), which the status alone does not give.
 * Never logs credentials: anything token-shaped is dropped and the hint is
 * capped, so a body that echoes a header or key cannot reach the log.
 */
export async function readUpstreamErrorHint(response: {
  text: () => Promise<string>
}): Promise<string> {
  let raw: string
  try {
    raw = await response.text()
  } catch {
    return ''
  }
  const collapsed = raw.replace(/\s+/g, ' ').trim()
  if (!collapsed) return ''
  const withoutSecrets = collapsed
    .replace(
      /(?:Bearer|token|key|secret|authorization)[\s"':=]+[A-Za-z0-9._~+/-]{8,}/gi,
      '[redacted]'
    )
    .replace(/\b[A-Za-z0-9._-]{40,}\b/g, '[redacted]')
  return withoutSecrets.slice(0, 300)
}

async function readUpstreamStream(input: {
  request: GrokCompletionRequestV1
  accessToken: string
  deadlineMs: number
  signal?: AbortSignal
  fetchFn: typeof fetch
  lookup?: OriginPolicyOptions['lookup']
  onFrame?: FrameSink
}): Promise<StreamGrokCompletionResult> {
  const url = assertAllowedUpstreamUrl(GROK_COMPLETIONS_ORIGIN, 'completions')
  const timeout = AbortSignal.timeout(input.deadlineMs)
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout
  const headers = grokUpstreamHeaders(input.accessToken, {
    'content-type': 'application/json',
    accept: 'text/event-stream',
  })
  const names = new ToolNameMap([
    ...(input.request.tools ?? []).map(tool => tool.name),
    ...input.request.messages.flatMap(message =>
      message.role === 'assistant' ? (message.toolCalls ?? []).map(call => call.name) : []
    ),
  ])
  const response = await fetchFrozenOrigin({
    url,
    fetchFn: input.fetchFn,
    lookup: input.lookup,
    init: {
      method: 'POST',
      signal,
      headers,
      body: JSON.stringify(toUpstreamPayload(input.request, names)),
    },
  })
  if (!response.ok || !response.body) {
    const errorBody = await readUpstreamErrorBody(response)
    logger.warn(
      {
        event: 'grok_upstream_http',
        operation: 'completion_stream',
        status: response.status,
        upstreamHint: await readUpstreamErrorHint({ text: async () => errorBody.text }),
      },
      'Grok completions upstream returned a non-success status'
    )
    if (response.status !== 401 && errorBody.complete && isContextOverflowBody(errorBody.text)) {
      throw new GrokTransportError('context_length_exceeded', 'upstream context window exceeded')
    }
    if (response.status === 400) {
      throw new GrokTransportError('invalid_request', 'upstream rejected the Grok request')
    }
    if (response.status === 401) {
      throw new GrokTransportError(
        'connection_unavailable',
        'upstream rejected the Grok credential'
      )
    }
    if (response.status === 426) {
      // xAI's cli-chat-proxy enforces a minimum Grok CLI client version and
      // answers 426 when the caller does not present an accepted one. Retrying
      // cannot help: an operator has to ship a client identity xAI accepts.
      throw new GrokTransportError(
        'client_upgrade_required',
        'xAI requires a newer Grok client version for subscription inference; contact support to upgrade Evenfire’s Grok client'
      )
    }
    if (response.status === 402 || response.status === 403) {
      throw new GrokTransportError(
        'provider_unavailable',
        'upstream entitlement denied the Grok request'
      )
    }
    throw new GrokTransportError('provider_unavailable', 'upstream completion failed')
  }
  return consumeSse(response.body, input.onFrame, signal, names)
}

// R10 (M1): a non-success completion body is read once, up to this bound, for
// the log hint and to find a context-window refusal. The recorded refusal is
// about 200 bytes; past the bound the read is cancelled, the prefix still feeds
// the hint, and the status mapping stands.
const UPSTREAM_ERROR_BODY_MAX_BYTES = 16 * 1024

// The recorded refusal (HTTP 400 from /v1/responses, grok-4.6, 2026-09-23) has
// the generic `code: 'invalid-argument'`; this bracketed marker inside its
// `error` string is the only field that names the context window.
const CONTEXT_OVERFLOW_MARKER = '[input_too_large]'

async function readUpstreamErrorBody(
  response: Response
): Promise<{ text: string; complete: boolean }> {
  if (!response.body) return { text: '', complete: true }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let complete = true
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > UPSTREAM_ERROR_BODY_MAX_BYTES) {
        complete = false
        await reader.cancel().catch(() => undefined)
        break
      }
      chunks.push(value)
    }
  } catch {
    complete = false
    await reader.cancel().catch(() => undefined)
  }
  return { text: Buffer.concat(chunks).toString('utf8'), complete }
}

function isContextOverflowBody(text: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return false
  }
  return (
    isPlainObject(parsed) &&
    typeof parsed.error === 'string' &&
    parsed.error.includes(CONTEXT_OVERFLOW_MARKER)
  )
}

function toUpstreamPayload(
  request: GrokCompletionRequestV1,
  names: ToolNameMap
): Record<string, unknown> {
  const instructions = request.messages
    .filter(message => message.role === 'system' && message.content.trim())
    .map(message => message.content)
    .join('\n\n')
  const input: Record<string, unknown>[] = []
  for (const message of request.messages) {
    if (message.role === 'system') continue
    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.toolCallId || message.name || 'tool',
        output: message.content,
      })
      continue
    }
    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      if (message.content.trim()) {
        input.push({ role: 'assistant', content: message.content })
      }
      for (const call of message.toolCalls) {
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: names.toWire(call.name),
          arguments: JSON.stringify(call.arguments ?? {}),
        })
      }
      continue
    }
    input.push({ role: message.role, content: message.content })
  }
  const payload: Record<string, unknown> = {
    model: request.model,
    stream: true,
    store: false,
    input,
  }
  if (instructions) payload.instructions = instructions
  if (request.tools && request.tools.length > 0) {
    payload.tools = request.tools.map(tool => ({
      type: 'function',
      name: names.toWire(tool.name),
      description: tool.description,
      parameters: tool.parameters,
      // Responses-shaped Grok proxy can normalize omitted `strict` to require
      // optional MCP fields. Preserve source schema optionality explicitly.
      strict: false,
    }))
    payload.parallel_tool_calls = true
  }
  if (request.generation?.maxOutputTokens) {
    payload.max_output_tokens = request.generation.maxOutputTokens
  }
  if (GROK_UPSTREAM_TEMPERATURE_PROBE_CONFIRMED && request.generation?.temperature !== undefined) {
    payload.temperature = request.generation.temperature
  }
  if (request.generation?.toolChoice) {
    payload.tool_choice = request.generation.toolChoice
  }
  if (request.transportHints?.promptCacheKey) {
    payload.prompt_cache_key = request.transportHints.promptCacheKey
  }
  return payload
}

async function consumeSse(
  body: ReadableStream<Uint8Array>,
  onFrame: FrameSink | undefined,
  signal: AbortSignal,
  names: ToolNameMap
): Promise<StreamGrokCompletionResult> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const pending = new Map<string, PendingToolCall>()
  const argumentBudget: ToolArgumentBudget = { bytes: 0 }
  // Text stays streaming. Calls become executable only once the entire
  // response succeeds and its independent call budget has been validated.
  const toolFrames: Array<Extract<StreamFrame, { type: 'tool_call' }>> = []
  const acceptFrame = async (frame?: StreamFrame): Promise<void> => {
    if (pending.size > LIMITS.maxToolCalls) {
      throw new GrokTransportError(
        'tool_call_limit_exceeded',
        `tool calls exceed ${LIMITS.maxToolCalls}`,
        { limit: LIMITS.maxToolCalls, observed: pending.size }
      )
    }
    if (frame?.type === 'tool_call') {
      if (toolFrames.length >= LIMITS.maxToolCalls) {
        throw new GrokTransportError(
          'tool_call_limit_exceeded',
          `tool calls exceed ${LIMITS.maxToolCalls}`,
          { limit: LIMITS.maxToolCalls, observed: toolFrames.length + 1 }
        )
      }
      const canonicalName = names.fromWire(frame.name)
      if (canonicalName === undefined) {
        throw new GrokTransportError(
          'provider_unavailable',
          'upstream returned an unknown tool name'
        )
      }
      toolFrames.push({ ...frame, name: canonicalName })
    } else if (frame) await deliverFrame(onFrame, frame, signal)
  }
  let buffer = ''
  let completed = false
  let failed = false
  let usage: SafeUsage | undefined
  const maxSseBufferBytes = 1_048_576
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
      if (buffer.length > maxSseBufferBytes) {
        throw new GrokTransportError('sse_buffer_exceeded', 'upstream SSE buffer exceeded')
      }
      const parts = buffer.split('\n\n')
      buffer = parts.pop() ?? ''
      for (const part of parts) {
        const mapped = ingestSseBlock(part, pending, argumentBudget)
        await acceptFrame(mapped.frame)
        if (mapped.usage) usage = mapped.usage
        if (mapped.completed) completed = true
        if (mapped.failed) failed = true
      }
      if (signal.aborted) break
    }
    buffer += decoder.decode().replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    if (buffer.trim()) {
      const mapped = ingestSseBlock(buffer, pending, argumentBudget)
      await acceptFrame(mapped.frame)
      if (mapped.usage) usage = mapped.usage
      if (mapped.completed) completed = true
      if (mapped.failed) failed = true
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
  // A canceled or failed stream leaves its open call truncated; report the
  // stream's outcome before the flush can refuse those arguments.
  if (signal.aborted) return { outcome: 'canceled', usage }
  if (failed) {
    throw new GrokTransportError('provider_unavailable', 'upstream response failed')
  }
  for (const call of pending.values()) {
    if (call.emitted) continue
    const args = parseToolArguments(call.arguments, { closed: false })
    await acceptFrame({ type: 'tool_call', id: call.id, name: call.name, arguments: args })
    call.emitted = true
  }
  if (completed) {
    for (const frame of toolFrames) await deliverFrame(onFrame, frame, signal)
    return { outcome: 'success', usage }
  }
  return { outcome: 'unknown', usage }
}

async function deliverFrame(
  onFrame: FrameSink | undefined,
  frame: StreamFrame,
  signal: AbortSignal
): Promise<void> {
  const pending: unknown = onFrame?.(frame)
  // Only a thenable signals backpressure; a `void` callback may return anything.
  if (!(pending instanceof Promise) || signal.aborted) return
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => resolve()
    signal.addEventListener('abort', onAbort, { once: true })
    pending.then(
      () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      },
      err => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      }
    )
  })
}

function ingestSseBlock(
  part: string,
  pending: Map<string, PendingToolCall>,
  budget: ToolArgumentBudget
): ReturnType<typeof mapUpstreamEvent> {
  const dataLine = part
    .split('\n')
    .map(line => line.trim())
    .find(line => line.startsWith('data:'))
  if (!dataLine) return {}
  const payload = dataLine.slice(5).trim()
  if (!payload || payload === '[DONE]') return {}
  let event: unknown
  try {
    event = JSON.parse(payload)
  } catch {
    // An unparseable frame is upstream noise and the stream continues. Only
    // `JSON.parse` may be swallowed here: mapping the event can refuse the
    // response over its argument budget, and that refusal has to reach
    // `consumeSse` instead of being read as an empty frame.
    return {}
  }
  return mapUpstreamEvent(event, pending, budget)
}

type PendingToolCall = {
  id: string
  name: string
  arguments: string
  /** UTF-8 bytes of `arguments`, kept so a delta costs only its own length. */
  argumentBytes: number
  emitted: boolean
}

/** Running total, in UTF-8 bytes, of the `arguments` text retained across `pending`. */
type ToolArgumentBudget = { bytes: number }

function mapUpstreamEvent(
  event: unknown,
  pending: Map<string, PendingToolCall>,
  budget: ToolArgumentBudget
): {
  frame?: StreamFrame
  usage?: SafeUsage
  completed?: boolean
  failed?: boolean
} {
  if (!event || typeof event !== 'object') return {}
  const row = event as Record<string, unknown>
  const type = String(row.type || '')
  if (type === 'response.output_text.delta' && typeof row.delta === 'string') {
    return { frame: { type: 'text', text: row.delta } }
  }
  if (
    type === 'response.output_item.added' &&
    isPlainObject(row.item) &&
    row.item.type === 'function_call'
  ) {
    const call = upsertPendingTool(pending, row.item, budget)
    if (isCompleteJson(call.arguments)) return { frame: emitToolCall(call, { closed: false }) }
    return {}
  }
  if (type === 'response.function_call_arguments.delta') {
    upsertPendingTool(
      pending,
      {
        id: row.item_id,
        item_id: row.item_id,
        arguments: typeof row.delta === 'string' ? row.delta : '',
        append: true,
      },
      budget
    )
    return {}
  }
  if (
    type === 'response.function_call_arguments.done' ||
    (type === 'response.output_item.done' &&
      isPlainObject(row.item) &&
      row.item.type === 'function_call')
  ) {
    const source = isPlainObject(row.item) ? row.item : row
    const call = upsertPendingTool(pending, source, budget)
    if (call && !call.emitted) return { frame: emitToolCall(call, { closed: true }) }
    return {}
  }
  if (type === 'response.completed') {
    const response = isPlainObject(row.response) ? row.response : row
    return { completed: true, usage: parseSafeUsage(response.usage) }
  }
  if (type === 'response.failed' || type === 'response.incomplete' || type === 'error') {
    return { failed: true }
  }
  return {}
}

function upsertPendingTool(
  pending: Map<string, PendingToolCall>,
  source: Record<string, unknown> & { append?: boolean },
  budget: ToolArgumentBudget
): PendingToolCall {
  const key = String(source.item_id || source.id || source.call_id || 'tool')
  const current =
    pending.get(key) ??
    ({
      id: String(source.call_id || source.id || key),
      name: 'tool',
      arguments: '',
      argumentBytes: 0,
      emitted: false,
    } satisfies PendingToolCall)
  if (typeof source.call_id === 'string' && source.call_id.trim()) current.id = source.call_id
  if (typeof source.name === 'string' && source.name.trim()) current.name = source.name
  const rawArgs = source.arguments
  const retainedBefore = current.argumentBytes
  if (typeof rawArgs === 'string') {
    // A closing event with empty or whitespace-only arguments carries nothing
    // new; it must not replace the buffer the deltas built, truncated or not.
    if (source.append) {
      current.arguments = `${current.arguments}${rawArgs}`
      current.argumentBytes += Buffer.byteLength(rawArgs, 'utf8')
    } else if (rawArgs.trim()) {
      current.arguments = rawArgs
      current.argumentBytes = Buffer.byteLength(rawArgs, 'utf8')
    }
  } else if (isPlainObject(rawArgs) && !source.append) {
    current.arguments = JSON.stringify(rawArgs)
    current.argumentBytes = Buffer.byteLength(current.arguments, 'utf8')
  }
  budget.bytes += current.argumentBytes - retainedBefore
  if (budget.bytes > MAX_TOOL_CALL_ARGUMENT_BYTES) {
    throw new GrokTransportError(
      'tool_call_arguments_exceeded',
      `tool call arguments exceed ${MAX_TOOL_CALL_ARGUMENT_BYTES} bytes`,
      { limit: MAX_TOOL_CALL_ARGUMENT_BYTES, observed: budget.bytes }
    )
  }
  pending.set(key, current)
  return current
}

// `closed` is true only when the upstream closed the item with
// `response.output_item.done` or `response.function_call_arguments.done`.
function emitToolCall(call: PendingToolCall, options: { closed: boolean }): StreamFrame {
  call.emitted = true
  return {
    type: 'tool_call',
    id: call.id,
    name: call.name,
    arguments: parseToolArguments(call.arguments, options),
  }
}

function isCompleteJson(raw: string): boolean {
  const trimmed = raw.trim()
  if (!trimmed) return false
  try {
    JSON.parse(trimmed)
    return true
  } catch {
    return false
  }
}

// A call runs with exactly the arguments the model produced. Arguments that are
// not a JSON object (truncated or a non-object value) refuse the whole response
// instead of executing the tool with `{}`. Empty or whitespace-only arguments
// on a call the upstream closed are a call without parameters, read as `{}`;
// the Host still validates `{}` against the tool's schema. Empty arguments on
// a call that was never closed are refused, because nothing says the call was
// complete.
function parseToolArguments(raw: string, options: { closed: boolean }): Record<string, unknown> {
  if (options.closed && raw.trim() === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new GrokTransportError(
      'invalid_tool_arguments',
      'upstream tool call arguments are not valid JSON'
    )
  }
  if (!isPlainObject(parsed)) {
    throw new GrokTransportError(
      'invalid_tool_arguments',
      'upstream tool call arguments are not a JSON object'
    )
  }
  return parsed
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Array.isArray(value) === false
}

/**
 * Bounds for the admin catalog/test upstream call: a hard deadline covering
 * headers and body, a streamed body cap, and normalized-model caps aligned
 * with control-api's catalog sync limits.
 */
export const CATALOG_LIMITS = {
  timeoutMs: 15_000,
  maxBodyBytes: 1_048_576,
  maxModels: 256,
  maxModelIdLength: 128,
  // A longer display name is omitted, never truncated: a stored name is
  // always one the upstream sent.
  maxDisplayNameLength: 256,
  // control-api stores the window in a Postgres INTEGER column; a larger value
  // would fail the whole catalog sync, so it is omitted here instead.
  maxContextWindowTokens: 2_147_483_647,
} as const

type CatalogModel = { model: string; displayName?: string; contextWindowTokens?: number }

/**
 * The row's display name by precedence: the camelCase and `title` spellings
 * first, then the `name` the Grok catalog row carries.
 */
function displayNameOf(row: Record<string, unknown>): string | undefined {
  for (const value of [row.displayName, row.title, row.name]) {
    if (typeof value === 'string') return value
  }
  return undefined
}

/**
 * The upstream row's `context_window`, when it is a positive integer the
 * catalog store can hold. Unverified against the live catalog: the field
 * name and the envelope are taken from the shape of the Grok CLI's model cache.
 */
function contextWindowOf(row: Record<string, unknown>): number | undefined {
  const value = row.context_window
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= CATALOG_LIMITS.maxContextWindowTokens
    ? value
    : undefined
}

export async function listGrokModels(input: {
  accessToken: string
  fetchFn: typeof fetch
  lookup?: OriginPolicyOptions['lookup']
  /** Test seam; production uses CATALOG_LIMITS.timeoutMs. */
  timeoutMs?: number
}): Promise<{
  outcome: 'ready' | 'auth-rejected' | 'unavailable'
  models: CatalogModel[]
}> {
  const url = assertAllowedUpstreamUrl(GROK_CATALOG_ORIGIN, 'catalog')
  const headers = grokUpstreamHeaders(input.accessToken, { accept: 'application/json' })
  const signal = AbortSignal.timeout(input.timeoutMs ?? CATALOG_LIMITS.timeoutMs)
  let response: Response
  try {
    response = await fetchFrozenOrigin({
      url,
      fetchFn: input.fetchFn,
      lookup: input.lookup,
      init: {
        method: 'GET',
        headers,
        signal,
      },
    })
  } catch (err) {
    if (signal.aborted) throw catalogTimeoutError()
    throw err
  }
  if (response.status === 401) return { outcome: 'auth-rejected', models: [] }
  if (!response.ok) {
    logger.warn(
      { event: 'grok_catalog_upstream', status: response.status },
      'Grok catalog upstream returned a non-success status'
    )
    return { outcome: 'unavailable', models: [] }
  }
  const raw = await readBoundedCatalogBody(response, signal)
  const body = JSON.parse(raw) as unknown
  return { outcome: 'ready', models: normalizeModels(body) }
}

export async function testGrokConnection(input: {
  accessToken: string
  fetchFn: typeof fetch
  lookup?: OriginPolicyOptions['lookup']
  timeoutMs?: number
}): Promise<{ outcome: 'ready' | 'auth-rejected' | 'unavailable' }> {
  const listed = await listGrokModels(input)
  return { outcome: listed.outcome }
}

function normalizeModels(body: unknown): CatalogModel[] {
  const rows = Array.isArray(body)
    ? body
    : isPlainObject(body) && Array.isArray(body.models)
      ? body.models
      : isPlainObject(body) && Array.isArray(body.data)
        ? body.data
        : []
  const models: CatalogModel[] = []
  let droppedOverlongIds = 0
  let droppedOverLimit = 0
  let omittedOverlongDisplayNames = 0
  for (const row of rows) {
    if (!isPlainObject(row)) continue
    const model = String(row.model || row.slug || row.id || '').trim()
    if (!model) continue
    if (model.length > CATALOG_LIMITS.maxModelIdLength) {
      droppedOverlongIds += 1
      continue
    }
    if (models.length >= CATALOG_LIMITS.maxModels) {
      droppedOverLimit += 1
      continue
    }
    let displayName = displayNameOf(row)
    if (displayName !== undefined && displayName.length > CATALOG_LIMITS.maxDisplayNameLength) {
      omittedOverlongDisplayNames += 1
      displayName = undefined
    }
    const contextWindowTokens = contextWindowOf(row)
    models.push({
      model,
      ...(displayName ? { displayName } : {}),
      ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
    })
  }
  if (droppedOverlongIds > 0 || droppedOverLimit > 0 || omittedOverlongDisplayNames > 0) {
    logger.warn(
      {
        event: 'grok_catalog_bounded',
        received: rows.length,
        accepted: models.length,
        droppedOverlongIds,
        droppedOverLimit,
        omittedOverlongDisplayNames,
      },
      'Grok catalog response exceeded proxy bounds'
    )
  }
  return models
}

function catalogTimeoutError(): GrokTransportError {
  return new GrokTransportError('provider_unavailable', 'catalog upstream deadline exceeded')
}

/** Read the catalog body under the deadline, cancelling past the byte cap. */
async function readBoundedCatalogBody(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(catalogTimeoutError())
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
  aborted.catch(() => undefined)
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted])
      if (done) break
      total += value.byteLength
      if (total > CATALOG_LIMITS.maxBodyBytes) {
        throw new GrokTransportError('provider_unavailable', 'catalog upstream body exceeds limit')
      }
      chunks.push(value)
    }
  } catch (err) {
    await reader.cancel().catch(() => undefined)
    if (err instanceof GrokTransportError) throw err
    if (signal.aborted) throw catalogTimeoutError()
    throw err
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
    try {
      reader.releaseLock()
    } catch {
      // A pending read may still hold the lock after cancel; nothing to release.
    }
  }
  return Buffer.concat(chunks).toString('utf8')
}
