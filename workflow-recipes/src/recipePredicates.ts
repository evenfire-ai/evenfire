/**
 * Pure, dependency-light predicates over a WorkflowRecipe CRD, shared by the
 * k8sClient timers and the cadence policy (issue #1016). Kept free of
 * k8sClient / reconciler imports so `reconcileCadence.ts` can use them without
 * an import cycle. `k8sClient.ts` re-exports these names unchanged.
 */
import { parseClusterLocalFqdn } from './reconciler/resourceBuilder'
import type { WorkflowRecipeCRD } from './types'

export const TRANSPORT_NETWORK_CONDITION_TYPE = 'TransportExternalEgressReady'

export function hasPendingTransportNetworkReadiness(recipe: WorkflowRecipeCRD): boolean {
  return (
    recipe.status?.conditions?.some(
      condition =>
        condition.type === TRANSPORT_NETWORK_CONDITION_TYPE && condition.status !== 'True'
    ) ?? false
  )
}

const MIN_RUNTIME_CREDENTIAL_REFRESH_INTERVAL_MS = 5_000
const MAX_RUNTIME_CREDENTIAL_REFRESH_INTERVAL_MS = 30_000

// issue #375: how long a published Plugin Workload SDK `verifiedAt` may age
// before a steady-state reconcile refreshes it, even when every semantic field
// is unchanged. `verifiedAt` is recomputed on every bootstrap-proof parse, so
// without a throttle a fresh timestamp each pass would patch on every reconcile
// (≤30s) and spin a MODIFIED→reconcile loop. 5 min keeps the liveness signal
// current while capping steady-state churn at ≤1 patch / 5 min per recipe.
export const VERIFIED_AT_REFRESH_MS = 5 * 60_000

export function runtimeCredentialRefreshIntervalMs(config: {
  runtimeTokenRefreshBeforeSeconds: number
}): number {
  return Math.max(
    MIN_RUNTIME_CREDENTIAL_REFRESH_INTERVAL_MS,
    Math.min(
      MAX_RUNTIME_CREDENTIAL_REFRESH_INTERVAL_MS,
      Math.floor((config.runtimeTokenRefreshBeforeSeconds * 1_000) / 4)
    )
  )
}

export function workflowNeedsRuntimeCredentialRefresh(recipe: WorkflowRecipeCRD): boolean {
  const isWorkflow = (recipe.spec.steps ?? []).length > 0
  if (!isWorkflow || recipe.metadata.deletionTimestamp) return false

  const workflowPhase = recipe.status?.workflowExecution?.phase
  return (
    workflowPhase === 'initializing' ||
    workflowPhase === 'running' ||
    workflowPhase === 'recovering'
  )
}

export function workflowNeedsInfrastructureReconcile(recipe: WorkflowRecipeCRD): boolean {
  const isWorkflow = (recipe.spec.steps ?? []).length > 0
  if (recipe.metadata.deletionTimestamp) return false
  const workflowPhase = recipe.status?.workflowExecution?.phase
  // Restore the retry after a process restart, including stepless stdio recipes
  // whose egress is exclusively HCC-owned. Pod readiness is not admission proof.
  if (
    hasPendingTransportNetworkReadiness(recipe) &&
    !['failed', 'deprecated', 'rollback-failed'].includes(recipe.status?.phase ?? '') &&
    !['completed', 'failed', 'cancelled'].includes(workflowPhase ?? '')
  )
    return true

  // SDK-only recipes are deliberately stepless, but their eager mcp-host and
  // bootstrap proof still need the full reconciler lane. The generic workload
  // status-refresh path cannot represent that proof and would overwrite a
  // validated SDK capability with BootstrapNotReady while leaving phase=active.
  // Keep this level-triggered retry independent from workflowExecution.
  if (!isWorkflow && recipe.spec.pluginWorkloadSdk) return true
  if (!isWorkflow) return false

  if (workflowPhase === 'initializing' || workflowPhase === 'recovering') return true

  // Plugin Workload SDK eager path: the recipe sits in phase=active with no run
  // (workflowExecution cleared), but the WRC must keep reconciling so the eager
  // mcp-host stays alive (recreated after any pod death — restartPolicy: Never)
  // and, for promptBridge, its provider gets (re-)configured once Ready. Both
  // families (promptBridge AND clientNotifications-only) run the always-on eager
  // SDK mcp-host, so both must re-trigger. The reconcile + /configure are
  // idempotent, so a periodic level-triggered retry is safe. Without this, a
  // clientNotifications-only eager mcp-host whose pod dies is never recreated
  // until an unrelated spec edit, and promptBridge stays provider_unavailable.
  if (recipe.spec.pluginWorkloadSdk && workflowPhase === undefined) return true

  return false
}

