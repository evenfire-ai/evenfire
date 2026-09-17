import { ipv4ToInt, parseCidr } from '@clerum/egress-policy'
import { config } from '../config'
import { hccLogger } from '../logger'

const log = hccLogger.child({ module: 'oai-egress-cluster-deny-set' })

// A k8sApiCidrs entry we've already warned about being non-IPv4. resolveCluster-
// InternalCidrs() runs on every buildDesiredBrokers (each event, each resync,
// and the R5-M1 orphan-sweep re-check), so warn once per distinct entry instead
// of on every call.
const warnedNonIpv4ApiCidrs = new Set<string>()

/**
 * The cluster-internal CIDR set the LAN classifier rejects a baseURL against,
 * plus which mandatory guard categories the operator configured. Reported
 * separately so admission can name the right drop reason.
 */
export type ClusterDenySet = {
  cidrs: string[]
  /** The operator declared the pod + Service (cluster-internal) ranges. */
  internalConfigured: boolean
  /** The operator declared the node + control-plane ranges. */
  nodeConfigured: boolean
}

/**
 * The cluster-internal CIDR set the LAN classifier rejects a baseURL against,
 * plus which mandatory guard categories the operator configured. `cidrs` unions
 * every source HCC knows — the apiserver CIDRs, the nodelocal DNS CIDR, the
 * operator-declared cluster-internal (pod/Service) ranges, the node +
 * control-plane ranges — and a zero-config FLOOR: the apiserver ClusterIP as a
 * /32 from KUBERNETES_SERVICE_HOST (the same expression the k8s-api egress
 * NetworkPolicy uses). The floor is IPv4-only (an IPv6 or malformed value yields
 * no floor entry rather than a CIDR the classifier would ignore).
 *
 * `k8sApiCidrs` is a DUAL-USE list: it also drives the allow-k8s-api-egress
 * NetworkPolicies, whose ipBlock supports IPv6, so parseK8sApiCidrs admits IPv6
 * on purpose. The LAN classifier is IPv4-only, so only the IPv4 entries of
 * k8sApiCidrs enter this deny-set; an IPv6 entry is skipped (warn-once) and
 * feeds the NetworkPolicies alone. Without this filter one IPv6 entry makes
 * classifyLanBaseURL return cluster_cidr_invalid for EVERY baseURL, dropping all
 * brokers on a dual-stack cluster. The other sources are already IPv4 by their
 * parsers (nodeLocalDnsCidr/clusterInternal/clusterNode reject IPv6, the floor
 * is IPv4-only), so they are unioned unfiltered — filtering them too would hide
 * a parser bug instead of letting it fall through to the fail-closed belt.
 *
 * `internalConfigured`/`nodeConfigured` reflect ONLY the operator's explicit
 * lists — the floor is a safety net, not evidence a guard was set — so the
 * fail-closed check still trips when only the floor is present. The node
 * category exists because the pod/Service range does NOT cover a node IP (a
 * minikube node at 192.168.49.2 is RFC1918 and would classify as a plain LAN);
 * without it a broker could be pointed at kubelet/apiserver on the node.
 */
export function resolveClusterInternalCidrs(): ClusterDenySet {
  const floor: string[] = []
  const apiHost = process.env.KUBERNETES_SERVICE_HOST
  if (apiHost && ipv4ToInt(apiHost) !== null) floor.push(`${apiHost}/32`)
  // Take only the IPv4 entries of the dual-use k8sApiCidrs list — parseCidr is
  // the same predicate the classifier uses to flag cluster_cidr_invalid, so
  // there is no second definition of "valid" to drift.
  const apiCidrs = config.k8sApiCidrs.filter(cidr => {
    if (parseCidr(cidr) !== null) return true
    if (!warnedNonIpv4ApiCidrs.has(cidr)) {
      warnedNonIpv4ApiCidrs.add(cidr)
      log.warn(
        'CONTEXT_MAPPER_K8S_API_CIDRS entry is not an IPv4 CIDR — excluded from the openai-compatible broker deny-set (the LAN classifier is IPv4-only); it still feeds the allow-k8s-api-egress NetworkPolicies',
        { cidr }
      )
    }
    return false
  })
  const cidrs = [
    ...apiCidrs,
    ...(config.nodeLocalDnsCidr ? [config.nodeLocalDnsCidr] : []),
    ...config.clusterInternalEgressCidrs,
    ...config.clusterNodeEgressCidrs,
    ...floor,
  ]
  return {
    cidrs,
    internalConfigured: config.clusterInternalEgressCidrs.length > 0,
    nodeConfigured: config.clusterNodeEgressCidrs.length > 0,
  }
}
