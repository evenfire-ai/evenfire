/**
 * Route-layer helpers for provisioning the platform image-pull Secret: "does this recipe
 * need the credential?" and "how does a provisioning failure become a response?".
 *
 * Shared, not duplicated, because two route modules write WorkflowRecipe CRDs whose
 * workloads WRC will inject the pull-secret reference into — the registry install path
 * (`registry.ts`) and the generic recipe CRUD path (`recipes.ts`). Both must decide the
 * same way and fail the same way; a second copy of either rule would let one route persist
 * a recipe the other would have refused.
 */
import { config } from '../../config.js'
import { extractK8sError } from '../../http/k8sError.js'
import { RegistryProxyError } from '../../services/registryClient.js'
import { PullSecretProvisionError } from '../../services/registryPullSecretService.js'
import { isPlatformRegistryImage } from './registryImagePullSecret.js'

/**
 * True when any workload in a recipe spec runs an image hosted on our own registry, and
 * therefore needs the platform pull credential.
 *
 * Uses the same shared predicate WRC applies at reconcile time
 * (`isPlatformRegistryImage`), so control-api cannot decide to provision for a workload
 * WRC will not attach the secret to, or vice versa — that mismatch would surface as an
 * ImagePullBackOff with no failing request to attribute it to.
 */
export function recipeReferencesPlatformImage(recipeSpec: Record<string, unknown>): boolean {
  const workloads = recipeSpec.workloads
  if (!Array.isArray(workloads)) return false
  return workloads.some(w =>
    isPlatformRegistryImage((w as { image?: unknown } | null)?.image, config.registryUrl)
  )
}

/**
 * Map an image-pull-secret provisioning failure onto an actionable HTTP response.
 *
 * The three classes are meaningfully different to an operator, and collapsing them all to
 * a bare 500 (as a generic K8s-error mapping does — `extractK8sError` cannot read
 * `RegistryProxyError.status`) makes a deploy-ordering or connect-flow problem look like a
 * control-api bug:
 *   - PullSecretProvisionError → a precondition the operator can fix (wrong namespace,
 *     registry not connected, org not yet bound); carries its own status + reason code.
 *   - RegistryProxyError       → the registry rejected us (e.g. 403 because the
 *     pull-credential endpoint has not been upgraded, or this client lacks
 *     `registry:manage-keys`); surfaced as 502 with the upstream status.
 *   - anything else            → 500.
 */
export function pullSecretErrorResponse(err: unknown): {
  status: number
  body: Record<string, unknown>
} {
  if (err instanceof PullSecretProvisionError) {
    return {
      status: err.status,
      body: {
        error: 'registry_pull_secret_provision_failed',
        reason: err.reason,
        detail: err.message,
      },
    }
  }
  if (err instanceof RegistryProxyError) {
    return {
      status: 502,
      body: {
        error: 'registry_pull_secret_provision_failed',
        reason: 'registry_rejected',
        upstreamStatus: err.status,
        detail: `the registry rejected the image-pull credential request (${err.status}); confirm the registry supports tenant pull-credential minting and that this deployment holds registry:manage-keys`,
      },
    }
  }
  const k8sErr = extractK8sError(err)
  return {
    status: 500,
    body: {
      error: 'registry_pull_secret_provision_failed',
      reason: 'unexpected_error',
      detail: k8sErr?.message || (err instanceof Error ? err.message : 'unknown error'),
    },
  }
}
