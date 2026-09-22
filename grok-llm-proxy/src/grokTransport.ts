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
import { assertBoundedDeadline, assertBoundedIdleTimeout } from './requestLimits.js'
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
 * of one response, in UTF-16 code units.
 *
 * `LIMITS.maxToolCalls` bounds how many calls a response may carry, never how
 * large each one is, and the SSE buffer guard cannot cover this: it bounds the
 * unparsed tail between two `\n\n` boundaries and is reset on every iteration,
 * so a long run of `response.function_call_arguments.delta` events grows the
 * proxy's heap and the response body without any ceiling.
 *
 * Interim value, matched to `LIMITS.maxRequestBodyBytes` so a response cannot
 * be larger than a request the Host is allowed to send back. Issue #731 owns
 * the end-to-end size budget and will replace this constant with the value the
 * contract derives; keep the two in sync until then.
 */
export const MAX_TOOL_CALL_ARGUMENT_CHARS = 1_048_576

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

/**
 * The proxy cut the upstream stream on one of its two bounds. The wire code
 * stays that of GrokTransportError (`provider_unavailable` for idle silence,
 * `stream_duration_exceeded` for the total cap); `kind` only labels the metric.
 */
export class UpstreamTimeoutError extends GrokTransportError {
  constructor(
    readonly kind: 'idle' | 'total',
    code: string,
    message: string,
    details: Readonly<Record<string, number | string>>
  ) {
    super(code, message, details)
    this.name = 'UpstreamTimeoutError'
  }
}

export type StreamGrokCompletionInput = {
  executionTicket: string
  requestHash: string
  request: unknown
  ticket: TransportTicket
  deadlineMs?: number
  maxDeadlineMs?: number
  /** Lowers `STREAM_LIMITS.upstreamIdleTimeoutMs`; never raises it. */
  upstreamIdleTimeoutMs?: number
  signal?: AbortSignal
  redeem: (input: {
    executionTicket: string
    requestHash: string
    model: string
    hostRef: string
    operation: 'completion_stream'
  }) => Promise<RedeemAttemptSuccess>
  /**
   * Called once, after the redeem succeeded and its served model and deadline
   * were accepted, and before the upstream fetch. The server starts its SSE
   * heartbeat here, so a denied redeem still answers with an HTTP status.
   */
  onRedeemed?: () => void
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
  const idleTimeoutMs = assertBoundedIdleTimeout(input.upstreamIdleTimeoutMs)
  input.onRedeemed?.()

  const accessToken = redeemed.accessToken
  let outcome: StreamGrokCompletionResult['outcome'] = 'unknown'
  let usage: SafeUsage | undefined
  const started = Date.now()
  try {
    const streamed = await readUpstreamStream({
      request,
      accessToken,
      deadlineMs,
      idleTimeoutMs,
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
  idleTimeoutMs: number
  signal?: AbortSignal
  fetchFn: typeof fetch
  lookup?: OriginPolicyOptions['lookup']
  onFrame?: FrameSink
}): Promise<StreamGrokCompletionResult> {
  const deadline = new UpstreamDeadline(input.deadlineMs, input.idleTimeoutMs)
  try {
    return await dispatchUpstreamStream(input, deadline)
  } finally {
    deadline.clear()
  }
}

/**
 * Two upstream bounds, each aborting with its own typed reason. The total
 * bound runs from dispatch to the end of the stream. The idle bound runs only
 * while the proxy waits on the upstream (response headers or the next chunk),
 * so a client that is slow to drain frames never counts as upstream silence.
 */
class UpstreamDeadline {
  private readonly controller = new AbortController()
  private readonly started = Date.now()
  private readonly total: ReturnType<typeof setTimeout>
  private idle: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly totalMs: number,
    private readonly idleMs: number
  ) {
    this.total = setTimeout(() => {
      this.controller.abort(
        new UpstreamTimeoutError(
          'total',
          'stream_duration_exceeded',
          'upstream stream exceeded maxStreamDurationMs',
          { limitMs: this.totalMs, elapsedMs: Date.now() - this.started }
        )
      )
    }, totalMs)
  }

  get signal(): AbortSignal {
    return this.controller.signal
  }

  /**
   * Wait on one upstream operation under the idle timeout. The wait also ends
   * as soon as `signal` aborts, rejecting with its reason, because the
   * operation itself may not observe the signal (a stalled body read).
   */
  async waitUpstream<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted()
    this.idle = setTimeout(() => {
      this.controller.abort(
        new UpstreamTimeoutError('idle', 'provider_unavailable', 'upstream stream idle timeout', {
          idleTimeoutMs: this.idleMs,
          elapsedMs: Date.now() - this.started,
        })
      )
    }, this.idleMs)
    let onAbort: (() => void) | undefined
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      return await Promise.race([operation, aborted])
    } finally {
      clearTimeout(this.idle)
      this.idle = undefined
      if (onAbort) signal.removeEventListener('abort', onAbort)
    }
  }

  clear(): void {
    clearTimeout(this.total)
    if (this.idle !== undefined) clearTimeout(this.idle)
  }
}

