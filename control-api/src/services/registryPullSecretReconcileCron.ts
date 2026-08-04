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
 * The LEVEL carries that distinction, because "swallow it" and "hide it" are not the same
 * thing. A known precondition on an unconnected cluster logs below warn; anything
 * unexpected, or a known precondition that has held for many consecutive ticks and is
 * therefore no longer plausibly transient, warns. See EXPECTED_PRECONDITION_REASONS.
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
 * Precondition failures that are a NORMAL state for a cluster, not a fault: the registry
 * connect flow has not been completed, or the registry has not bound this deployment to an
 * org yet. Both resolve themselves the moment an operator finishes the flow.
 *
 * They are the two reasons `ensureInner` raises before it touches anything, and this loop
 * runs on every cluster whether or not anyone has asked it to — so warning on them means 144
 * warnings a day (at the 10-minute default) on a cluster where nothing is wrong, which
 * teaches operators to ignore this logger.
 */
const EXPECTED_PRECONDITION_REASONS: ReadonlySet<string> = new Set([
  'registry_not_connected',
  'org_unresolved',
])

/**
 * How many consecutive ticks an expected precondition may hold before it stops being
 * "expected" and warns. ~1h at the default interval — long enough to cover a connect flow in
 * progress, short enough that a cluster genuinely stuck this way is findable by an operator
 * grepping for warnings rather than silently unable to install private plugins.
 */
const PRECONDITION_WARN_AFTER_TICKS = 6

let consecutiveExpectedFailures = 0

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
    // A completed pass means whatever was blocking is gone. The streak has to reset with it,
    // or one bad hour makes every later blip look persistent.
    consecutiveExpectedFailures = 0
    return true
  } catch (err) {
    // Never thrown, always logged — but not always at the same level. The level is the whole
    // difference between "this cluster has not been connected yet", which is normal and
    // recurs on a timer, and "something is wrong", which an operator has to find.
    const reason = (err as { reason?: string })?.reason
    const expected = reason !== undefined && EXPECTED_PRECONDITION_REASONS.has(reason)
    consecutiveExpectedFailures = expected ? consecutiveExpectedFailures + 1 : 0
    const persistent = consecutiveExpectedFailures >= PRECONDITION_WARN_AFTER_TICKS
    const payload = {
      event: 'registry_pull_secret_reconcile_skipped',
      reason,
      err: err instanceof Error ? err.message : String(err),
      ...(expected && { consecutiveTicks: consecutiveExpectedFailures }),
    }
    if (expected && !persistent) {
      log.debug(
        payload,
        'registry pull secret reconcile skipped a known precondition; will retry on the next tick'
      )
    } else if (expected) {
      log.warn(
        payload,
        'registry pull secret reconcile has been blocked on the same precondition for many ticks; private plugin installs cannot provision their pull credential until it clears'
      )
    } else {
      log.warn(
        payload,
        'registry pull secret reconcile did not complete; will retry on the next tick'
      )
    }
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
  // Before the early return: a stopped loop has no history, so a later start must not
  // inherit a stale streak and warn on its first tick.
  consecutiveExpectedFailures = 0
  if (!intervalHandle) return
  clearInterval(intervalHandle)
  intervalHandle = null
}
