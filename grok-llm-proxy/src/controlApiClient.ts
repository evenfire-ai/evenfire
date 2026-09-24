import { logger } from './logger.js'
import {
  GROK_CATALOG_ORIGIN,
  GROK_COMPLETIONS_ORIGIN,
  GROK_TRANSPORT_PROTOCOL,
} from './originPolicy.js'

// Bound on one control-api call (redeem or finalize). Part of the time a
// stream request may spend before its first byte; see STREAM_LIMITS.
export const CONTROL_API_REQUEST_TIMEOUT_MS = 15_000

export type RedeemOperation = 'completion_stream' | 'completion_cancel' | 'connection_test'

export type RedeemAttemptSuccess = {
  accessToken: string
  grokAccountId?: string
  transport: {
    protocolVersion: typeof GROK_TRANSPORT_PROTOCOL
    completionsOrigin: typeof GROK_COMPLETIONS_ORIGIN
    catalogOrigin: typeof GROK_CATALOG_ORIGIN
    operation: RedeemOperation
    servedModel: string
    maxStreamDurationMs: number
  }
  expiryClass: 'short_lived' | 'upstream_managed'
  attemptReceipt: string
}

export type FinalizeAttemptSuccess = {
  providerAttemptId: string
  outcome: 'success' | 'canceled' | 'error' | 'unknown'
  duplicate: boolean
}

export type ControlApiClientConfig = {
  baseUrl: string
  serviceName: string
  serviceToken: string
  fetchFn?: typeof fetch
}

export class ControlApiClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    // The fetch failure's cause code, for the attempt log (G1-4).
    readonly causeCode?: string
  ) {
    super(message)
    this.name = 'ControlApiClientError'
  }
}

// G1-4 (#720): fetch failure codes that prove no control-plane process got
// the request: nothing accepted the connection, the name did not resolve, no
// route existed, or the TCP connect timed out. A reset, or anything after the
// request timeout fired, may have reached a live process and stays ambiguous.
// The Codex proxy carries the same set; the proxies share no module (#799).
const CONNECT_PHASE_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
])

// The code undici puts on a failed fetch's cause. Only a code-shaped string is
// returned, so nothing else from the error can reach a log.
export function fetchCauseCode(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined
  const cause: unknown = (err as { cause?: unknown }).cause
  if (typeof cause !== 'object' || cause === null) return undefined
  const code: unknown = (cause as { code?: unknown }).code
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : undefined
}

function isConnectPhaseFailure(err: unknown, signal: AbortSignal): boolean {
  if (signal.aborted || !(err instanceof TypeError)) return false
  const code = fetchCauseCode(err)
  return code !== undefined && CONNECT_PHASE_CODES.has(code)
}

export class ControlApiClient {
  constructor(private readonly config: ControlApiClientConfig) {}

  async redeem(input: {
    executionTicket: string
    requestHash: string
    model?: string
    hostRef?: string
    operation: RedeemOperation
  }): Promise<RedeemAttemptSuccess> {
    const body = await this.post('/internal/llm/grok/provider-attempts/redeem', {
      executionTicket: input.executionTicket,
      requestHash: input.requestHash,
      model: input.model,
      hostRef: input.hostRef,
      operation: input.operation,
    })
    return parseRedeem(body)
  }

  async finalize(input: {
    attemptReceipt: string
    receipt: {
      schemaVersion: 'grok-attempt-receipt.v1'
      providerAttemptId: string
      requestHash: string
      outcome: 'success' | 'canceled' | 'error' | 'unknown'
      usage?: { inputTokens?: number; outputTokens?: number }
    }
  }): Promise<FinalizeAttemptSuccess> {
    const body = await this.post('/internal/llm/grok/provider-attempts/finalize', {
      attemptReceipt: input.attemptReceipt,
      receipt: input.receipt,
    })
    if (!isPlainObject(body)) {
      return {
        providerAttemptId: input.receipt.providerAttemptId,
        outcome: input.receipt.outcome,
        duplicate: false,
      }
    }
    return {
      providerAttemptId: String(body.providerAttemptId ?? input.receipt.providerAttemptId),
      outcome: parseFinalizeOutcome(body.outcome),
      duplicate: body.duplicate === true,
    }
  }