async function dispatchUpstreamStream(
  input: Parameters<typeof readUpstreamStream>[0],
  deadline: UpstreamDeadline
): Promise<StreamGrokCompletionResult> {
  const url = assertAllowedUpstreamUrl(GROK_COMPLETIONS_ORIGIN, 'completions')
  const signal = input.signal ? AbortSignal.any([input.signal, deadline.signal]) : deadline.signal
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
  const response = await deadline.waitUpstream(
    fetchFrozenOrigin({
      url,
      fetchFn: input.fetchFn,
      lookup: input.lookup,
      init: {
        method: 'POST',
        signal,
        headers,
        body: JSON.stringify(toUpstreamPayload(input.request, names)),
      },
    }),
    signal
  )
  if (!response.ok || !response.body) {
    logger.warn(
      {
        event: 'grok_upstream_http',
        operation: 'completion_stream',
        status: response.status,
        upstreamHint: await readUpstreamErrorHint(response),
      },
      'Grok completions upstream returned a non-success status'
    )
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
  return consumeSse(response.body, input.onFrame, signal, names, deadline)
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
  names: ToolNameMap,
  deadline: UpstreamDeadline
): Promise<StreamGrokCompletionResult> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const pending = new Map<string, PendingToolCall>()
  const argumentBudget: ToolArgumentBudget = { chars: 0 }
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
    // An abort ends the read with the signal's reason: the caller's own abort
    // becomes `canceled`, a deadline abort surfaces as its typed error.
    for (;;) {
      const { done, value } = await deadline.waitUpstream(reader.read(), signal)
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
      signal.throwIfAborted()
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
    try {
      reader.releaseLock()
    } catch {
      // A read that lost the race to an abort may still hold the lock after cancel.
    }
  }
  for (const call of pending.values()) {
    if (call.emitted) continue
    const args = parseToolArguments(call.arguments)
    await acceptFrame({ type: 'tool_call', id: call.id, name: call.name, arguments: args })
    call.emitted = true
  }
  signal.throwIfAborted()
  if (failed) {
    throw new GrokTransportError('provider_unavailable', 'upstream response failed')
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
  emitted: boolean
}

/** Running total of the `arguments` text retained across `pending`. */
type ToolArgumentBudget = { chars: number }

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
    if (isCompleteJson(call.arguments)) return { frame: emitToolCall(call) }
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
    if (call && !call.emitted) return { frame: emitToolCall(call) }
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
      emitted: false,
    } satisfies PendingToolCall)
  if (typeof source.call_id === 'string' && source.call_id.trim()) current.id = source.call_id
  if (typeof source.name === 'string' && source.name.trim()) current.name = source.name
  const rawArgs = source.arguments
  const retainedBefore = current.arguments.length
  if (typeof rawArgs === 'string') {
    current.arguments = source.append
      ? `${current.arguments}${rawArgs}`
      : rawArgs || current.arguments
  } else if (isPlainObject(rawArgs) && !source.append) {
    current.arguments = JSON.stringify(rawArgs)
  }
  budget.chars += current.arguments.length - retainedBefore
  if (budget.chars > MAX_TOOL_CALL_ARGUMENT_CHARS) {
    throw new GrokTransportError(
      'tool_call_arguments_exceeded',
      `tool call arguments exceed ${MAX_TOOL_CALL_ARGUMENT_CHARS} characters`,
      { limit: MAX_TOOL_CALL_ARGUMENT_CHARS, observed: budget.chars }
    )
  }
  pending.set(key, current)
  return current
}

function emitToolCall(call: PendingToolCall): StreamFrame {
  call.emitted = true
  return {
    type: 'tool_call',
    id: call.id,
    name: call.name,
    arguments: parseToolArguments(call.arguments),
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

function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (isPlainObject(raw)) return raw
  if (typeof raw !== 'string' || raw.length === 0) return {}
  try {
    const parsed = JSON.parse(raw)
    return isPlainObject(parsed) ? parsed : {}
  } catch {
    return {}
  }
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
} as const

export async function listGrokModels(input: {
  accessToken: string
  fetchFn: typeof fetch
  lookup?: OriginPolicyOptions['lookup']
  /** Test seam; production uses CATALOG_LIMITS.timeoutMs. */
  timeoutMs?: number
}): Promise<{
  outcome: 'ready' | 'auth-rejected' | 'unavailable'
  models: Array<{ model: string; displayName?: string }>
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

function normalizeModels(body: unknown): Array<{ model: string; displayName?: string }> {
  const rows = Array.isArray(body)
    ? body
    : isPlainObject(body) && Array.isArray(body.models)
      ? body.models
      : isPlainObject(body) && Array.isArray(body.data)
        ? body.data
        : []
  const models: Array<{ model: string; displayName?: string }> = []
  let droppedOverlongIds = 0
  let droppedOverLimit = 0
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
    const displayName =
      typeof row.displayName === 'string'
        ? row.displayName
        : typeof row.title === 'string'
          ? row.title
          : undefined
    models.push(displayName ? { model, displayName } : { model })
  }
  if (droppedOverlongIds > 0 || droppedOverLimit > 0) {
    logger.warn(
      {
        event: 'grok_catalog_bounded',
        received: rows.length,
        accepted: models.length,
        droppedOverlongIds,
        droppedOverLimit,
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
