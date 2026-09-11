import { PROVIDER_AUTH_MODE, isLlmProviderId } from '@clerum/llm-providers'
import { pluginWorkloadSdkAuthDecisionsTotal } from '../observability/metrics.js'
import type { McpHostAccessClaims } from '../utils/auth/mcpHostJwtToken.js'
import {
  PLUGIN_SDK_CREDENTIAL_TICKET_TTL_SECONDS,
  issuePluginWorkloadSdkCredentialTicketWithClaims,
} from './pluginWorkloadSdkCredentialTicket.js'
import {
  MAX_PROMPT_BRIDGE_PROVIDER_ATTEMPTS,
  type PluginWorkloadSdkErrorCode,
  type PluginWorkloadSdkGrant,
  type PluginWorkloadSdkModelPolicy,
  type PluginWorkloadSdkPromptTarget,
  findGrant,
  getInvocationById,
  getPluginWorkloadSdkAttemptReceipt,
  hasUsableClientNotificationRecipients,
  hashPromptTargetPolicy,
  isClientNotificationsPolicyReady,
  markPluginWorkloadSdkProviderAttemptStatus,
  registerPluginWorkloadSdkCredentialTicketJti,
  reservePluginWorkloadSdkProviderAttempt,
} from './pluginWorkloadSdkDb.js'
import {
  markInvocationStatus,
  recordInvocation,
  reviveFailedSdkInvocation,
} from './pluginWorkloadSdkInvocationAuditor.js'
import { checkRateLimit } from './pluginWorkloadSdkQuotaTracker.js'

// ─── Plugin Workload SDK — authorizer (plan §2.2) ────────────────────────
// Authorization pipeline for promptBridge and clientNotifications requests
// arriving from the recipe-bound mcp-host through the host/control gateway.
//
// Operation order is deliberate:
//   1. Pure checks first (scope → grant → caller → family-specific policy)
//      — no side effects on denied calls.
//   2. Audit record insert (reserves the idempotency key; non-failed replays
//      short-circuit here WITHOUT hitting rate limits or consuming quota again).
//   3. Read-only rate-limit check (new invocations and failed-replay retries only).
//   4. Atomic period-quota consumption; on failure the audit record is
//      flipped to failed so the trail shows the denied attempt.

const PLUGIN_WORKLOAD_SDK_SCOPE = 'plugin-workload-sdk'

export type PluginWorkloadSdkAuthzError = {
  ok: false
  error: PluginWorkloadSdkErrorCode
  message: string
  retryable: boolean
}

export type PluginWorkloadSdkAuthzResult<T> = { ok: true; value: T } | PluginWorkloadSdkAuthzError

const deny = (
  error: PluginWorkloadSdkErrorCode,
  message: string,
  retryable = false
): PluginWorkloadSdkAuthzError => ({ ok: false, error, message, retryable })

/**
 * Scope gate: a valid mcp-host JWT without the plugin-workload-sdk scope
 * gets the structured scope_denied (NOT a generic 403) — it signals a
 * provisioner configuration gap, not an attack.
 */
function checkScope(claims: McpHostAccessClaims): PluginWorkloadSdkAuthzError | null {
  const scopes = claims.workflowControlScopes as readonly string[]
  if (!scopes.includes(PLUGIN_WORKLOAD_SDK_SCOPE)) {
    return deny('scope_denied', 'mcp-host JWT lacks the plugin-workload-sdk scope')
  }
  return null
}

function checkCaller(
  grant: PluginWorkloadSdkGrant,
  callerRef: string
): PluginWorkloadSdkAuthzError | null {
  if (grant.allowedCallers.length === 0) {
    return deny('caller_not_allowed', 'grant has no allowedCallers configured')
  }
  if (!grant.allowedCallers.includes(callerRef)) {
    return deny('caller_not_allowed', `caller "${callerRef}" is not allowed by the grant`)
  }
  return null
}

// Exact allowlist matching uses `list.includes(value)` directly at each call
// site — wildcard entries are rejected at grant creation.

// ─── promptBridge ────────────────────────────────────────────────────────

