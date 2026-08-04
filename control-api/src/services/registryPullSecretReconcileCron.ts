/**
 * Keeps the platform image-pull credential present as a STANDING INVARIANT, rather than
 * as a side effect of control-api's own install routes.
 *
 * Why this exists (see docs/architecture/registry-pull-secret-recipe-workloads.md §13.1):
 * the two halves of the feature have different triggers. WRC injects the
 * `evenfire-registry-pull` reference on every reconcile, for ANY WorkflowRecipe whose
 * workload image is ours — but control-api only provisions the Secret on its own
 * install/upgrade routes. A WorkflowRecipe has three documented creation paths
 * (docs/crds/workflowrecipe.md): control-api, `kubectl apply`, and the WRC `deploy_recipe`
 * MCP tool. For the latter two, control-api never sees the CRD, so without this loop the
 * pod would reference a credential nobody created.
 *
 * FAILURE SEMANTICS ARE DELIBERATELY DIFFERENT FROM THE INSTALL PATH.
 * An install THROWS on a precondition failure, because a user asked for something we
 * cannot deliver and must be told. This loop LOGS and retries on the next tick: a cluster
 * that has not finished the registry connect flow is in a normal, expected state, and must
 * not emit an error every interval or crash-loop. `ensureRegistryPullSecrets` already
 * distinguishes the two — legitimate no-ops return `skipped`, everything else throws — so
 * this file's only job is to swallow the throw and try again later.
 *
 * Serialization across replicas is handled inside the service by a per-org advisory lock.
 * That lock is what makes a PERIODIC loop safe at all: without it, two pods on a timer do
 * not race occasionally, they fight continuously — each pod's mint revokes the other's key
 * and the fingerprint check then sees divergence, forever.
 */
import type { K8sGateway } from '../k8s.js'
import { rootLogger } from '../observability/logger.js'
import {
  ensureRegistryPullSecrets,
  platformWorkloadNamespaces,
} from './registryPullSecretService.js'

const log = rootLogger.child({ service: 'registry_pull_secret_reconcile' })

/**
 * Run one reconcile pass. Never throws — a failure here is a logged warning, because the
 * cluster may legitimately not be ready to provision yet (no connect flow completed, no
 * org bound). Returns true when the pass completed without error.
 */
export async function reconcileRegistryPullSecret(gateway: K8sGateway): Promise<boolean> {
  try {
    // `required: []` — this loop needs no namespace on its own behalf. Unlike an install it
    // is not about to persist a CRD referencing one, so a namespace it cannot fill (or, on a
    // managed cluster, one the operator has not populated) is not ITS failure to report; the
    // install that actually lands there raises it, with the namespaces that caller needs.
    // Without this the loop would report a failed pass on every tick of a managed cluster,
    // where control-api legitimately has nothing to do. Conditions worth an operator's
    // attention are already logged by the service itself, on every pass.
    const results = await ensureRegistryPullSecrets(gateway, platformWorkloadNamespaces(), {
      required: [],
    })
    const changed = [...results.entries()].filter(([, r]) => r === 'created' || r === 'repaired')
    if (changed.length > 0) {
      log.info(
        {
          event: 'registry_pull_secret_reconciled',
          namespaces: changed.map(([ns]) => ns),
        },
        'provisioned the registry pull secret outside an install'
      )
    }
    return true
  } catch (err) {
    // Expected while a cluster is unconnected or has no org bound yet. Warn, do not throw:
    // this loop must not turn a normal pre-connect state into recurring errors.
    log.warn(
      {
        event: 'registry_pull_secret_reconcile_skipped',
        reason: (err as { reason?: string })?.reason,
        err: err instanceof Error ? err.message : String(err),
      },
      'registry pull secret reconcile did not complete; will retry on the next tick'
    )
    return false
  }
}

let intervalHandle: ReturnType<typeof setInterval> | null = null

export function startRegistryPullSecretReconcileCron(
  gateway: K8sGateway,
  intervalMs: number
): void {
  if (intervalHandle) return
  intervalHandle = setInterval(() => {
    void reconcileRegistryPullSecret(gateway)
  }, intervalMs)
  // Never hold the process open for this.
  intervalHandle.unref()
  log.info(
    { event: 'registry_pull_secret_reconcile_started', intervalMs },
    'registry pull secret reconcile cron started'
  )
}

export function stopRegistryPullSecretReconcileCron(): void {
  if (!intervalHandle) return
  clearInterval(intervalHandle)
  intervalHandle = null
}
