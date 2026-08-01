import { CircuitBreaker } from '../domain/circuitBreaker'
import { PluginWorkloadError, isKnownPluginWorkloadErrorCode } from '../domain/errors'
import type { PromptBridgeTarget } from '../domain/types'

/**
 * Anti-corruption layer (plan §3.4): encapsulates the HTTP call to
 * control-api's /mcp-host/plugin-workload-sdk/* gateway routes and maps
 * status codes + error bodies into PluginWorkloadError. Internal control-api
 * response details never reach the workload.
 *
 * Resilience: 3 retries with exponential backoff on transient failures
 * (5xx, network), plus a 50%-over-30s circuit breaker that short-circuits
 * to provider_unavailable while open (resets after 60s without calls).
 */

export interface ControlApiClientOptions {
  baseUrl: string
  getAccessToken: () => string
  /**
   * Refresh-on-401 hook (plan §12). The mcp-host runtime access token (TTL
   * ~600s) is read live via getAccessToken(); when control-api rejects it with
   * 401 the token has aged out. This rotates the shared runtime auth so the
   * retry — and every later call — reads a fresh token. Without it an always-on
   * SDK mcp-host that makes no other gateway calls (no approvals, no usage)
   * would 401 forever once its boot token expires, killing promptBridge and
   * clientNotifications after ~10 minutes. Mirrors UsageReporter and the
   * approval clients, which already refresh-on-401 on the same shared auth.
   */
  refreshOnUnauthorized?: () => Promise<void>
  fetchImpl?: typeof fetch
  maxRetries?: number
  retryBaseDelayMs?: number
  breaker?: CircuitBreaker
}

export interface AuthorizePromptBridgeResponse {
  invocationId: string
  replay: boolean
  status: string
  model: string
  modelPolicy: { provider: string; model: string; temperature?: number; maxCostUsd?: number } | null
  selectedTarget: PromptBridgeTarget
  authorizedTargets: PromptBridgeTarget[]
  authorizedTargetTickets: Array<{ targetRef: string; credentialTicket: string }>
  policyRevision: number
  policyHash: string
  maxOutputTokens: number | null
}

export interface SubmitClientNotificationResponse {
  notificationId: string
  replay: boolean
  status: string
  eventType: string
  target: { targetRef?: string; userRef?: string }
}

export interface ClientNotificationRecipient {
  userRef: string
  displayName: string
}

export interface ListClientNotificationRecipientsResponse {
  recipients: ClientNotificationRecipient[]
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

function isAuthorizePromptBridgeResponse(v: unknown): v is AuthorizePromptBridgeResponse {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return (
    typeof r.invocationId === 'string' &&
    typeof r.replay === 'boolean' &&
    typeof r.status === 'string' &&
    typeof r.model === 'string' &&
    (r.modelPolicy === null ||
      (typeof r.modelPolicy === 'object' &&
        r.modelPolicy !== null &&
        typeof (r.modelPolicy as Record<string, unknown>).provider === 'string' &&
        typeof (r.modelPolicy as Record<string, unknown>).model === 'string')) &&
    isPromptBridgeTarget(r.selectedTarget) &&
    Array.isArray(r.authorizedTargets) &&
    r.authorizedTargets.length > 0 &&
    r.authorizedTargets.every(isPromptBridgeTarget) &&
    Array.isArray(r.authorizedTargetTickets) &&
    r.authorizedTargetTickets.length === r.authorizedTargets.length &&
    r.authorizedTargetTickets.every(
      ticket =>
        typeof ticket === 'object' &&
        ticket !== null &&
        typeof (ticket as Record<string, unknown>).targetRef === 'string' &&
        typeof (ticket as Record<string, unknown>).credentialTicket === 'string'
    ) &&
    Number.isInteger(r.policyRevision) &&
    (r.policyRevision as number) >= 1 &&
    typeof r.policyHash === 'string' &&
    /^[a-f0-9]{64}$/.test(r.policyHash) &&
    (r.maxOutputTokens === null || typeof r.maxOutputTokens === 'number')
  )
}

function isPromptBridgeTarget(value: unknown): value is PromptBridgeTarget {
  if (typeof value !== 'object' || value === null) return false
  const target = value as Record<string, unknown>
  return (
    typeof target.targetRef === 'string' &&
    typeof target.provider === 'string' &&
    typeof target.model === 'string' &&
    typeof target.credentialSlot === 'string'
  )
}

function isSubmitClientNotificationResponse(v: unknown): v is SubmitClientNotificationResponse {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return (
    typeof r.notificationId === 'string' &&
    typeof r.replay === 'boolean' &&
    typeof r.status === 'string' &&
    typeof r.eventType === 'string' &&
    typeof r.target === 'object' &&
    r.target !== null
  )
}

function isListClientNotificationRecipientsResponse(
  v: unknown
): v is ListClientNotificationRecipientsResponse {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return (
    Array.isArray(r.recipients) &&
    r.recipients.every(
      item =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as Record<string, unknown>).userRef === 'string' &&
        typeof (item as Record<string, unknown>).displayName === 'string'
    )
  )
}