export interface AuthorizePromptBridgeParams {
  claims: McpHostAccessClaims
  callerRef: string
  /**
   * Internal mcp-host bootstrap binding.  This is deliberately separate from
   * the workload selector: the first ordered target must be the same provider
   * and model that the recipe-bound host was configured with.  The check keeps
   * CRD/admin policy drift from reaching the credential broker.
   */
  bootstrapProvider?: string
  bootstrapModel?: string
  model?: string
  provider?: string
  targetRef?: string
  modelPolicyRef?: string
  purpose: string
  idempotencyKey: string
  /** Canonical request payload — hashed for idempotency conflict detection. */
  payload: unknown
  correlationId?: string
}

export interface AuthorizedPromptBridge {
  /**
   * Per-grant output ceiling. Enforced as `max_tokens` on API-key providers;
   * codex-subscription cannot bind it on the ChatGPT wire and is bounded by
   * the contract's structural LIMITS.maxOutputTokens instead.
   */
  maxOutputTokens: number | null
  invocationId: string
  /** True when this idempotency key already produced an invocation. */
  replay: boolean
  /** Whether this response won authorization for a provider execution. */
  providerCallRequired: boolean
  status: string
  model: string | null
  modelPolicy: PluginWorkloadSdkModelPolicy | null
  /** Operator-selected attempt; credentialSlot is an identity, never a value. */
  selectedTarget: PluginWorkloadSdkPromptTarget
  /** Selected target plus its strictly ordered authorized fallback suffix. */
  authorizedTargets: PluginWorkloadSdkPromptTarget[]
  /** Fencing token for this physical provider attempt. */
  attemptGeneration: number
  policyRevision: number
  policyHash: string
}

type PromptTargetResolution =
  | { ok: true; selectedIndex: number; modelPolicy: PluginWorkloadSdkModelPolicy | null }
  | { ok: false; error: PluginWorkloadSdkAuthzError }

/**
 * Pure selector resolution. It deliberately runs before idempotency/audit,
 * quotas and all credential/provider seams so a denied selector cannot probe
 * which credentials happen to exist in the environment.
 */
