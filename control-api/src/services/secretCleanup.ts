import { extractK8sError } from '../http/k8sError.js'
import type { K8sGateway } from '../k8s.js'
import type { Logger } from '../observability/logger.js'
import type { SecretPreconditions } from '../types.js'
import {
  isControlApiManagedSecret,
  isRecipeOwnedSecret,
  secretIdentityPreconditions,
} from './secretRepository.js'

export type SecretCleanupCapture =
  | { status: 'ready'; name: string; precondition: SecretPreconditions }
  | {
      status: 'absent' | 'recipe-owned' | 'not-managed' | 'identity-unavailable' | 'read-failed'
      name: string
    }

/**
 * Snapshot a dependent Secret's identity so its later delete is bound to this exact
 * object: a same-name Secret written afterwards is a different owner's.
 * `requireManagedOwnership` guards derived names (`${name}-oauth-client`) that OAuth
 * reference mode lets an operator Secret share — uid/RV proves same object, not same
 * owner, so only a Secret labelled as created by control-api's install saga qualifies.
 */
export async function captureSecretForCleanup(
  gateway: Pick<K8sGateway, 'getSecret'>,
  secretName: string,
  namespace: string,
  logger: Logger,
  { requireManagedOwnership = false }: { requireManagedOwnership?: boolean } = {}
): Promise<SecretCleanupCapture> {
  let raw: unknown
  try {
    raw = await gateway.getSecret(secretName, namespace)
  } catch (err) {
    if (extractK8sError(err)?.status === 404) return { status: 'absent', name: secretName }
    logger.error({ secretName, namespace, err }, 'Secret cleanup capture failed')
    return { status: 'read-failed', name: secretName }
  }
  // Recipe-owned Secrets belong to /admin/recipe-secrets, whose guard a cascade
  // delete here would route around.
  if (isRecipeOwnedSecret(raw)) return { status: 'recipe-owned', name: secretName }
  if (requireManagedOwnership && !isControlApiManagedSecret(raw)) {
    return { status: 'not-managed', name: secretName }
  }
  const precondition = secretIdentityPreconditions(raw)
  if (!precondition) return { status: 'identity-unavailable', name: secretName }
  return { status: 'ready', name: secretName, precondition }
}
