import {
  type CodexCompletionRequestV1,
  LIMITS,
  hashCodexCompletionRequestV1,
  parseCodexCompletionRequestV1,
} from '@clerum/llm-provider-attempt-contract'
import { chatgptUpstreamHeaders } from './chatgptUpstreamHeaders.js'
import type { FinalizeAttemptSuccess, RedeemAttemptSuccess } from './controlApiClient.js'
import { logger } from './logger.js'
import {
  CODEX_CATALOG_ORIGIN,
  CODEX_COMPLETIONS_ORIGIN,
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

export class CodexTransportError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Readonly<Record<string, number | string>>
  ) {
    super(message)
    this.name = 'CodexTransportError'
  }
}

/**
 * The proxy cut the upstream stream on one of its two bounds. The wire code
 * stays that of CodexTransportError (`provider_unavailable` for idle silence,
 * `stream_duration_exceeded` for the total cap); `kind` only labels the metric.
 */
export class UpstreamTimeoutError extends CodexTransportError {
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

export type StreamCodexCompletionInput = {
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
      schemaVersion: 'codex-attempt-receipt.v1'
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

export type StreamCodexCompletionResult = {
  outcome: 'success' | 'canceled' | 'error' | 'unknown'
  usage?: SafeUsage
}

export async function streamCodexCompletion(
  input: StreamCodexCompletionInput
): Promise<StreamCodexCompletionResult> {
  const parsed = parseCodexCompletionRequestV1(input.request)
  if (!parsed.ok) {
    throw new CodexTransportError('invalid_request', parsed.message)
  }
  const request = parsed.value
  const digest = hashCodexCompletionRequestV1(request)
  if (digest !== input.requestHash || input.ticket.requestHash !== input.requestHash) {
    throw new CodexTransportError('request_hash_mismatch', 'request hash does not match the ticket')
  }
  if (request.model !== input.ticket.model) {
    throw new CodexTransportError('model_not_allowed', 'request model does not match the ticket')
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
    throw new CodexTransportError('model_not_allowed', 'served model does not match the request')
  }
  const deadlineMs = Math.min(
    assertBoundedDeadline(input.deadlineMs ?? request.deadlineMs, input.maxDeadlineMs ?? 300_000),
    redeemed.transport.maxStreamDurationMs
  )
  const idleTimeoutMs = assertBoundedIdleTimeout(input.upstreamIdleTimeoutMs)
  input.onRedeemed?.()

  const accessToken = redeemed.accessToken
  let outcome: StreamCodexCompletionResult['outcome'] = 'unknown'
  let usage: SafeUsage | undefined
  const started = Date.now()
  try {
    const streamed = await readUpstreamStream({
      request,
      accessToken,
      chatgptAccountId: redeemed.chatgptAccountId,
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
      throw new CodexTransportError('origin_denied', err.message)
    }
    if (err instanceof CodexTransportError) {
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
        event: 'codex_proxy_attempt_closed',
        outcome,
        durationMs: Date.now() - started,
      },
      'codex stream finalized'
    )
  }
}

async function finalizeQuietly(
  input: StreamCodexCompletionInput,
  redeemed: RedeemAttemptSuccess,
  outcome: StreamCodexCompletionResult['outcome'],
  usage?: SafeUsage
): Promise<void> {
  const payload = {
    attemptReceipt: redeemed.attemptReceipt,
    receipt: {
      schemaVersion: 'codex-attempt-receipt.v1' as const,
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
      logger.error({ event: 'codex_proxy_finalize_failed', err }, 'finalize retry exhausted')
    }
  }
}

async function readUpstreamStream(input: {
  request: CodexCompletionRequestV1
  accessToken: string
  chatgptAccountId?: string
  deadlineMs: number
  idleTimeoutMs: number
  signal?: AbortSignal
  fetchFn: typeof fetch
  lookup?: OriginPolicyOptions['lookup']
  onFrame?: FrameSink
}): Promise<StreamCodexCompletionResult> {
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
): Promise<StreamCodexCompletionResult> {
  const url = assertAllowedUpstreamUrl(CODEX_COMPLETIONS_ORIGIN, 'completions')
  const signal = input.signal ? AbortSignal.any([input.signal, deadline.signal]) : deadline.signal
  const headers = chatgptUpstreamHeaders(input.accessToken, {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    session_id: input.request.requestId,
    ...(input.chatgptAccountId ? { 'chatgpt-account-id': input.chatgptAccountId } : {}),
  })
  if (!headers['chatgpt-account-id']) {
    throw new CodexTransportError(
      'connection_unavailable',
      'Codex access token is missing ChatGPT account id'
    )
  }
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
        event: 'codex_upstream_http',
        operation: 'completion_stream',
        status: response.status,
        accountHeader: Boolean(headers['chatgpt-account-id']),
      },
      'Codex completions upstream returned a non-success status'
    )
    if (response.status === 400) {
      throw new CodexTransportError('invalid_request', 'upstream rejected the Codex request')
    }
    if (response.status === 401 || response.status === 403) {
      throw new CodexTransportError(
        'connection_unavailable',
        'upstream rejected the Codex credential'
      )
    }
    throw new CodexTransportError('provider_unavailable', 'upstream completion failed')
  }
  return consumeSse(response.body, input.onFrame, signal, names, deadline)
}