  private async post(path: string, payload: Record<string, unknown>): Promise<unknown> {
    const base = this.config.baseUrl.replace(/\/+$/, '')
    const fetchFn = this.config.fetchFn ?? fetch
    const signal = AbortSignal.timeout(CONTROL_API_REQUEST_TIMEOUT_MS)
    let response: Response
    try {
      response = await fetchFn(`${base}${path.startsWith('/') ? path : `/${path}`}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.serviceToken}`,
          'x-service-token': this.config.serviceName,
        },
        body: JSON.stringify(payload),
        signal,
      })
    } catch (err) {
      if (!isConnectPhaseFailure(err, signal)) throw err
      const causeCode = fetchCauseCode(err)
      // The cause code travels on the error to the attempt line (redeem) or
      // grok_proxy_finalize_failed's err, so this line records only the hop.
      logger.warn(
        { event: 'grok_proxy_control_api_unreachable', path },
        'control API is unreachable'
      )
      throw new ControlApiClientError(
        'control_plane_unavailable',
        'control API is unreachable',
        causeCode
      )
    }
    const raw = await response.text()
    let parsed: unknown = null
    if (raw) {
      try {
        parsed = JSON.parse(raw)
      } catch {
        parsed = null
      }
    }
    if (!response.ok) {
      const code =
        isPlainObject(parsed) && typeof parsed.error === 'string'
          ? parsed.error
          : 'provider_unavailable'
      logger.warn(
        { event: 'grok_proxy_control_api_denied', code, path },
        'control API request denied'
      )
      throw new ControlApiClientError(code, 'control API request denied')
    }
    return parsed
  }
}

function parseRedeem(body: unknown): RedeemAttemptSuccess {
  if (
    !isPlainObject(body) ||
    typeof body.accessToken !== 'string' ||
    !isPlainObject(body.transport)
  ) {
    throw new ControlApiClientError('provider_unavailable', 'redeem response is invalid')
  }
  const transport = body.transport
  // control-api sends this on every redeem, so an absent value is a contract
  // violation like a non-number. Zero/negative would reach AbortSignal.timeout
  // as a RangeError.
  const maxStreamDurationMs = transport.maxStreamDurationMs
  if (
    typeof maxStreamDurationMs !== 'number' ||
    !Number.isFinite(maxStreamDurationMs) ||
    maxStreamDurationMs <= 0
  ) {
    throw new ControlApiClientError('provider_unavailable', 'redeem maxStreamDurationMs is invalid')
  }
  if (
    transport.protocolVersion !== GROK_TRANSPORT_PROTOCOL ||
    transport.completionsOrigin !== GROK_COMPLETIONS_ORIGIN ||
    transport.catalogOrigin !== GROK_CATALOG_ORIGIN ||
    typeof transport.servedModel !== 'string'
  ) {
    throw new ControlApiClientError('origin_denied', 'redeem transport metadata is not frozen')
  }
  if (typeof body.attemptReceipt !== 'string' || !/^[a-f0-9]{64}$/.test(body.attemptReceipt)) {
    throw new ControlApiClientError('provider_unavailable', 'attemptReceipt is invalid')
  }
  return {
    accessToken: body.accessToken,
    ...(typeof body.grokAccountId === 'string' && body.grokAccountId.trim()
      ? { grokAccountId: body.grokAccountId.trim() }
      : {}),
    transport: {
      protocolVersion: GROK_TRANSPORT_PROTOCOL,
      completionsOrigin: GROK_COMPLETIONS_ORIGIN,
      catalogOrigin: GROK_CATALOG_ORIGIN,
      operation:
        transport.operation === 'completion_cancel' || transport.operation === 'connection_test'
          ? transport.operation
          : 'completion_stream',
      servedModel: transport.servedModel,
      maxStreamDurationMs,
    },
    expiryClass: body.expiryClass === 'upstream_managed' ? 'upstream_managed' : 'short_lived',
    attemptReceipt: body.attemptReceipt,
  }
}

/** Unrecognized finalize outcomes are ambiguous; never report them as success. */
function parseFinalizeOutcome(raw: unknown): FinalizeAttemptSuccess['outcome'] {
  return raw === 'success' || raw === 'canceled' || raw === 'error' || raw === 'unknown'
    ? raw
    : 'unknown'
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