function resolvePromptTarget(
  grant: PluginWorkloadSdkGrant,
  params: AuthorizePromptBridgeParams
): PromptTargetResolution {
  if (
    grant.promptTargets.length === 0 ||
    !grant.defaultTargetRef ||
    grant.promptTargets[0]?.targetRef !== grant.defaultTargetRef ||
    grant.policyRevision < 1
  ) {
    return {
      ok: false,
      error: deny(
        'provider_policy_denied',
        'promptBridge grant has no reviewed ordered target policy; migrate and re-save it'
      ),
    }
  }

  // The HTTP parser rejects provider-only selectors, but the authorizer is
  // also called by internal mcp-host paths and tests. Keep the invariant at
  // the authority boundary so a provider cannot implicitly choose its first
  // model/credential slot.
  if (
    params.provider !== undefined &&
    params.model === undefined &&
    params.targetRef === undefined &&
    params.modelPolicyRef === undefined
  ) {
    return {
      ok: false,
      error: deny(
        'provider_policy_denied',
        'provider requires model, targetRef, or modelPolicyRef'
      ),
    }
  }

  let candidates: Array<{ target: PluginWorkloadSdkPromptTarget; index: number }> =
    grant.promptTargets.map((target, index) => ({ target, index }))
  let modelPolicy: PluginWorkloadSdkModelPolicy | null = null
  if (params.modelPolicyRef !== undefined) {
    modelPolicy = grant.modelPolicies[params.modelPolicyRef] ?? null
    if (!modelPolicy) {
      return {
        ok: false,
        error: deny(
          'provider_policy_denied',
          'modelPolicyRef does not resolve to this grant policy'
        ),
      }
    }
    if (
      (params.model !== undefined && params.model !== modelPolicy.model) ||
      (params.provider !== undefined && params.provider !== modelPolicy.provider)
    ) {
      return {
        ok: false,
        error: deny('provider_policy_denied', 'selector does not match modelPolicyRef'),
      }
    }
    // A policy ref and target ref are two names for the same concrete target,
    // not independent selectors.  Intersect them explicitly: otherwise the
    // policy-ref branch would silently ignore targetRef and authorize a target
    // different from the caller's declared intent.
    if (params.targetRef !== undefined) {
      const target = candidates.find(candidate => candidate.target.targetRef === params.targetRef)
      if (
        !target ||
        target.target.provider !== modelPolicy.provider ||
        target.target.model !== modelPolicy.model
      ) {
        return {
          ok: false,
          error: deny('provider_policy_denied', 'targetRef does not match modelPolicyRef'),
        }
      }
      candidates = [target]
    }
    candidates = candidates.filter(
      candidate =>
        candidate.target.provider === modelPolicy!.provider &&
        candidate.target.model === modelPolicy!.model
    )
  } else if (params.targetRef !== undefined) {
    candidates = candidates.filter(candidate => candidate.target.targetRef === params.targetRef)
    if (
      candidates.length === 1 &&
      ((params.model !== undefined && params.model !== candidates[0]!.target.model) ||
        (params.provider !== undefined && params.provider !== candidates[0]!.target.provider))
    ) {
      return {
        ok: false,
        error: deny('provider_policy_denied', 'selector fields are inconsistent'),
      }
    }
  } else if (params.provider !== undefined || params.model !== undefined) {
    candidates = candidates.filter(
      candidate =>
        (params.provider === undefined || candidate.target.provider === params.provider) &&
        (params.model === undefined || candidate.target.model === params.model)
    )
  } else {
    return { ok: true, selectedIndex: 0, modelPolicy: null }
  }

  if (candidates.length === 0) {
    return {
      ok: false,
      error: deny('target_not_allowed', 'requested target is not authorized by this grant'),
    }
  }
  // A bare model has no provider authority. Exact target/provider+model and
  // policy refs are necessarily unambiguous by their grammar.
  if (
    params.modelPolicyRef === undefined &&
    params.targetRef === undefined &&
    params.provider === undefined &&
    params.model !== undefined &&
    candidates.length > 1
  ) {
    return {
      ok: false,
      error: deny('ambiguous_model', 'model is authorized by multiple providers; select a target'),
    }
  }
  return { ok: true, selectedIndex: candidates[0]!.index, modelPolicy }
}

export async function authorizePromptBridge(
  params: AuthorizePromptBridgeParams
): Promise<PluginWorkloadSdkAuthzResult<AuthorizedPromptBridge>> {
  const result = await authorizePromptBridgeInner(params)
  pluginWorkloadSdkAuthDecisionsTotal.inc(
    {
      recipe: `${params.claims.recipeNamespace}/${params.claims.recipeName}`,
      method: 'promptBridge',
      decision: result.ok ? 'authorized' : result.error,
    },
    1
  )
  return result
}

