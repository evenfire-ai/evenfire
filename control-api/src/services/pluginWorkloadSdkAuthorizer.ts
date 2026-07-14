import { pluginWorkloadSdkAuthDecisionsTotal } from '../observability/metrics.js'
import type { McpHostAccessClaims } from '../utils/auth/mcpHostJwtToken.js'
import {
  type PluginWorkloadSdkErrorCode,
  type PluginWorkloadSdkGrant,
  type PluginWorkloadSdkModelPolicy,
  findGrant,
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
  model?: string
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
  maxOutputTokens: number | null
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

  // Model policy resolution (plan §2.2): a modelPolicyRef is never a black
  // box — it must resolve to a concrete record on the grant.
  let modelPolicy: PluginWorkloadSdkModelPolicy | null = null
  if (params.modelPolicyRef !== undefined) {
    modelPolicy = grant.modelPolicies[params.modelPolicyRef] ?? null
    if (!modelPolicy) {
      return deny(
        'provider_policy_denied',
        `modelPolicyRef "${params.modelPolicyRef}" does not resolve to a model policy record`
      )
    }
    if (params.model !== undefined && params.model !== modelPolicy.model) {
      return deny(
        'provider_policy_denied',
        `model "${params.model}" does not match modelPolicyRef "${params.modelPolicyRef}"`
      )
    }
  }

  const requestedModel = modelPolicy?.model ?? params.model ?? null
  if (grant.allowedModels.length === 0) {
    return deny('provider_policy_denied', 'grant has no allowedModels configured for promptBridge')
  }
  if (requestedModel === null) {
    return deny(
      'provider_policy_denied',
      'promptBridge requests must provide a model or a modelPolicyRef that resolves to one'
    )
  }
  if (!grant.allowedModels.includes(requestedModel)) {
    return deny(
      'provider_policy_denied',
      `model "${requestedModel}" is not in the grant's allowedModels`
    )
  }

  const recorded = await recordInvocation({
    recipeNamespace: claims.recipeNamespace,
    recipeName: claims.recipeName,
    callerRef,
    correlationId: params.correlationId,
    method: 'promptBridge',
    detail: requestedModel ?? 'provider-default',
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
        model: requestedModel,
        modelPolicy,
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
      model: requestedModel,
      modelPolicy,
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
