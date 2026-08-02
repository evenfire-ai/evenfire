import {
  type InsertInvocationResult,
  type PluginWorkloadSdkFamily,
  type PluginWorkloadSdkInvocationStatus,
  type PluginWorkloadSdkPromptAuthorization,
  hashIdempotencyKey,
  hashPayload,
  insertInvocation,
  updateInvocationStatus,
} from './pluginWorkloadSdkDb.js'

// ─── Plugin Workload SDK — invocation auditor (plan §2.4) ────────────────
// Records every invocation with: invocation id, recipe binding, caller ref,
// correlation id, method family, event/purpose type, idempotency key hash,
// timestamps, quota + authorization decisions, and status transitions
// (in_progress → complete | failed | provider_unavailable).
//
// Exclusion guarantee (spec §16): this module accepts ONLY the whitelisted
// fields below — provider keys, bearer tokens, raw contact identifiers,
// prompt contents, and raw provider payloads structurally cannot reach the
// audit table. Payloads enter exclusively as SHA-256 hashes (RFC 8785-style
// canonicalization via stableStringify).

export interface RecordInvocationParams {
  recipeNamespace: string
  recipeName: string
  callerRef: string
  correlationId?: string
  method: PluginWorkloadSdkFamily
  /** Model name (promptBridge) or event type (clientNotifications). */
  detail: string
  purpose?: string
  /** Raw idempotency key — hashed before storage, never persisted. */
  idempotencyKey: string
  /** Request payload — hashed for idempotency conflict detection, never persisted. */
  payload: unknown
  status: PluginWorkloadSdkInvocationStatus
  authorizationDecision: string
  promptAuthorization?: PluginWorkloadSdkPromptAuthorization
}

export async function recordInvocation(
  params: RecordInvocationParams
): Promise<InsertInvocationResult> {
  return insertInvocation({
    recipeNamespace: params.recipeNamespace,
    recipeName: params.recipeName,
    callerRef: params.callerRef,
    correlationId: params.correlationId,
    method: params.method,
    detail: params.detail,
    purpose: params.purpose,
    idempotencyKeyHash: hashIdempotencyKey(params.idempotencyKey),
    payloadHash: hashPayload(params.payload),
    status: params.status,
    authorizationDecision: params.authorizationDecision,
    promptAuthorization: params.promptAuthorization,
  })
}

export async function markInvocationStatus(
  invocationId: string,
  status: PluginWorkloadSdkInvocationStatus,
  binding?: {
    recipeNamespace?: string
    recipeName?: string
    /** Optimistic guard: only transition when the row is in this status. */
    expectedCurrentStatus?: PluginWorkloadSdkInvocationStatus
  }
): Promise<boolean> {
  const terminal = status !== 'in_progress' && status !== 'accepted'
  return updateInvocationStatus(invocationId, status, {
    completed: terminal,
    recipeNamespace: binding?.recipeNamespace,
    recipeName: binding?.recipeName,
    expectedCurrentStatus: binding?.expectedCurrentStatus,
  })
}

/**
 * Closes the clientNotifications lifecycle by transitioning the invocation
 * accepted → delivered once its notification reaches a terminal 'sent' state
 * (desktop ACK or channel fallback). The invocation id equals the delivery's
 * payload notificationId (set in the authorizer), so callers pass that id here.
 *
 * Guarded to 'accepted' so it is idempotent across the desktop and channel
 * terminal paths and never clobbers a 'failed' invocation. Returns true only
 * when this call performed the transition. promptBridge invocations are never
 * passed here — 'delivered' is a clientNotifications-only terminal state.
 */
export async function markSdkNotificationDelivered(invocationId: string): Promise<boolean> {
  return markInvocationStatus(invocationId, 'delivered', { expectedCurrentStatus: 'accepted' })
}
