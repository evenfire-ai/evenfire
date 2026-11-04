import type { K8sGateway } from '../k8s.js'
import type { Logger } from '../observability/logger.js'
import type { SecretPreconditions } from '../types.js'
import { SecretReadError, readSecretOrNull } from './secretRead.js'
import {
  isControlApiManagedSecret,
  isRecipeOwnedSecret,
  secretIdentityPreconditions,
} from './secretRepository.js'

export type SecretCleanupCapture =
  | { status: 'ready'; name: string; precondition: SecretPreconditions }
  | { status: 'read-failed'; name: string; error: SecretReadError }
  | {
      status: 'absent' | 'recipe-owned' | 'not-managed' | 'identity-unavailable'
      name: string
    }

/**
 * Snapshot a dependent Secret's identity so its later delete is bound to this exact
 * object: a same-name Secret written afterwards is a different owner's.
 * `requireManagedOwnership` guards derived names (`${name}-oauth-client`) that OAuth
 * reference mode lets an operator Secret share — uid/RV proves same object, not same
 * owner, so only a Secret labelled as created by control-api's install saga qualifies.
 *
 * Only a 404 is `absent`. Any other apiserver or transport failure is
 * `read-failed` and carries the SecretReadError (502/503), so a caller that
 * must not continue can throw it; an error that is not an apiserver failure is
 * rethrown.
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
    raw = await readSecretOrNull(gateway, secretName, namespace)
  } catch (err) {
    if (!(err instanceof SecretReadError)) throw err
    logger.error(
      {
        secretName,
        namespace,
        upstreamStatus: err.upstreamStatus,
        upstreamReason: err.upstreamReason,
      },
      'Secret cleanup capture failed'
    )
    return { status: 'read-failed', name: secretName, error: err }
  }
  if (raw === null) return { status: 'absent', name: secretName }
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
