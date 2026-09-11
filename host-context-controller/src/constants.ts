export const MANAGED_BY_LABEL = 'clerum.io/managed-by'
export const MANAGED_BY_VALUE = 'host-context-controller'
// Reserved for explicit WRC-owned resource checks when HCC needs to distinguish
// WRC-labeled runtimes from unlabeled/user-owned resources.
export const WRC_MANAGED_BY_VALUE = 'workflow-recipes'
export const MCPSERVER_LABEL = 'clerum.io/mcpserver'
// Per-CR label stamped on the LlmHook workload's NetworkPolicy for traceability.
export const LLMHOOK_LABEL = 'clerum.io/llmhook'
// Pod-key label on the shared LlmHook Deployment/Service/NetworkPolicy. All
// hooks that hash to the same pod key co-locate on the pod named from this key
// and are reference-counted by it for label-owned GC (guardrails phase-4 §3).
export const HOOK_PODKEY_LABEL = 'clerum.io/hook-pod-key'
export const POLICY_TYPE_LABEL = 'clerum.io/policy-type'
export const RECIPE_LABEL = 'clerum.io/recipe'
export const HOST_LABEL = 'clerum.io/host'
export const INFRA_POLICY_TYPE = 'infrastructure'
export const EXTERNAL_EGRESS_POLICY_TYPE = 'external-egress'

// ─── Stateless heartbeat lifecycle reasons (Stage 3) ────────────────────────
/** status.lifecycle.reason written when the D8 idle gate suspends a Host. */
export const LIFECYCLE_REASON_SUSPENDED_IDLE = 'idle'
/** Prefix for status.lifecycle.reason naming the D8 condition blocking suspension. */
export const SUSPEND_BLOCKED_REASON_PREFIX = 'SuspendBlocked: '
/**
 * True for lifecycle reasons owned by the stateless heartbeat tracker. The
 * host reconciler preserves these across accepted-lifecycle re-assessments so
 * a reconcile-loop status write does not erase the tracker's published state.
 */
export function isHeartbeatManagedLifecycleReason(reason: string | undefined): reason is string {
  return (
    reason === LIFECYCLE_REASON_SUSPENDED_IDLE ||
    (reason !== undefined && reason.startsWith(SUSPEND_BLOCKED_REASON_PREFIX))
  )
}