async function authorizePromptBridgeInner(
  params: AuthorizePromptBridgeParams
): Promise<PluginWorkloadSdkAuthzResult<AuthorizedPromptBridge>> {
  const { claims, callerRef } = params
  const scopeError = checkScope(claims)
  if (scopeError) return scopeError

  const grant = await findGrant(claims.recipeNamespace, claims.recipeName, 'promptBridge')
  if (!grant) {
    return deny('capability_not_declared', 'recipe has no promptBridge grant')
  }

  if (
    grant.policyState !== 'active' ||
    grant.policyRevision < 1 ||
    grant.policyReviewProvenancePresent === false
  ) {
    return deny(
      'provider_policy_denied',
      'promptBridge grant requires an explicit operator-reviewed target policy'
    )
  }

  const callerError = checkCaller(grant, callerRef)
  if (callerError) return callerError

  // The mcp-host is configured once by WRC with spec.agent.  promptBridge may
  // fall back across the operator's ordered targets, but its primary target
  // must remain that same bootstrap binding.  Reject drift before selector
  // resolution, audit, quota, or credential-ticket issuance.
  if (params.bootstrapProvider !== undefined || params.bootstrapModel !== undefined) {
    const bootstrapProvider = params.bootstrapProvider?.trim() ?? ''
    const bootstrapModel = params.bootstrapModel?.trim() ?? ''
    const primaryTarget = grant.promptTargets[0]
    if (
      !bootstrapProvider ||
      !bootstrapModel ||
      !primaryTarget ||
      primaryTarget.provider !== bootstrapProvider ||
      primaryTarget.model !== bootstrapModel
    ) {
      return deny(
        'provider_policy_denied',
        'promptBridge default target does not match the mcp-host bootstrap binding'
      )
    }
  }

  const resolution = resolvePromptTarget(grant, params)
  if (!resolution.ok) return resolution.error
  const selectedTarget = grant.promptTargets[resolution.selectedIndex]!
  // A grant may list many targets for operator choice, but one logical
  // invocation must never fan out across an unbounded suffix. The hard cap is
  // independent of the persisted allowlist size and applies to every retry.
  const authorizedTargets = grant.promptTargets.slice(
    resolution.selectedIndex,
    resolution.selectedIndex + MAX_PROMPT_BRIDGE_PROVIDER_ATTEMPTS
  )
  const resolvedPolicyHash = hashPromptTargetPolicy(grant)

  const recorded = await recordInvocation({
    recipeNamespace: claims.recipeNamespace,
    recipeName: claims.recipeName,
    callerRef,
    correlationId: params.correlationId,
    method: 'promptBridge',
    detail: selectedTarget.model,
    purpose: params.purpose,
    idempotencyKey: params.idempotencyKey,
    payload: params.payload,
    status: 'in_progress',
    authorizationDecision: 'authorized',
    promptAuthorization: {
      policyRevision: grant.policyRevision,
      policyHash: resolvedPolicyHash,
      authorizedTargetRefs: authorizedTargets.map(target => target.targetRef),
    },
    requiredGrantStates: ['active'],
  })
  if (recorded.kind === 'policy_revoked') {
    return deny(
      'provider_policy_denied',
      'promptBridge policy was revoked before invocation reservation'
    )
  }
  if (recorded.kind === 'conflict') {
    return deny('idempotency_conflict', 'idempotency key was already used with a different payload')
  }
  if (recorded.kind === 'race_unresolved') {
    // Idempotency race could not be resolved (winner pruned mid-flight).
    // Retryable: a fresh attempt will reserve the key cleanly.
    return deny(
      'idempotency_conflict',
      'idempotency key reservation could not be resolved; retry with a fresh key',
      true
    )
  }
  // Non-failed replays short-circuit before rate limits (the original invocation
  // already counted against limits and reserved quota).
  if (recorded.kind === 'replay' && recorded.invocation.status !== 'failed') {
    return {
      ok: true,
      value: {
        invocationId: recorded.invocation.id,
        replay: true,
        providerCallRequired: false,
        status: recorded.invocation.status,
        model: selectedTarget.model,
        modelPolicy: resolution.modelPolicy,
        selectedTarget,
        authorizedTargets,
        attemptGeneration: recorded.invocation.attemptGeneration,
        policyRevision: grant.policyRevision,
        policyHash: resolvedPolicyHash,
        maxOutputTokens: grant.quotaLimits.maxOutputTokens ?? null,
      },
    }
  }

  // A failed idempotency record may be retried, but only under the exact
  // policy snapshot that created it. Compare before charging quota, then use
  // a conditional status transition so concurrent retries cannot both win.
  let providerCallRequired = true
  if (recorded.kind === 'replay') {
    const snapshot = recorded.invocation.promptAuthorization
    const currentTargetRefs = authorizedTargets.map(target => target.targetRef)
    const sameTargetRefs =
      snapshot?.authorizedTargetRefs.length === currentTargetRefs.length &&
      snapshot.authorizedTargetRefs.every((ref, index) => ref === currentTargetRefs[index])
    if (
      !snapshot ||
      snapshot.policyRevision !== grant.policyRevision ||
      snapshot.policyHash !== resolvedPolicyHash ||
      !sameTargetRefs
    ) {
      return deny(
        'idempotency_conflict',
        'idempotency key belongs to an older promptBridge policy; retry with a new idempotency key'
      )
    }
    const revivedGeneration = await reviveFailedSdkInvocation({
      invocationId: recorded.invocation.id,
      recipeNamespace: claims.recipeNamespace,
      recipeName: claims.recipeName,
    })
    if (revivedGeneration === null) {
      return deny(
        'idempotency_conflict',
        'idempotent retry is already being handled; use a new idempotency key if it fails again',
        true
      )
    }
    recorded.invocation.attemptGeneration = revivedGeneration
  }

  const statusBinding = {
    recipeNamespace: claims.recipeNamespace,
    recipeName: claims.recipeName,
    ...(recorded.kind === 'replay'
      ? {
          expectedCurrentStatus: 'in_progress' as const,
          expectedAttemptGeneration: recorded.invocation.attemptGeneration,
        }
      : { expectedAttemptGeneration: recorded.invocation.attemptGeneration }),
  }
  const transitionToFailed = async (): Promise<void> => {
    await markInvocationStatus(recorded.invocation.id, 'failed', statusBinding)
  }

  // The retry CAS happens before rate/quota checks. Any exception after that
  // claim must release it; otherwise the maintenance sweep can fail an active
  // retry (and make its JIT ticket appear invalid) while the caller is still
  // handling the error.
  try {
    const rate = await checkRateLimit(
      claims.recipeNamespace,
      claims.recipeName,
      'promptBridge',
      grant
    )
    if (!rate.ok) {
      await transitionToFailed()
      return deny(rate.error, rate.message)
    }
    // The former per-run quota leg (consumeQuota) was deleted here (issue
    // #348): deprecated per-run caps are ignored; only the per-minute
    // platform rate limit above gates the invocation.
  } catch (error) {
    try {
      await transitionToFailed()
    } catch {
      // Preserve the original rate/quota/database error. The maintenance
      // sweep remains the final recovery path if the compensating update also
      // fails.
    }
    throw error
  }

  return {
    ok: true,
    value: {
      invocationId: recorded.invocation.id,
      replay: recorded.kind === 'replay',
      providerCallRequired,
      status: recorded.kind === 'replay' ? 'in_progress' : recorded.invocation.status,
      model: selectedTarget.model,
      modelPolicy: resolution.modelPolicy,
      selectedTarget,
      authorizedTargets,
      attemptGeneration: recorded.invocation.attemptGeneration,
      policyRevision: grant.policyRevision,
      policyHash: resolvedPolicyHash,
      maxOutputTokens: grant.quotaLimits.maxOutputTokens ?? null,
    },
  }
}

