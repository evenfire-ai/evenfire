/**
 * Issue #1016 — fingerprint of the inputs the reconcile branch guards read
 * (see `reconcileInternal` in workflowRecipeReconciler.ts: the limit/policy/latch
 * block, the four workflow short-circuits, and the classic non-deployable guard).
 * A DNS-block record is replayed only while the fingerprint matches; any change
 * forces one full reconcile, which re-records.
 *
 * `metadata.generation` covers every `spec` change, so only non-spec inputs and
 * the guards' derived predicates are listed beyond it.
 */
import { hasPendingTransportNetworkReadiness } from '../recipePredicates'
import type { WorkflowRecipeCRD } from '../types'

// clerum.io/workflow-run-id: read by `workflowAwaitsTriggeredRun`. A label edit
// does not bump the generation, so it must be fingerprinted explicitly.
const WORKFLOW_RUN_ID_LABEL = 'clerum.io/workflow-run-id'

export function dnsBlockFingerprint(
  recipe: WorkflowRecipeCRD,
  config: { pluginWorkloadSdkEnabled?: boolean }
): string {
  const status = recipe.status
  const exec = status?.workflowExecution
  const workloads = status?.workloads ?? []
  // latchedBySharedMcpInternalDependencyBoundary
  const sharedMcpBoundaryLatch =
    status?.conditions?.some(
      condition =>
        condition.type === 'InternalDependenciesReady' &&
        condition.status === 'False' &&
        condition.reason === 'InvalidInternalDependency' &&
        typeof condition.message === 'string' &&
        condition.message.includes('.mcp-server.svc.cluster.local') &&
        condition.message.includes('not an eligible runtime Service')
    ) ?? false
  return JSON.stringify([
    recipe.metadata.generation ?? null,
    status?.phase ?? null,
    status?.message ?? null,
    exec?.phase ?? null,
    exec?.message ?? null,
    recipe.metadata.labels?.[WORKFLOW_RUN_ID_LABEL]?.trim() ?? null,
    Boolean(recipe.spec.pluginWorkloadSdk),
    Boolean(status?.pluginWorkloadSdk),
    Boolean(config.pluginWorkloadSdkEnabled),
    hasPendingTransportNetworkReadiness(recipe),
    sharedMcpBoundaryLatch,
    // latchedDespiteHealthyWorkloads: non-empty observed set, all ready
    workloads.length > 0 && workloads.every(w => w.ready === true),
  ])
}
