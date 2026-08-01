import { pluginWorkloadSdkAuthDecisionsTotal } from '../observability/metrics.js'
import type { McpHostAccessClaims } from '../utils/auth/mcpHostJwtToken.js'
import { issuePluginWorkloadSdkCredentialTicket } from './pluginWorkloadSdkCredentialTicket.js'
import {
  type PluginWorkloadSdkErrorCode,
  type PluginWorkloadSdkGrant,
  type PluginWorkloadSdkModelPolicy,
  type PluginWorkloadSdkPromptTarget,
  findGrant,
  hashPromptTargetPolicy,
} from './pluginWorkloadSdkDb.js'
import { markInvocationStatus, recordInvocation } from './pluginWorkloadSdkInvocationAuditor.js'
import { checkRateLimit, consumeQuota } from './pluginWorkloadSdkQuotaTracker.js'

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
  invocationId: string
  /** True when this idempotency key already produced an invocation. */
  replay: boolean
  status: string
  model: string | null
  modelPolicy: PluginWorkloadSdkModelPolicy | null
  /** Operator-selected attempt; credentialSlot is an identity, never a value. */
  selectedTarget: PluginWorkloadSdkPromptTarget
  /** Selected target plus its strictly ordered authorized fallback suffix. */
  authorizedTargets: PluginWorkloadSdkPromptTarget[]
  policyRevision: number
  policyHash: string
  /** One short-lived signed authorization artifact per eligible target. */
  authorizedTargetTickets: Array<{ targetRef: string; credentialTicket: string }>
  maxOutputTokens: number | null
}

function issueTargetTickets(
  claims: McpHostAccessClaims,
  invocationId: string,
  targets: PluginWorkloadSdkPromptTarget[],
  policyRevision: number,
  policyHash: string
): Array<{ targetRef: string; credentialTicket: string }> {
  return targets.map(target => ({
    targetRef: target.targetRef,
    credentialTicket: issuePluginWorkloadSdkCredentialTicket({
      recipeNamespace: claims.recipeNamespace,
      recipeName: claims.recipeName,
      invocationId,
      target,
      policyRevision,
      policyHash,
    }),
  }))
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
  const authorizedTargets = grant.promptTargets.slice(resolution.selectedIndex)
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
  })
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
        status: recorded.invocation.status,
        model: selectedTarget.model,
        modelPolicy: resolution.modelPolicy,
        selectedTarget,
        authorizedTargets,
        policyRevision: grant.policyRevision,
        policyHash: resolvedPolicyHash,
        authorizedTargetTickets: issueTargetTickets(
          claims,
          recorded.invocation.id,
          authorizedTargets,
          grant.policyRevision,
          resolvedPolicyHash
        ),
        maxOutputTokens: grant.quotaLimits.maxOutputTokens ?? null,
      },
    }
  }

  const rate = await checkRateLimit(
    claims.recipeNamespace,
    claims.recipeName,
    'promptBridge',
    grant
  )
  if (!rate.ok) {
    await markInvocationStatus(recorded.invocation.id, 'failed', {
      recipeNamespace: claims.recipeNamespace,
      recipeName: claims.recipeName,
    })
    return deny(rate.error, rate.message)
  }

  const quota = await consumeQuota(claims.recipeNamespace, claims.recipeName, 'promptBridge', grant)
  if (!quota.ok) {
    await markInvocationStatus(recorded.invocation.id, 'failed', {
      recipeNamespace: claims.recipeNamespace,
      recipeName: claims.recipeName,
    })
    return deny(quota.error, quota.message)
  }

  // Revive a previously-failed invocation that has now passed quota.
  if (recorded.kind === 'replay') {
    await markInvocationStatus(recorded.invocation.id, 'in_progress', {
      recipeNamespace: claims.recipeNamespace,
      recipeName: claims.recipeName,
    })
  }

  return {
    ok: true,
    value: {
      invocationId: recorded.invocation.id,
      replay: recorded.kind === 'replay',
      status: recorded.kind === 'replay' ? 'in_progress' : recorded.invocation.status,
      model: selectedTarget.model,
      modelPolicy: resolution.modelPolicy,
      selectedTarget,
      authorizedTargets,
      policyRevision: grant.policyRevision,
      policyHash: resolvedPolicyHash,
      authorizedTargetTickets: issueTargetTickets(
        claims,
        recorded.invocation.id,
        authorizedTargets,
        grant.policyRevision,
        resolvedPolicyHash
      ),
      maxOutputTokens: grant.quotaLimits.maxOutputTokens ?? null,
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
  })
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

  const quota = await consumeQuota(
    claims.recipeNamespace,
    claims.recipeName,
    'clientNotifications',
    grant
  )
  if (!quota.ok) {
    await markInvocationStatus(recorded.invocation.id, 'failed', {
      recipeNamespace: claims.recipeNamespace,
      recipeName: claims.recipeName,
    })
    return deny(quota.error, quota.message)
  }

  // Revive a previously-failed invocation that has now passed quota.
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

  const callerError = checkCaller(grant, callerRef)
  if (callerError) return callerError

  return { ok: true, value: { allowedUserRefs: grant.allowedUserRefs } }
}
