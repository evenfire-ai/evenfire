import type { K8sGateway } from '../k8s.js'
import { extractK8sStatus } from './resourceServiceHelpers.js'

/**
 * Key NAMES held by a Secret. Never returns values: callers use this to decide
 * whether a provider is configured, and a value has no place in that decision
 * or in any response derived from it.
 *
 * A missing Secret is "no keys" (an absent Secret and an empty one are the same
 * answer to this question). Any other read failure rethrows, so callers fail
 * closed rather than silently treating an RBAC denial as "no credentials".
 *
 * Status extraction goes through `extractK8sStatus` rather than a bare
 * `.statusCode` check: the real `@kubernetes/client-node` `ApiException` (what
 * `gateway.getSecret` actually throws) sets `.code`, not `.statusCode` — a bare
 * `.statusCode` check would never match a genuine 404 and every missing Secret
 * would rethrow instead of resolving to "no keys".
 */
export async function secretKeyNames(
  gateway: K8sGateway,
  name: string,
  namespace: string
): Promise<string[]> {
  try {
    const secret = (await gateway.getSecret(name, namespace)) as { data?: Record<string, unknown> }
    return Object.keys(secret?.data || {}).sort((a, b) => a.localeCompare(b))
  } catch (error) {
    if (extractK8sStatus(error) === 404) return []
    throw error
  }
}