export interface ReissuePromptBridgeCredentialTicketParams {
  claims: McpHostAccessClaims
  invocationId: string
  targetRef: string
  attemptGeneration: number
}

export type ReissuedPromptBridgeCredentialTicket = {
  invocationId: string
  targetRef: string
  attemptGeneration: number
  providerAttemptId: string
  providerAttemptIndex: number
  credentialTicket: string
  reservationOnly?: true
  policyRevision: number
  policyHash: string
  expiresInSeconds: number
}

/**
 * Mints one short-lived ticket immediately before a fallback attempt. The
 * target is accepted only when it was in the original, persisted suffix and
 * the live policy still has exactly that revision/hash and caller authority.
 * This route accepts no credential slot, model, provider, or caller from the
 * workload, so it cannot turn a fallback request into a selector bypass.
 */
export async function reissuePromptBridgeCredentialTicket(
  params: ReissuePromptBridgeCredentialTicketParams
): Promise<PluginWorkloadSdkAuthzResult<ReissuedPromptBridgeCredentialTicket>> {
  const scopeError = checkScope(params.claims)
  if (scopeError) return scopeError

  const invocation = await getInvocationById(params.invocationId)
  if (
    !invocation ||
    invocation.recipeNamespace !== params.claims.recipeNamespace ||
    invocation.recipeName !== params.claims.recipeName ||
    invocation.method !== 'promptBridge' ||
    invocation.status !== 'in_progress' ||
    invocation.attemptGeneration !== params.attemptGeneration ||
    invocation.authorizationDecision !== 'authorized' ||
    !invocation.promptAuthorization
  ) {
    return deny(
      'provider_policy_denied',
      'promptBridge invocation is not eligible for ticket reissue'
    )
  }

  const authorization = invocation.promptAuthorization
  const receipt = await getPluginWorkloadSdkAttemptReceipt(invocation.id, params.attemptGeneration)
  if (
    !receipt ||
    receipt.recipeNamespace !== params.claims.recipeNamespace ||
    receipt.recipeName !== params.claims.recipeName ||
    receipt.method !== 'promptBridge' ||
    receipt.status !== 'in_progress'
  ) {
    return deny('provider_policy_denied', 'promptBridge attempt receipt is stale or missing')
  }
  if (!authorization.authorizedTargetRefs.includes(params.targetRef)) {
    return deny('target_not_allowed', 'target was not authorized for this invocation')
  }

  const grant = await findGrant(
    params.claims.recipeNamespace,
    params.claims.recipeName,
    'promptBridge'
  )
  const callerError = grant ? checkCaller(grant, invocation.callerRef) : null
  if (
    !grant ||
    grant.policyState !== 'active' ||
    grant.policyRevision < 1 ||
    grant.policyReviewProvenancePresent === false ||
    callerError
  ) {
    return deny(
      'provider_policy_denied',
      'promptBridge policy no longer authorizes this invocation'
    )
  }
  const policyHash = hashPromptTargetPolicy(grant)
  if (
    grant.policyRevision !== authorization.policyRevision ||
    policyHash !== authorization.policyHash
  ) {
    return deny(
      'provider_policy_denied',
      'promptBridge policy changed after the original authorization'
    )
  }
  const target = grant.promptTargets.find(candidate => candidate.targetRef === params.targetRef)
  if (!target) {
    return deny('target_not_allowed', 'target is not in the current promptBridge policy')
  }

  const reservationOnly =
    isLlmProviderId(target.provider) && PROVIDER_AUTH_MODE[target.provider] === 'oauth-broker'
  // An oauth-broker target is redeemable only through the broker
  // binding the WRC installs for the grant's default target. Any other broker
  // target would be reserved here and then die in execution with no credential
  // to redeem, after the reservation already charged the attempt budget. Deny
  // before reserving, and fail closed when the grant has no default target.
  if (reservationOnly && target.targetRef !== grant.defaultTargetRef) {
    return deny(
      'target_not_allowed',
      'oauth-broker fallback is authorized only for the default target of this grant'
    )
  }

  const providerAttempt = await reservePluginWorkloadSdkProviderAttempt({
    invocationId: invocation.id,
    recipeNamespace: params.claims.recipeNamespace,
    recipeName: params.claims.recipeName,
    attemptGeneration: invocation.attemptGeneration,
    target,
  })
  if (!providerAttempt) {
    return deny(
      'provider_policy_denied',
      'promptBridge attempt is stale, fenced, or exceeds the physical-attempt budget'
    )
  }

  if (reservationOnly) {
    return {
      ok: true,
      value: {
        invocationId: invocation.id,
        targetRef: target.targetRef,
        attemptGeneration: invocation.attemptGeneration,
        providerAttemptId: providerAttempt.id,
        providerAttemptIndex: providerAttempt.attemptIndex,
        credentialTicket: '',
        reservationOnly: true,
        policyRevision: grant.policyRevision,
        policyHash,
        expiresInSeconds: PLUGIN_SDK_CREDENTIAL_TICKET_TTL_SECONDS,
      },
    }
  }

  const issued = issuePluginWorkloadSdkCredentialTicketWithClaims({
    recipeNamespace: params.claims.recipeNamespace,
    recipeName: params.claims.recipeName,
    invocationId: invocation.id,
    target,
    providerAttemptId: providerAttempt.id,
    providerAttemptIndex: providerAttempt.attemptIndex,
    attemptGeneration: invocation.attemptGeneration,
    policyRevision: grant.policyRevision,
    policyHash,
  })
  const registered = await registerPluginWorkloadSdkCredentialTicketJti({
    jti: issued.claims.jti,
    recipeNamespace: params.claims.recipeNamespace,
    recipeName: params.claims.recipeName,
    invocationId: invocation.id,
    targetRef: target.targetRef,
    attemptGeneration: invocation.attemptGeneration,
    providerAttemptId: providerAttempt.id,
    expiresAt: new Date(Date.now() + PLUGIN_SDK_CREDENTIAL_TICKET_TTL_SECONDS * 1_000),
  })
  if (!registered) {
    await markPluginWorkloadSdkProviderAttemptStatus({
      id: providerAttempt.id,
      invocationId: invocation.id,
      recipeNamespace: params.claims.recipeNamespace,
      recipeName: params.claims.recipeName,
      attemptGeneration: invocation.attemptGeneration,
      status: 'failed',
    })
    return deny(
      'provider_unavailable',
      'credential ticket issuance failed after reserving a provider attempt; retry is not safe for this attempt'
    )
  }
  return {
    ok: true,
    value: {
      invocationId: invocation.id,
      targetRef: target.targetRef,
      attemptGeneration: invocation.attemptGeneration,
      providerAttemptId: providerAttempt.id,
      providerAttemptIndex: providerAttempt.attemptIndex,
      credentialTicket: issued.credentialTicket,
      policyRevision: grant.policyRevision,
      policyHash,
      expiresInSeconds: PLUGIN_SDK_CREDENTIAL_TICKET_TTL_SECONDS,
    },
  }
}