function toUpstreamPayload(
  request: CodexCompletionRequestV1,
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
      // Codex can normalize omission to strict mode and require optional MCP
      // fields. Preserve the source schema's optionality explicitly.
      strict: false,
    }))
    payload.parallel_tool_calls = true
  }
  // ChatGPT `/codex/responses` rejects sampling fields that Chat Completions
  // treats as portable. Keep them on CodexCompletionRequestV1 (authorize hash)
  // and omit them on the upstream wire. The CLI Codex client also omits
  // max_output_tokens / temperature. The authorize hash still carries
  // generation.maxOutputTokens as request identity; this wire cannot enforce
  // that cap. Do not restore the fields here.
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
): Promise<StreamCodexCompletionResult> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const pending = new Map<string, PendingToolCall>()
  // Text stays streaming. Calls become executable only once the entire
  // response succeeds and its independent call budget has been validated.
  const toolFrames: Array<Extract<StreamFrame, { type: 'tool_call' }>> = []
  const acceptFrame = async (frame?: StreamFrame): Promise<void> => {
    if (pending.size > LIMITS.maxToolCalls) {
      throw new CodexTransportError(
        'tool_call_limit_exceeded',
        `tool calls exceed ${LIMITS.maxToolCalls}`,
        { limit: LIMITS.maxToolCalls, observed: pending.size }
      )
    }
    if (frame?.type === 'tool_call') {
      if (toolFrames.length >= LIMITS.maxToolCalls) {
        throw new CodexTransportError(
          'tool_call_limit_exceeded',
          `tool calls exceed ${LIMITS.maxToolCalls}`,
          { limit: LIMITS.maxToolCalls, observed: toolFrames.length + 1 }
        )
      }
      const canonicalName = names.fromWire(frame.name)
      if (canonicalName === undefined) {
        throw new CodexTransportError(
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
        throw new CodexTransportError('sse_buffer_exceeded', 'upstream SSE buffer exceeded')
      }
      const parts = buffer.split('\n\n')
      buffer = parts.pop() ?? ''
      for (const part of parts) {
        const mapped = ingestSseBlock(part, pending)
        await acceptFrame(mapped.frame)
        if (mapped.usage) usage = mapped.usage
        if (mapped.completed) completed = true
        if (mapped.failed) failed = true
      }
      signal.throwIfAborted()
    }
    buffer += decoder.decode().replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    if (buffer.trim()) {
      const mapped = ingestSseBlock(buffer, pending)
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
    throw new CodexTransportError('provider_unavailable', 'upstream response failed')
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
  pending: Map<string, PendingToolCall>
): ReturnType<typeof mapUpstreamEvent> {
  const dataLine = part
    .split('\n')
    .map(line => line.trim())
    .find(line => line.startsWith('data:'))
  if (!dataLine) return {}
  const payload = dataLine.slice(5).trim()
  if (!payload || payload === '[DONE]') return {}
  try {
    return mapUpstreamEvent(JSON.parse(payload), pending)
  } catch {
    return {}
  }
}

type PendingToolCall = {
  id: string
  name: string
  arguments: string
  emitted: boolean
}

function mapUpstreamEvent(
  event: unknown,
  pending: Map<string, PendingToolCall>
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
    const call = upsertPendingTool(pending, row.item)
    if (isCompleteJson(call.arguments)) return { frame: emitToolCall(call) }
    return {}
  }
  if (type === 'response.function_call_arguments.delta') {
    upsertPendingTool(pending, {
      id: row.item_id,
      item_id: row.item_id,
      arguments: typeof row.delta === 'string' ? row.delta : '',
      append: true,
    })
    return {}
  }
  if (
    type === 'response.function_call_arguments.done' ||
    (type === 'response.output_item.done' &&
      isPlainObject(row.item) &&
      row.item.type === 'function_call')
  ) {
    const source = isPlainObject(row.item) ? row.item : row
    const call = upsertPendingTool(pending, source)
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
  source: Record<string, unknown> & { append?: boolean }
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
  if (typeof rawArgs === 'string') {
    current.arguments = source.append
      ? `${current.arguments}${rawArgs}`
      : rawArgs || current.arguments
  } else if (isPlainObject(rawArgs) && !source.append) {
    current.arguments = JSON.stringify(rawArgs)
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
  // Live ChatGPT catalog rows can carry per-model instruction payloads and the
  // production size is unmeasured; keep generous headroom over the Grok cap.
  maxBodyBytes: 8 * 1_048_576,
  maxModels: 256,
  maxModelIdLength: 128,
} as const

export async function listCodexModels(input: {
  accessToken: string
  fetchFn: typeof fetch
  lookup?: OriginPolicyOptions['lookup']
  /** Test seam; production uses CATALOG_LIMITS.timeoutMs. */
  timeoutMs?: number
}): Promise<{
  outcome: 'ready' | 'auth-rejected' | 'unavailable'
  models: Array<{ model: string; displayName?: string }>
}> {
  const url = assertAllowedUpstreamUrl(CODEX_CATALOG_ORIGIN, 'catalog')
  const headers = chatgptUpstreamHeaders(input.accessToken, { accept: 'application/json' })
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
  if (response.status === 401 || response.status === 403)
    return { outcome: 'auth-rejected', models: [] }
  if (!response.ok) {
    logger.warn(
      {
        event: 'codex_catalog_upstream',
        status: response.status,
        accountHeader: Boolean(headers['chatgpt-account-id']),
      },
      'Codex catalog upstream returned a non-success status'
    )
    return { outcome: 'unavailable', models: [] }
  }
  const raw = await readBoundedCatalogBody(response, signal)
  const body = JSON.parse(raw) as unknown
  return { outcome: 'ready', models: normalizeModels(body) }
}

export async function testCodexConnection(input: {
  accessToken: string
  fetchFn: typeof fetch
  lookup?: OriginPolicyOptions['lookup']
  timeoutMs?: number
}): Promise<{ outcome: 'ready' | 'auth-rejected' | 'unavailable' }> {
  const listed = await listCodexModels(input)
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
        event: 'codex_catalog_bounded',
        received: rows.length,
        accepted: models.length,
        droppedOverlongIds,
        droppedOverLimit,
      },
      'Codex catalog response exceeded proxy bounds'
    )
  }
  return models
}

function catalogTimeoutError(): CodexTransportError {
  return new CodexTransportError('provider_unavailable', 'catalog upstream deadline exceeded')
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
        throw new CodexTransportError('provider_unavailable', 'catalog upstream body exceeds limit')
      }
      chunks.push(value)
    }
  } catch (err) {
    await reader.cancel().catch(() => undefined)
    if (err instanceof CodexTransportError) throw err
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
