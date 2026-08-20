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
  assertRedirectLocation,
  assertResolvedUpstream,
  type OriginPolicyOptions,
} from './originPolicy.js'
import { assertBoundedDeadline } from './requestLimits.js'
import { parseSafeUsage, type SafeUsage } from './usage.js'

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
  const deadlineMs = assertBoundedDeadline(input.deadlineMs ?? request.deadlineMs, input.maxDeadlineMs ?? 300_000)

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

  const accessToken = redeemed.accessToken
  let outcome: StreamCodexCompletionResult['outcome'] = 'unknown'
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
  deadlineMs: number
  signal?: AbortSignal
  fetchFn: typeof fetch
  lookup?: OriginPolicyOptions['lookup']
  onFrame?: (frame: StreamFrame) => void
}): Promise<StreamCodexCompletionResult> {
  const url = assertAllowedUpstreamUrl(CODEX_COMPLETIONS_ORIGIN, 'completions')
  await assertResolvedUpstream(url, input.lookup)
  const timeout = AbortSignal.timeout(input.deadlineMs)
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout
  const response = await input.fetchFn(url.href, {
    method: 'POST',
    redirect: 'manual',
    signal,
    headers: {
      authorization: `Bearer ${input.accessToken}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
    },
    body: JSON.stringify(toUpstreamPayload(input.request)),
  })
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location') || ''
    assertRedirectLocation(location, url)
    throw new OriginDeniedError('origin_denied')
  }
  if (!response.ok || !response.body) {
    throw new CodexTransportError('provider_unavailable', 'upstream completion failed')
  }
  return consumeSse(response.body, input.onFrame, signal)
}

function toUpstreamPayload(request: CodexCompletionRequestV1): Record<string, unknown> {
  return {
    model: request.model,
    stream: true,
    input: request.messages.map(message => ({
      role: message.role,
      content: message.content,
    })),
    tools: request.tools?.map(tool => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
    max_output_tokens: request.generation?.maxOutputTokens,
    temperature: request.generation?.temperature,
  }
}

async function consumeSse(
  body: ReadableStream<Uint8Array>,
  onFrame: ((frame: StreamFrame) => void) | undefined,
  signal: AbortSignal
): Promise<StreamCodexCompletionResult> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let completed = false
  let usage: SafeUsage | undefined
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split('\n\n')
      buffer = parts.pop() ?? ''
      for (const part of parts) {
        const dataLine = part
          .split('\n')
          .map(line => line.trim())
          .find(line => line.startsWith('data:'))
        if (!dataLine) continue
        const payload = dataLine.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        let parsed: unknown
        try {
          parsed = JSON.parse(payload)
        } catch {
          continue
        }
        const mapped = mapUpstreamEvent(parsed)
        if (mapped.frame) onFrame?.(mapped.frame)
        if (mapped.usage) usage = mapped.usage
        if (mapped.completed) completed = true
      }
      if (signal.aborted) break
    }
  } finally {
    reader.releaseLock()
  }
  if (signal.aborted) return { outcome: 'canceled', usage }
  if (completed) return { outcome: 'success', usage }
  return { outcome: 'unknown', usage }
}

function mapUpstreamEvent(event: unknown): {
  frame?: StreamFrame
  usage?: SafeUsage
  completed?: boolean
} {
  if (!event || typeof event !== 'object') return {}
  const row = event as Record<string, unknown>
  const type = String(row.type || '')
  if (type === 'response.output_text.delta' && typeof row.delta === 'string') {
    return { frame: { type: 'text', text: row.delta } }
  }
  if (type === 'response.output_item.added' && isPlainObject(row.item) && row.item.type === 'function_call') {
    const args = parseToolArguments(row.item.arguments)
    return {
      frame: {
        type: 'tool_call',
        id: String(row.item.id || 'tool'),
        name: String(row.item.name || 'tool'),
        arguments: args,
      },
    }
  }
  if (type === 'response.completed') {
    const response = isPlainObject(row.response) ? row.response : row
    return { completed: true, usage: parseSafeUsage(response.usage) }
  }
  return {}
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
  await assertResolvedUpstream(url, input.lookup)
  const response = await input.fetchFn(url.href, {
    method: 'GET',
    redirect: 'manual',
    headers: {
      authorization: `Bearer ${input.accessToken}`,
      accept: 'application/json',
    },
  })
  if (response.status >= 300 && response.status < 400) {
    assertRedirectLocation(response.headers.get('location') || '', url)
    throw new OriginDeniedError('origin_denied')
  }
  if (response.status === 401 || response.status === 403) return { outcome: 'auth-rejected', models: [] }
  if (!response.ok) return { outcome: 'unavailable', models: [] }
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
