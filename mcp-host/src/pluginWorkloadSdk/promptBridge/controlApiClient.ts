import { CircuitBreaker } from '../domain/circuitBreaker'
import {
  PluginWorkloadError,
  isKnownPluginWorkloadErrorCode,
  isKnownPluginWorkloadErrorReason,
} from '../domain/errors'
import type { PromptBridgeTarget } from '../domain/types'
import { readSdkOnlyCodexBinding } from '../sdkOnlyCodexBinding'

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
  contractVersion: 2
  invocationId: string
  replay: boolean
  providerCallRequired: boolean
  status: string
  model: string
  modelPolicy: { provider: string; model: string; temperature?: number; maxCostUsd?: number } | null
  selectedTarget: PromptBridgeTarget
  authorizedTargets: PromptBridgeTarget[]
  attemptGeneration: number
  policyRevision: number
  policyHash: string
  /**
   * Per-grant output ceiling, or null when the grant sets none. Enforced as
   * `max_tokens` on API-key providers; codex-subscription cannot bind it on
   * the ChatGPT wire, where the contract's LIMITS.maxOutputTokens is the only
   * bound.
   */
  maxOutputTokens: number | null
}

export interface PluginWorkloadSdkCapabilities {
  contractVersion: 2 | 3
  supportedContractVersions: number[]
  targetAwarePromptBridge: true
  attemptLedger: true
  credentialTickets: true
  policyState: string
  policyRevision: number
  policyHash: string | null
  defaultTargetRef: string | null
  defaultProvider: string | null
  defaultModel: string | null
  defaultConnectionRef: string | null
  v2Ready: boolean
  /** Present only when the grant default is oauth-broker (reservation-only Codex). */
  reservationOnlyOauthBroker?: true
  /**
   * Present only when this control-api can publish the authoritative Codex
   * catalog/credential revisions. Absent means the peer predates them, not
   * that the binding is stale — see `codexBindingReady`.
   */
  codexBindingRevisions?: true
  defaultCatalogRevision?: number
  defaultCredentialRevision?: number
  clientNotificationsPolicyState: string
  clientNotificationsReady: boolean
}

export interface PluginWorkloadSdkBootstrapProof {
  ready: true
  contractVersion: 2 | 3
  provider: string
  model: string
  policyReady: boolean
  policyState: string
  policyReason?:
    | 'grant_missing'
    | 'policy_unreviewed'
    | 'policy_revoking'
    | 'policy_disabled'
    | 'bootstrap_target_mismatch'
    | 'policy_not_ready'
    | 'codex_execution_binding_missing'
  /** Control API attested the live Codex connection against the v3 binding. */
  codexBindingReady?: boolean
  /**
   * Policy metadata is deliberately optional at identity bootstrap. A recipe
   * may be installed and publish an awaiting-policy SDK runtime before an
   * operator creates its promptBridge grant. The grant is still required for
   * every request and is checked by the authorization endpoint against this
   * binding.
   */
  policyRevision?: number
  policyHash?: string
  defaultTargetRef?: string
  defaultProvider?: string
  defaultModel?: string
  clientNotificationsPolicyReady?: boolean
  clientNotificationsPolicyState?: string
  clientNotificationsPolicyReason?: string
}

export interface PluginWorkloadSdkClientNotificationsBootstrapProof {
  ready: true
  contractVersion: 2
  policyReady: boolean
  policyState: string
  policyReason?:
    | 'grant_missing'
    | 'policy_unreviewed'
    | 'policy_revoking'
    | 'policy_disabled'
    | 'policy_not_ready'
}

export interface ReissuedPromptBridgeCredentialTicket {
  invocationId: string
  attemptGeneration: number
  providerAttemptId: string
  providerAttemptIndex: number
  targetRef: string
  credentialTicket: string
  reservationOnly?: true
  policyRevision: number
  policyHash: string
  expiresInSeconds: number
}

export interface FinalizePromptBridgeResponse {
  invocationId: string
  providerAttemptId: string
  status: 'complete' | 'failed' | 'provider_unavailable'
  outcome: 'exact' | 'unknown' | 'not_executed'
  idempotent: boolean
  usageAccepted: boolean
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
    r.contractVersion === 2 &&
    typeof r.invocationId === 'string' &&
    typeof r.replay === 'boolean' &&
    typeof r.providerCallRequired === 'boolean' &&
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
    Number.isInteger(r.attemptGeneration) &&
    (r.attemptGeneration as number) >= 1 &&
    Number.isInteger(r.policyRevision) &&
    (r.policyRevision as number) >= 1 &&
    typeof r.policyHash === 'string' &&
    /^[a-f0-9]{64}$/.test(r.policyHash) &&
    // A grant cap of 0 is not "no cap" — it would clamp every response
    // to nothing. Reject it here rather than let Math.min silently zero the
    // request.
    (r.maxOutputTokens === null ||
      (Number.isInteger(r.maxOutputTokens) && Number(r.maxOutputTokens) >= 1))
  )
}