export function workflowNeedsWorkloadStatusRefresh(recipe: WorkflowRecipeCRD): boolean {
  if (recipe.metadata.deletionTimestamp) return false
  if ((recipe.spec.steps ?? []).length > 0) return false
  // SDK-only recipes have capability state (including the eager bootstrap
  // proof) that is owned by the full reconciler. A status-only workload read
  // has no proof to carry and would corrupt the persisted SDK projection.
  if (recipe.spec.pluginWorkloadSdk) return false
  if ((recipe.spec.workloads ?? []).length === 0) return false

  return recipe.status?.phase === 'active' || recipe.status?.phase === 'degraded'
}

/**
 * Issue #637 — does this recipe project any name-based Secret (`envSecret` or
 * `imagePullSecrets`) that the ownership gate must keep re-validating? Used as a
 * periodic backstop: the SecretWatcher is the fast, event-driven revocation path,
 * but a deterministic re-classification every refresh interval guarantees a Secret
 * re-labeled foreign in ANY of the three runtime namespaces is revoked even if a
 * watch event was delayed or coalesced.
 */
export function recipeReferencesNamedSecrets(recipe: WorkflowRecipeCRD): boolean {
  return (recipe.spec.workloads ?? []).some(
    w => Boolean(w.envSecret?.name) || (w.imagePullSecrets?.length ?? 0) > 0
  )
}

/**
 * issue #299 §3.2/§5 — does this recipe declare at least one exact-host EXTERNAL
 * egress target that the WRC accumulator folds into a sliding-window policy?
 *
 * Two accumulator-driven sources qualify:
 *  - `spec.ui.egress.external[]` — sandbox-ui external FQDNs (always exact-host).
 *  - a NON-transport workload's `egressBindings[]` whose `dns` is an external FQDN
 *    (i.e. NOT `<svc>.<ns>.svc.cluster.local`). Validation guarantees non-transport
 *    workloads use exact-host egress, so any external-FQDN binding here is
 *    exact-host. The UI workload's own bindings are skipped (its egress is declared
 *    via `spec.ui.egress`, and the reconciler's workload loop skips it too).
 *
 * Transport-workload egress is intentionally EXCLUDED: it is delegated to HCC via
 * the McpServer CRD, not folded by this accumulator, so re-enqueueing on its
 * account would do no accumulator work.
 *
 * The predicate is pure and cheap (no DNS, no apiserver) so the refresh timer can
 * filter the cached recipe set synchronously each tick.
 */
export function recipeHasExternalExactHostEgress(recipe: WorkflowRecipeCRD): boolean {
  if (recipe.metadata.deletionTimestamp) return false
  if ((recipe.spec.ui?.egress?.external ?? []).length > 0) return true

  const uiWorkloadId = recipe.spec.ui?.workloadRef
  return (recipe.spec.workloads ?? []).some(workload => {
    if (workload.transport) return false
    if (uiWorkloadId && workload.id === uiWorkloadId) return false
    return (workload.egressBindings ?? []).some(
      binding =>
        Boolean(binding.dns) &&
        binding.port != null &&
        parseClusterLocalFqdn(binding.dns as string) === null
    )
  })
}