export class PluginWorkloadSdkControlApiClient {
  private readonly breaker: CircuitBreaker
  private refreshInFlight: Promise<void> | null = null

  constructor(private readonly opts: ControlApiClientOptions) {
    this.breaker = opts.breaker ?? new CircuitBreaker()
  }

  /**
   * Refresh-and-retry wrapper around postOnce(). On the first `unauthorized`
   * (401) from control-api the runtime access token has aged out: rotate the
   * shared runtime auth once and retry with the fresh token. A second 401 (or
   * no refresh hook) propagates the error so a genuinely bad credential still
   * surfaces instead of looping.
   */
  private async post(path: string, body: unknown): Promise<unknown> {
    try {
      return await this.postOnce(path, body)
    } catch (err) {
      if (
        err instanceof PluginWorkloadError &&
        err.code === 'unauthorized' &&
        this.opts.refreshOnUnauthorized
      ) {
        await this.triggerRefresh()
        return this.postOnce(path, body)
      }
      throw err
    }
  }

  /**
   * Coalesce concurrent refreshes onto a single attempt — control-api revokes
   * refresh JTIs on first use, so parallel promptBridge/clientNotifications
   * calls that 401 together must share one rotation rather than burn the chain.
   */
  private async triggerRefresh(): Promise<void> {
    if (!this.opts.refreshOnUnauthorized) return
    if (this.refreshInFlight) {
      await this.refreshInFlight
      return
    }
    this.refreshInFlight = this.opts
      .refreshOnUnauthorized()
      .then(() => undefined)
      .catch(err => {
        console.warn(
          `[PluginWorkloadSdk] refresh-on-401 failed: ${
            err instanceof Error ? err.message : String(err)
          }`
        )
      })
    try {
      await this.refreshInFlight
    } finally {
      this.refreshInFlight = null
    }
  }

