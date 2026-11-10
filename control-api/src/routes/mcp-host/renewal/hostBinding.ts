import { config } from '../../../config.js'
import type { K8sGateway } from '../../../k8s.js'
import { isK8sResourceNotFound } from '../../../services/access/mcpInvocable.js'
import {
  HCC_STANDALONE_RECIPE_NAME,
  MCP_HOST_CREDENTIAL_CAPABILITY,
  type McpHostRefreshClaims,
} from '../../../utils/auth/mcpHostJwtToken.js'

export type RenewalHostGateway = Pick<K8sGateway, 'getResource'>

export type RenewalHostBinding =
  | { kind: 'ok'; hccCredential?: { hostUid: string } }
  | {
      kind: 'denied'
      reason: 'hcc_lineage_without_audience' | 'host_not_found' | 'host_uid_mismatch'
    }
  | { kind: 'unavailable' }

/**
 * Decide whether a verified (not yet consumed) refresh token may be rotated.
 *
 * Only the HCC lineage is bound to a live Host: workflow-recipe chains have no
 * Host. A Host deleted and recreated under the same name gets a new uid, so a
 * chain minted for the old Host stops renewing. Only existence and uid are
 * checked, not deletionTimestamp: a Host being torn down keeps its workflow
 * credential until it is gone.
 */
export async function resolveRenewalHostBinding(
  gateway: RenewalHostGateway,
  claims: McpHostRefreshClaims
): Promise<RenewalHostBinding> {
  const hccQualified = claims.mcpCapabilities.includes(MCP_HOST_CREDENTIAL_CAPABILITY)
  if (!hccQualified) {
    // A hosts-namespace standalone chain without the HCC audience predates
    // host_uid; renewing it would mint a control token that can never be bound
    // to a Host. HCC re-issues such Hosts on contract change.
    if (
      claims.recipeNamespace === config.hostsNamespace &&
      claims.recipeName === HCC_STANDALONE_RECIPE_NAME
    ) {
      return { kind: 'denied', reason: 'hcc_lineage_without_audience' }
    }
    return { kind: 'ok' }
  }

  // validateClaims guarantees host_uid and a single bare Host name on this lineage.
  const hostUid = claims.host_uid as string
  let host: { metadata?: { uid?: unknown } }
  try {
    // Namespace is explicit: without it the gateway falls back to a cluster-wide list.
    host = (await gateway.getResource('hosts', claims.hostRefs[0], config.hostsNamespace)) as {
      metadata?: { uid?: unknown }
    }
  } catch (err) {
    if (isK8sResourceNotFound(err)) return { kind: 'denied', reason: 'host_not_found' }
    return { kind: 'unavailable' }
  }
  if (host?.metadata?.uid !== hostUid) return { kind: 'denied', reason: 'host_uid_mismatch' }
  return { kind: 'ok', hccCredential: { hostUid } }
}