// ─── clientNotifications ─────────────────────────────────────────────────

export interface AuthorizeClientNotificationParams {
  claims: McpHostAccessClaims
  callerRef: string
  eventType: string
  targetRef?: string
  userRef?: string
  idempotencyKey: string
  /** Canonical request payload — hashed for idempotency conflict detection. */
  payload: unknown
  correlationId?: string
}

export interface AuthorizedClientNotification {
  notificationId: string
  replay: boolean
  status: string
}

export async function authorizeClientNotification(
  params: AuthorizeClientNotificationParams
): Promise<PluginWorkloadSdkAuthzResult<AuthorizedClientNotification>> {
  const result = await authorizeClientNotificationInner(params)
  pluginWorkloadSdkAuthDecisionsTotal.inc(
    {
      recipe: `${params.claims.recipeNamespace}/${params.claims.recipeName}`,
      method: 'clientNotifications',
      decision: result.ok ? 'authorized' : result.error,
    },
    1
  )
  return result
}

async function authorizeClientNotificationInner(
  params: AuthorizeClientNotificationParams
): Promise<PluginWorkloadSdkAuthzResult<AuthorizedClientNotification>> {
  const { claims, callerRef } = params
  const scopeError = checkScope(claims)
  if (scopeError) return scopeError

  const grant = await findGrant(claims.recipeNamespace, claims.recipeName, 'clientNotifications')
  if (!grant) {
    return deny('capability_not_declared', 'recipe has no clientNotifications grant')
  }
  if (
    !isClientNotificationsPolicyReady(grant) ||
    !(await hasUsableClientNotificationRecipients(grant))
  ) {
    return deny(
      'provider_policy_denied',
      'clientNotifications policy is not active or has no authorized recipient'
    )
  }

  const callerError = checkCaller(grant, callerRef)
  if (callerError) return callerError

  if (!grant.allowedEventTypes.includes(params.eventType)) {
    return deny(
      'event_type_not_allowed',
      `event type "${params.eventType}" is not in the grant's allowedEventTypes`
    )
  }

  if (params.targetRef !== undefined) {
    if (!grant.allowedTargetRefs.includes(params.targetRef)) {
      return deny(
        'target_not_allowed',
        `target "${params.targetRef}" is not in the grant's allowedTargetRefs`
      )
    }
  }
  if (params.userRef !== undefined && !grant.allowedUserRefs.includes(params.userRef)) {
    return deny('target_not_allowed', 'grant does not allow userRef targets')
  }

  const recorded = await recordInvocation({
    recipeNamespace: claims.recipeNamespace,
    recipeName: claims.recipeName,
    callerRef,
    correlationId: params.correlationId,
    method: 'clientNotifications',
    detail: params.eventType,
    idempotencyKey: params.idempotencyKey,
    payload: params.payload,
    status: 'accepted',
    authorizationDecision: 'authorized',
    requiredGrantStates: ['active'],
  })
  if (recorded.kind === 'policy_revoked') {
    return deny(
      'provider_policy_denied',
      'clientNotifications policy was revoked before invocation reservation'
    )
  }
  if (recorded.kind === 'conflict') {
    return deny('idempotency_conflict', 'idempotency key was already used with a different payload')
  }
  if (recorded.kind === 'race_unresolved') {
    // Idempotency race could not be resolved (winner pruned mid-flight).
    // Retryable: a fresh attempt will reserve the key cleanly.
    return deny(
      'idempotency_conflict',
      'idempotency key reservation could not be resolved; retry with a fresh key',
      true
    )
  }
  // Non-failed replays short-circuit before rate limits (the original invocation
  // already counted against limits and reserved quota).
  if (recorded.kind === 'replay' && recorded.invocation.status !== 'failed') {
    return {
      ok: true,
      value: {
        notificationId: recorded.invocation.id,
        replay: true,
        status: recorded.invocation.status,
      },
    }
  }

  const rate = await checkRateLimit(
    claims.recipeNamespace,
    claims.recipeName,
    'clientNotifications',
    grant,
    { eventType: params.eventType }
  )
  if (!rate.ok) {
    await markInvocationStatus(recorded.invocation.id, 'failed', {
      recipeNamespace: claims.recipeNamespace,
      recipeName: claims.recipeName,
    })
    return deny(rate.error, rate.message)
  }

  // The former per-run quota leg (consumeQuota) was deleted here (issue
  // #348): deprecated per-run caps are ignored; only the per-minute platform
  // rate limit above gates the notification.

  // Revive a previously-failed invocation that has now passed the rate limit.
  if (recorded.kind === 'replay') {
    await markInvocationStatus(recorded.invocation.id, 'accepted', {
      recipeNamespace: claims.recipeNamespace,
      recipeName: claims.recipeName,
    })
  }

  return {
    ok: true,
    value: {
      notificationId: recorded.invocation.id,
      replay: recorded.kind === 'replay',
      status: recorded.kind === 'replay' ? 'accepted' : recorded.invocation.status,
    },
  }
}