function isPluginWorkloadSdkCapabilities(v: unknown): v is PluginWorkloadSdkCapabilities {
  if (typeof v !== 'object' || v === null) return false
  const value = v as Record<string, unknown>
  return (
    (value.contractVersion === 2 || value.contractVersion === 3) &&
    Array.isArray(value.supportedContractVersions) &&
    value.supportedContractVersions.includes(2) &&
    value.targetAwarePromptBridge === true &&
    value.attemptLedger === true &&
    value.credentialTickets === true &&
    typeof value.policyState === 'string' &&
    Number.isInteger(value.policyRevision) &&
    Number(value.policyRevision) >= 0 &&
    (value.policyHash === null || typeof value.policyHash === 'string') &&
    (value.defaultTargetRef === null || typeof value.defaultTargetRef === 'string') &&
    (value.defaultProvider === null || typeof value.defaultProvider === 'string') &&
    (value.defaultModel === null || typeof value.defaultModel === 'string') &&
    (value.defaultConnectionRef === undefined ||
      value.defaultConnectionRef === null ||
      typeof value.defaultConnectionRef === 'string') &&
    typeof value.v2Ready === 'boolean' &&
    (value.reservationOnlyOauthBroker === undefined || value.reservationOnlyOauthBroker === true) &&
    (value.codexBindingRevisions === undefined || value.codexBindingRevisions === true) &&
    // Bounds mirror the codex_subscription_connections CHECKs —
    // `catalog_revision BIGINT NOT NULL DEFAULT 0 CHECK (>= 0)` and
    // `credential_revision BIGINT NOT NULL DEFAULT 1 CHECK (>= 1)`. These were
    // inverted, so a connection whose catalog was never synced (revision 0,
    // the DEFAULT) failed the whole capabilities contract with
    // protocol_mismatch instead of resolving to codexBindingReady: false.
    (value.defaultCatalogRevision === undefined ||
      (Number.isInteger(value.defaultCatalogRevision) &&
        Number(value.defaultCatalogRevision) >= 0)) &&
    (value.defaultCredentialRevision === undefined ||
      (Number.isInteger(value.defaultCredentialRevision) &&
        Number(value.defaultCredentialRevision) >= 1)) &&
    typeof value.clientNotificationsPolicyState === 'string' &&
    typeof value.clientNotificationsReady === 'boolean'
  )
}

function isReissuedPromptBridgeCredentialTicket(
  value: unknown
): value is ReissuedPromptBridgeCredentialTicket {
  if (typeof value !== 'object' || value === null) return false
  const ticket = value as Record<string, unknown>
  return (
    typeof ticket.invocationId === 'string' &&
    Number.isInteger(ticket.attemptGeneration) &&
    (ticket.attemptGeneration as number) >= 1 &&
    typeof ticket.providerAttemptId === 'string' &&
    ticket.providerAttemptId.length > 0 &&
    Number.isInteger(ticket.providerAttemptIndex) &&
    (ticket.providerAttemptIndex as number) >= 1 &&
    typeof ticket.targetRef === 'string' &&
    typeof ticket.credentialTicket === 'string' &&
    (ticket.credentialTicket.length > 0 || ticket.reservationOnly === true) &&
    Number.isInteger(ticket.policyRevision) &&
    (ticket.policyRevision as number) >= 1 &&
    typeof ticket.policyHash === 'string' &&
    /^[a-f0-9]{64}$/.test(ticket.policyHash) &&
    Number.isInteger(ticket.expiresInSeconds) &&
    (ticket.expiresInSeconds as number) > 0
  )
}

function isFinalizePromptBridgeResponse(value: unknown): value is FinalizePromptBridgeResponse {
  if (typeof value !== 'object' || value === null) return false
  const result = value as Record<string, unknown>
  return (
    typeof result.invocationId === 'string' &&
    typeof result.providerAttemptId === 'string' &&
    (result.status === 'complete' ||
      result.status === 'failed' ||
      result.status === 'provider_unavailable') &&
    (result.outcome === 'exact' ||
      result.outcome === 'unknown' ||
      result.outcome === 'not_executed') &&
    typeof result.idempotent === 'boolean' &&
    typeof result.usageAccepted === 'boolean'
  )
}