  private async postOnce(path: string, body: unknown): Promise<unknown> {
    if (!this.breaker.allow()) {
      throw new PluginWorkloadError(
        'provider_unavailable',
        'control-api gateway circuit breaker is open',
        true
      )
    }

    const fetchImpl = this.opts.fetchImpl ?? fetch
    const url = `${this.opts.baseUrl.replace(/\/+$/, '')}${path}`
    const maxRetries = this.opts.maxRetries ?? 3
    const baseDelay = this.opts.retryBaseDelayMs ?? 250

    let lastError: unknown = null
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) await sleep(baseDelay * 2 ** (attempt - 1))
      let response: Response
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.opts.getAccessToken()}`,
          },
          body: JSON.stringify(body),
        })
      } catch (err) {
        // Network failure — retryable.
        lastError = err
        this.breaker.record(false)
        continue
      }

      if (response.status >= 500) {
        lastError = new PluginWorkloadError(
          'provider_unavailable',
          `control-api responded ${response.status}`,
          true
        )
        this.breaker.record(false)
        continue
      }

      this.breaker.record(true)

      if (response.ok) {
        return response.json()
      }

      // Non-retryable 4xx: map the structured code without leaking the body.
      const errorBody = (await response.json().catch(() => ({}))) as {
        error?: unknown
        message?: unknown
        retryable?: unknown
      }
      const code = typeof errorBody.error === 'string' ? errorBody.error : ''
      if (isKnownPluginWorkloadErrorCode(code)) {
        throw new PluginWorkloadError(
          code,
          typeof errorBody.message === 'string' ? errorBody.message : `request denied (${code})`,
          errorBody.retryable === true
        )
      }
      if (response.status === 401) {
        throw new PluginWorkloadError('unauthorized', 'gateway rejected mcp-host credentials')
      }
      throw new PluginWorkloadError('invalid_request', `request rejected (${response.status})`)
    }

    throw lastError instanceof Error
      ? lastError
      : new PluginWorkloadError(
          'provider_unavailable',
          'control-api gateway is unavailable after retries',
          true
        )
  }

  async authorizePromptBridge(body: {
    recipeNamespace: string
    recipeName: string
    callerRef: string
    bootstrapProvider?: string
    bootstrapModel?: string
    model?: string
    provider?: string
    targetRef?: string
    modelPolicyRef?: string
    purpose: string
    idempotencyKey: string
    messages: Array<{ role: string; content: string }>
    metadata?: Record<string, unknown>
    correlationId?: string
  }): Promise<AuthorizePromptBridgeResponse> {
    const result = await this.post('/api/v1/mcp-host/plugin-workload-sdk/prompt-bridge', body)
    if (!isAuthorizePromptBridgeResponse(result)) {
      throw new PluginWorkloadError(
        'provider_unavailable',
        'control-api returned an unexpected response shape for authorize-prompt-bridge',
        true
      )
    }
    return result
  }

  async reportInvocationStatus(
    invocationId: string,
    recipeNamespace: string,
    recipeName: string,
    status: 'complete' | 'failed' | 'provider_unavailable'
  ): Promise<void> {
    // Status reporting is best-effort: a failure to report must never mask
    // the actual promptBridge outcome for the workload.
    try {
      await this.post(
        `/api/v1/mcp-host/plugin-workload-sdk/invocations/${encodeURIComponent(invocationId)}/status`,
        { recipeNamespace, recipeName, status }
      )
    } catch (err) {
      // Best-effort: log structured via src/logger.ts ([Component] prefix →
      // JSON). Fold the error into the message so it is not lost.
      console.warn(
        `[PluginWorkloadSdk] failed to report invocation ${invocationId} status=${status}: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  }

  async submitClientNotification(body: {
    recipeNamespace: string
    recipeName: string
    callerRef: string
    eventType: string
    target?: { targetRef: string }
    userRef?: string
    idempotencyKey: string
    notification: {
      title: string
      body: string
      data?: Record<string, unknown>
      actionRef?: { type: string; id: string; urlRef?: string }
      deliveryPolicyRef?: string
      correlationId?: string
    }
  }): Promise<SubmitClientNotificationResponse> {
    const result = await this.post('/api/v1/mcp-host/plugin-workload-sdk/client-notification', body)
    if (!isSubmitClientNotificationResponse(result)) {
      throw new PluginWorkloadError(
        'provider_unavailable',
        'control-api returned an unexpected response shape for submit-client-notification',
        true
      )
    }
    return result
  }

  /**
   * List the clientNotifications grant's allowed recipients (read-only). The
   * gateway hop is a POST carrying the recipe binding in the body — same
   * binding-match contract and refresh-on-401 path as submitClientNotification —
   * so the workload-facing GET surfaces the authoritative allowlist without a
   * recipe-baked recipients env.
   */
  async listClientNotificationRecipients(body: {
    recipeNamespace: string
    recipeName: string
    callerRef: string
  }): Promise<ListClientNotificationRecipientsResponse> {
    const result = await this.post(
      '/api/v1/mcp-host/plugin-workload-sdk/client-notification/recipients',
      body
    )
    if (!isListClientNotificationRecipientsResponse(result)) {
      throw new PluginWorkloadError(
        'provider_unavailable',
        'control-api returned an unexpected response shape for list-recipients',
        true
      )
    }
    return result
  }
}