// ─── clientNotifications recipient listing (read-only) ───────────────────
// Surfaces the grant's allowedUserRefs so a recipe's sandbox UI can render a
// recipient picker from the authoritative source (the grant) instead of a
// recipe-baked env list. Read-only: it runs the same scope → grant → caller
// gate as a notification send, but consumes NO control-api grant quota, takes
// NO control-api grant rate-limit slot, and writes NO audit row — listing the
// allowlist is idempotent and must not erode the send budget. The SDK server
// still applies its generic per-workload HTTP rate limit before this authorizer
// is reached.

export interface AuthorizeListRecipientsParams {
  claims: McpHostAccessClaims
  callerRef: string
}

export interface AuthorizedRecipientList {
  allowedUserRefs: string[]
}

export async function authorizeListRecipients(
  params: AuthorizeListRecipientsParams
): Promise<PluginWorkloadSdkAuthzResult<AuthorizedRecipientList>> {
  const result = await authorizeListRecipientsInner(params)
  pluginWorkloadSdkAuthDecisionsTotal.inc(
    {
      recipe: `${params.claims.recipeNamespace}/${params.claims.recipeName}`,
      method: 'listRecipients',
      decision: result.ok ? 'authorized' : result.error,
    },
    1
  )
  return result
}

async function authorizeListRecipientsInner(
  params: AuthorizeListRecipientsParams
): Promise<PluginWorkloadSdkAuthzResult<AuthorizedRecipientList>> {
  const { claims, callerRef } = params
  const scopeError = checkScope(claims)
  if (scopeError) return scopeError

  const grant = await findGrant(claims.recipeNamespace, claims.recipeName, 'clientNotifications')
  if (!grant) {
    return deny('capability_not_declared', 'recipe has no clientNotifications grant')
  }
  if (
    !isClientNotificationsPolicyReady(grant) ||
    !(await hasUsableClientNotificationRecipients(grant))
  ) {
    return deny(
      'provider_policy_denied',
      'clientNotifications policy is not active or has no authorized recipient'
    )
  }

  const callerError = checkCaller(grant, callerRef)
  if (callerError) return callerError

  return { ok: true, value: { allowedUserRefs: grant.allowedUserRefs } }
}