function isPromptBridgeTarget(value: unknown): value is PromptBridgeTarget {
  if (typeof value !== 'object' || value === null) return false
  const target = value as Record<string, unknown>
  return (
    typeof target.targetRef === 'string' &&
    typeof target.provider === 'string' &&
    typeof target.model === 'string' &&
    typeof target.credentialSlot === 'string' &&
    // Optional Codex subscription grant identity (oauth-broker targets only).
    (target.connectionRef === undefined || typeof target.connectionRef === 'string')
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
  private capabilitiesInFlight: Promise<PluginWorkloadSdkCapabilities> | null = null

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
  private async post(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    try {
      return await this.postOnce(path, body, signal)
    } catch (err) {
      if (
        err instanceof PluginWorkloadError &&
        err.code === 'unauthorized' &&
        this.opts.refreshOnUnauthorized
      ) {
        await this.triggerRefresh()
        return this.postOnce(path, body, signal)
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

  private async postOnce(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
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
      // An aborted caller deadline is not a transient network failure: without
      // this the `catch` below would swallow every AbortError as retryable and
      // burn the remaining attempts after the operation was already over.
      if (signal?.aborted) break
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
          // The per-request timeout still bounds one hop; a caller-supplied
          // signal additionally bounds the whole operation across retries, so
          // a finalize deadline cannot be outlived by this loop.
          signal: signal
            ? AbortSignal.any([AbortSignal.timeout(15_000), signal])
            : AbortSignal.timeout(15_000),
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

      if (response.status === 404 && path.endsWith('/prompt-bridge/v2')) {
        throw new PluginWorkloadError(
          'protocol_mismatch',
          'control-api does not expose the promptBridge v2 contract; rollout must upgrade control-api before mcp-host',
          true
        )
      }

      // Non-retryable 4xx: map the structured code without leaking the body.
      const errorBody = (await response.json().catch(() => ({}))) as {
        error?: unknown
        message?: unknown
        retryable?: unknown
        reason?: unknown
      }
      const code = typeof errorBody.error === 'string' ? errorBody.error : ''
      if (isKnownPluginWorkloadErrorCode(code)) {
        throw new PluginWorkloadError(
          code,
          typeof errorBody.message === 'string' ? errorBody.message : `request denied (${code})`,
          errorBody.retryable === true,
          typeof errorBody.reason === 'string' && isKnownPluginWorkloadErrorReason(errorBody.reason)
            ? errorBody.reason
            : undefined
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

  private async getOnce(path: string): Promise<unknown> {
    if (!this.breaker.allow()) {
      throw new PluginWorkloadError(
        'provider_unavailable',
        'control-api gateway circuit breaker is open',
        true
      )
    }
    const fetchImpl = this.opts.fetchImpl ?? fetch
    let response: Response
    try {
      response = await fetchImpl(`${this.opts.baseUrl.replace(/\/+$/, '')}${path}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.opts.getAccessToken()}` },
      })
    } catch {
      this.breaker.record(false)
      throw new PluginWorkloadError(
        'provider_unavailable',
        'control-api capability probe failed',
        true
      )
    }
    if (response.status === 404 || response.status === 405) {
      this.breaker.record(true)
      throw new PluginWorkloadError(
        'protocol_mismatch',
        'control-api does not advertise the promptBridge v2 contract; upgrade control-api before mcp-host',
        true
      )
    }
    if (response.status >= 500) {
      this.breaker.record(false)
      throw new PluginWorkloadError(
        'provider_unavailable',
        `control-api capability probe responded ${response.status}`,
        true
      )
    }
    this.breaker.record(true)
    if (response.ok) return response.json()
    if (response.status === 401) {
      throw new PluginWorkloadError('unauthorized', 'gateway rejected mcp-host credentials')
    }
    throw new PluginWorkloadError(
      'protocol_mismatch',
      'control-api capability contract was rejected',
      true
    )
  }

  private async get(path: string): Promise<unknown> {
    try {
      return await this.getOnce(path)
    } catch (err) {
      if (
        err instanceof PluginWorkloadError &&
        err.code === 'unauthorized' &&
        this.opts.refreshOnUnauthorized
      ) {
        await this.triggerRefresh()
        return this.getOnce(path)
      }
      throw err
    }
  }

  /** Fetch the capabilities contract, coalescing only concurrent probes. */
  async getPromptBridgeCapabilities(): Promise<PluginWorkloadSdkCapabilities> {
    if (this.capabilitiesInFlight) return this.capabilitiesInFlight
    const request = this.get('/api/v1/mcp-host/plugin-workload-sdk/capabilities')
      .then(result => {
        if (!isPluginWorkloadSdkCapabilities(result)) {
          throw new PluginWorkloadError(
            'protocol_mismatch',
            'control-api capability response is not the promptBridge v2 contract',
            true
          )
        }
        return {
          ...result,
          defaultConnectionRef: result.defaultConnectionRef ?? null,
        }
      })
      .finally(() => {
        if (this.capabilitiesInFlight === request) this.capabilitiesInFlight = null
      })
    this.capabilitiesInFlight = request
    return request
  }

  /**
   * Negotiates the target-aware/JIT wire contract before a prompt. There is no
   * legacy fallback: an SDK host must not send multiprovider traffic to an API that
   * cannot fence attempts or tickets.
   */
  async ensurePromptBridgeCapabilities(): Promise<void> {
    const capabilities = await this.getPromptBridgeCapabilities()
    if (!capabilities.v2Ready) {
      throw new PluginWorkloadError(
        'provider_policy_denied',
        'control-api promptBridge policy is not ready; an active operator grant is required',
        false
      )
    }
  }

  /**
   * Fresh two-phase bootstrap proof. The completed response is never cached;
   * only an in-flight request may be shared. This always proves that
   * control-api and mcp-host speak the v2 SDK contract. `policyReady` is a
   * separate live signal: a missing or unreviewed grant is a legitimate
   * awaiting-policy state, not a provider outage. Policy/default/target
   * coherence is enforced again when the workload authorizes its first prompt.
   */
  async verifyPromptBridgeBootstrapV2(
    expectedProvider: string,
    expectedModel: string
  ): Promise<PluginWorkloadSdkBootstrapProof> {
    const capabilities = await this.getPromptBridgeCapabilities()
    if (
      (capabilities.contractVersion !== 2 && capabilities.contractVersion !== 3) ||
      !capabilities.supportedContractVersions.includes(2) ||
      capabilities.targetAwarePromptBridge !== true ||
      capabilities.attemptLedger !== true ||
      capabilities.credentialTickets !== true ||
      typeof expectedProvider !== 'string' ||
      expectedProvider.length === 0 ||
      typeof expectedModel !== 'string' ||
      expectedModel.length === 0
    ) {
      throw new PluginWorkloadError(
        'protocol_mismatch',
        'control-api promptBridge identity bootstrap contract is not ready',
        true
      )
    }
    const binding = expectedProvider === 'codex-subscription' ? readSdkOnlyCodexBinding() : null
    const reservationOnlyReady = capabilities.reservationOnlyOauthBroker === true
    const contractReady =
      capabilities.contractVersion === 3 && capabilities.supportedContractVersions.includes(3)
    // #533 acceptance criterion 2: the binding must be tied to the catalog and
    // credential revisions too, not only to the connection and model. Those
    // revisions are authoritative on control-api's connection row, so this can
    // only be compared when the peer publishes them. `codexBindingRevisions`
    // is that discriminator, and it must be read as "can this API send them",
    // never as "is this binding fresh": an older control-api omits the flag,
    // and demanding a field it cannot emit would fail closed across a
    // mixed-binary window (the #540 shape). When the flag IS present, both
    // values are required and must match — a missing or divergent revision is
    // a stale binding, and it fails closed here at reconcile rather than at
    // the first prompt.
    const revisionsPublished = capabilities.codexBindingRevisions === true
    const codexRevisionsReady =
      !revisionsPublished ||
      (binding !== null &&
        capabilities.defaultCatalogRevision === binding.catalogRevision &&
        capabilities.defaultCredentialRevision === binding.credentialRevision)
    const codexBindingReady =
      expectedProvider !== 'codex-subscription' ||
      (reservationOnlyReady &&
        contractReady &&
        binding !== null &&
        capabilities.defaultProvider === expectedProvider &&
        capabilities.defaultModel === expectedModel &&
        binding.model === expectedModel &&
        typeof capabilities.defaultConnectionRef === 'string' &&
        capabilities.defaultConnectionRef === binding.connectionKey &&
        codexRevisionsReady)
    const policyReady =
      capabilities.v2Ready &&
      capabilities.policyRevision >= 1 &&
      !!capabilities.policyHash &&
      /^[a-f0-9]{64}$/.test(capabilities.policyHash) &&
      !!capabilities.defaultTargetRef &&
      capabilities.defaultProvider === expectedProvider &&
      capabilities.defaultModel === expectedModel &&
      codexBindingReady
    const policyReason = policyReady
      ? undefined
      : capabilities.policyState === 'missing'
        ? 'grant_missing'
        : capabilities.policyState === 'legacy_unreviewed'
          ? 'policy_unreviewed'
          : capabilities.policyState === 'revoking'
            ? 'policy_revoking'
            : capabilities.policyState === 'disabled'
              ? 'policy_disabled'
              : expectedProvider === 'codex-subscription' && !codexBindingReady
                ? 'codex_execution_binding_missing'
                : capabilities.v2Ready
                  ? 'bootstrap_target_mismatch'
                  : 'policy_not_ready'
    return {
      ready: true,
      contractVersion: expectedProvider === 'codex-subscription' ? 3 : 2,
      provider: expectedProvider,
      model: expectedModel,
      policyReady,
      policyState: capabilities.policyState,
      ...(expectedProvider === 'codex-subscription' ? { codexBindingReady } : {}),
      ...(policyReason ? { policyReason } : {}),
      ...(capabilities.v2Ready &&
      capabilities.policyRevision >= 1 &&
      capabilities.policyHash &&
      /^[a-f0-9]{64}$/.test(capabilities.policyHash) &&
      capabilities.defaultTargetRef &&
      capabilities.defaultProvider &&
      capabilities.defaultModel
        ? {
            policyRevision: capabilities.policyRevision,
            policyHash: capabilities.policyHash,
            defaultTargetRef: capabilities.defaultTargetRef,
            defaultProvider: capabilities.defaultProvider,
            defaultModel: capabilities.defaultModel,
          }
        : {}),
      clientNotificationsPolicyReady: capabilities.clientNotificationsReady,
      clientNotificationsPolicyState: capabilities.clientNotificationsPolicyState,
      ...(capabilities.clientNotificationsReady
        ? {}
        : {
            clientNotificationsPolicyReason:
              capabilities.clientNotificationsPolicyState === 'missing'
                ? 'grant_missing'
                : capabilities.clientNotificationsPolicyState === 'legacy_unreviewed'
                  ? 'policy_unreviewed'
                  : capabilities.clientNotificationsPolicyState === 'revoking'
                    ? 'policy_revoking'
                    : capabilities.clientNotificationsPolicyState === 'disabled'
                      ? 'policy_disabled'
                      : 'policy_not_ready',
          }),
    }
  }

  /**
   * Fresh readiness proof for the provider-free clientNotifications family.
   * It shares the v2 capabilities contract but never invents a provider/model
   * binding for a notifications-only recipe.
   */
  async verifyClientNotificationsBootstrap(): Promise<PluginWorkloadSdkClientNotificationsBootstrapProof> {
    const capabilities = await this.getPromptBridgeCapabilities()
    const policyReady = capabilities.clientNotificationsReady
    const policyReason = policyReady
      ? undefined
      : capabilities.clientNotificationsPolicyState === 'missing'
        ? 'grant_missing'
        : capabilities.clientNotificationsPolicyState === 'legacy_unreviewed'
          ? 'policy_unreviewed'
          : capabilities.clientNotificationsPolicyState === 'revoking'
            ? 'policy_revoking'
            : capabilities.clientNotificationsPolicyState === 'disabled'
              ? 'policy_disabled'
              : 'policy_not_ready'
    return {
      ready: true,
      contractVersion: 2,
      policyReady,
      policyState: capabilities.clientNotificationsPolicyState,
      ...(policyReason ? { policyReason } : {}),
    }
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
    const result = await this.post('/api/v1/mcp-host/plugin-workload-sdk/prompt-bridge/v2', {
      contractVersion: 2,
      ...body,
    })
    if (!isAuthorizePromptBridgeResponse(result)) {
      throw new PluginWorkloadError(
        'provider_unavailable',
        'control-api returned an unexpected response shape for authorize-prompt-bridge',
        true
      )
    }
    return result
  }

  /**
   * Obtain a one-shot credential ticket immediately before a single target's
   * credential resolution. The caller binds the original authorization
   * snapshot; the gateway independently derives the credential identity.
   */
  async reissuePromptBridgeCredentialTicket(body: {
    recipeNamespace: string
    recipeName: string
    invocationId: string
    attemptGeneration: number
    target: PromptBridgeTarget
    policyRevision: number
    policyHash: string
  }): Promise<ReissuedPromptBridgeCredentialTicket> {
    const result = await this.post(
      '/api/v1/mcp-host/plugin-workload-sdk/prompt-bridge/credential-ticket',
      {
        recipeNamespace: body.recipeNamespace,
        recipeName: body.recipeName,
        invocationId: body.invocationId,
        targetRef: body.target.targetRef,
        attemptGeneration: body.attemptGeneration,
      }
    )
    if (!isReissuedPromptBridgeCredentialTicket(result)) {
      throw new PluginWorkloadError(
        'provider_unavailable',
        'control-api returned an unexpected response shape for credential-ticket reissue',
        true
      )
    }
    if (
      result.invocationId !== body.invocationId ||
      result.attemptGeneration !== body.attemptGeneration ||
      result.providerAttemptId.length === 0 ||
      result.providerAttemptIndex < 1 ||
      result.targetRef !== body.target.targetRef ||
      result.policyRevision !== body.policyRevision ||
      result.policyHash !== body.policyHash
    ) {
      throw new PluginWorkloadError(
        'provider_unavailable',
        'control-api returned a credential ticket for a different authorization',
        false
      )
    }
    return result
  }

  async reportProviderAttemptStatus(body: {
    invocationId: string
    recipeNamespace: string
    recipeName: string
    attemptGeneration: number
    providerAttemptId: string
    providerAttemptIndex: number
    status: 'complete' | 'failed' | 'provider_unavailable' | 'skipped'
  }): Promise<void> {
    await this.post(
      `/api/v1/mcp-host/plugin-workload-sdk/provider-attempts/${encodeURIComponent(
        body.providerAttemptId
      )}/status`,
      body
    )
  }

  async reportInvocationStatus(
    invocationId: string,
    recipeNamespace: string,
    recipeName: string,
    status: 'complete' | 'failed' | 'provider_unavailable',
    attemptGeneration: number
  ): Promise<void> {
    // The handler owns the conservative policy for a lost ACK: it preserves a
    // real provider result, reports provider_unavailable when the physical
    // receipt is unknown, and lets the idempotent caller retry this operation.
    await this.post(
      `/api/v1/mcp-host/plugin-workload-sdk/invocations/${encodeURIComponent(invocationId)}/status`,
      { recipeNamespace, recipeName, status, attemptGeneration }
    )
  }

  /**
   * Atomically closes one SDK-only provider attempt and records exact or
   * unknown spend. This replaces separate status + usage calls for the
   * stepless runtime; the route is idempotent on providerAttemptId.
   */
  async finalizePromptBridge(
    body: {
      recipeNamespace: string
      recipeName: string
      invocationId: string
      attemptGeneration: number
      providerAttemptId: string
      providerAttemptIndex: number
      status: 'complete' | 'failed' | 'provider_unavailable'
      reason: string
      target: PromptBridgeTarget
      usage?: {
        llmSecretName: string
        callerRef: string
        fallbackUsed: boolean
        attemptCount: number
        inputTokens: number
        outputTokens: number
      }
    },
    options?: { signal?: AbortSignal }
  ): Promise<FinalizePromptBridgeResponse> {
    const result = await this.post(
      `/api/v1/mcp-host/plugin-workload-sdk/invocations/${encodeURIComponent(body.invocationId)}/finalize`,
      {
        recipeNamespace: body.recipeNamespace,
        recipeName: body.recipeName,
        invocationId: body.invocationId,
        attemptGeneration: body.attemptGeneration,
        providerAttemptId: body.providerAttemptId,
        providerAttemptIndex: body.providerAttemptIndex,
        status: body.status,
        reason: body.reason,
        target: body.target,
        ...(body.usage ? { usage: body.usage } : {}),
      },
      options?.signal
    )
    if (!isFinalizePromptBridgeResponse(result)) {
      throw new PluginWorkloadError(
        'provider_unavailable',
        'control-api returned an unexpected response shape for promptBridge finalization',
        true
      )
    }
    if (
      result.invocationId !== body.invocationId ||
      result.providerAttemptId !== body.providerAttemptId ||
      result.status !== body.status
    ) {
      throw new PluginWorkloadError(
        'provider_unavailable',
        'control-api returned a finalization for a different provider attempt',
        false,
        'outcome_unknown',
        true
      )
    }
    return result
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
