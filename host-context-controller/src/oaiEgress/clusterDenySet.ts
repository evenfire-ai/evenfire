import { ipv4ToInt } from '@clerum/egress-policy'
import { config } from '../config'

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
  const cidrs = [
    ...config.k8sApiCidrs,
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
