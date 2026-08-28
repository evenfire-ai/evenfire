import {
  hashCodexCompletionRequestV1,
  parseCodexCompletionRequestV1,
  type CodexCompletionRequestV1,
} from '@clerum/llm-provider-attempt-contract'
import type { FinalizeAttemptSuccess, RedeemAttemptSuccess } from './controlApiClient.js'
import { logger } from './logger.js'
import {
  CODEX_CATALOG_ORIGIN,
  CODEX_COMPLETIONS_ORIGIN,
  OriginDeniedError,
  assertAllowedUpstreamUrl,
  fetchFrozenOrigin,
  type OriginPolicyOptions,
} from './originPolicy.js'
import { assertBoundedDeadline } from './requestLimits.js'
import { parseSafeUsage, type SafeUsage } from './usage.js'
import { chatgptUpstreamHeaders } from './chatgptUpstreamHeaders.js'

export type StreamFrame =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; arguments: Record<string, unknown> }

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
    message: string
  ) {
    super(message)
    this.name = 'CodexTransportError'
  }
}

export type StreamCodexCompletionInput = {
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
      schemaVersion: 'codex-attempt-receipt.v1'
      providerAttemptId: string
      requestHash: string
      outcome: 'success' | 'canceled' | 'error' | 'unknown'
      usage?: SafeUsage
    }
  }) => Promise<FinalizeAttemptSuccess>
  fetchFn: typeof fetch
  lookup?: OriginPolicyOptions['lookup']
  onFrame?: (frame: StreamFrame) => void
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
  signal?: AbortSignal
  fetchFn: typeof fetch
  lookup?: OriginPolicyOptions['lookup']
  onFrame?: (frame: StreamFrame) => void
}): Promise<StreamCodexCompletionResult> {
  const url = assertAllowedUpstreamUrl(CODEX_COMPLETIONS_ORIGIN, 'completions')
  const timeout = AbortSignal.timeout(input.deadlineMs)
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout
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
  const response = await fetchFrozenOrigin({
    url,
    fetchFn: input.fetchFn,
    lookup: input.lookup,
    init: {
      method: 'POST',
      signal,
      headers,
      body: JSON.stringify(toUpstreamPayload(input.request)),
    },
  })
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
  return consumeSse(response.body, input.onFrame, signal)
}

function toUpstreamPayload(request: CodexCompletionRequestV1): Record<string, unknown> {
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
          name: call.name,
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
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }))
    payload.parallel_tool_calls = true
  }
  if (request.generation?.maxOutputTokens !== undefined) {
    payload.max_output_tokens = request.generation.maxOutputTokens
  }
  if (request.generation?.temperature !== undefined) {
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
  onFrame: ((frame: StreamFrame) => void) | undefined,
  signal: AbortSignal
): Promise<StreamCodexCompletionResult> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const pending = new Map<string, PendingToolCall>()
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
        throw new CodexTransportError('sse_buffer_exceeded', 'upstream SSE buffer exceeded')
      }
      const parts = buffer.split('\n\n')
      buffer = parts.pop() ?? ''
      for (const part of parts) {
        const mapped = ingestSseBlock(part, pending)
        if (mapped.frame) onFrame?.(mapped.frame)
        if (mapped.usage) usage = mapped.usage
        if (mapped.completed) completed = true
        if (mapped.failed) failed = true
      }
      if (signal.aborted) break
    }
    buffer += decoder.decode().replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    if (buffer.trim()) {
      const mapped = ingestSseBlock(buffer, pending)
      if (mapped.frame) onFrame?.(mapped.frame)
      if (mapped.usage) usage = mapped.usage
      if (mapped.completed) completed = true
      if (mapped.failed) failed = true
    }
  } finally {
    reader.releaseLock()
  }
  for (const call of pending.values()) {
    if (call.emitted) continue
    const args = parseToolArguments(call.arguments)
    onFrame?.({ type: 'tool_call', id: call.id, name: call.name, arguments: args })
    call.emitted = true
  }
  if (signal.aborted) return { outcome: 'canceled', usage }
  if (failed) {
    throw new CodexTransportError('provider_unavailable', 'upstream response failed')
  }
  if (completed) return { outcome: 'success', usage }
  return { outcome: 'unknown', usage }
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
  if (type === 'response.output_item.added' && isPlainObject(row.item) && row.item.type === 'function_call') {
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
    (type === 'response.output_item.done' && isPlainObject(row.item) && row.item.type === 'function_call')
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
    current.arguments = source.append ? `${current.arguments}${rawArgs}` : rawArgs || current.arguments
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

export async function listCodexModels(input: {
  accessToken: string
  fetchFn: typeof fetch
  lookup?: OriginPolicyOptions['lookup']
}): Promise<{ outcome: 'ready' | 'auth-rejected' | 'unavailable'; models: Array<{ model: string; displayName?: string }> }> {
  const url = assertAllowedUpstreamUrl(CODEX_CATALOG_ORIGIN, 'catalog')
  const headers = chatgptUpstreamHeaders(input.accessToken, { accept: 'application/json' })
  const response = await fetchFrozenOrigin({
    url,
    fetchFn: input.fetchFn,
    lookup: input.lookup,
    init: {
      method: 'GET',
      headers,
    },
  })
  if (response.status === 401 || response.status === 403) return { outcome: 'auth-rejected', models: [] }
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
  const body = (await response.json()) as unknown
  return { outcome: 'ready', models: normalizeModels(body) }
}

export async function testCodexConnection(input: {
  accessToken: string
  fetchFn: typeof fetch
  lookup?: OriginPolicyOptions['lookup']
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
  for (const row of rows) {
    if (!isPlainObject(row)) continue
    const model = String(row.model || row.slug || row.id || '').trim()
    if (!model) continue
    const displayName = typeof row.displayName === 'string' ? row.displayName : typeof row.title === 'string' ? row.title : undefined
    models.push(displayName ? { model, displayName } : { model })
  }
  return models
}
