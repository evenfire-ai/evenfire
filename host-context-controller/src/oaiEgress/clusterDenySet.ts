import { ipv4ToInt } from '@clerum/egress-policy'
import { config } from '../config'

/**
 * The cluster-internal CIDR set the LAN classifier rejects a baseURL against,
 * plus whether the operator actually configured the guard.
 */
export type ClusterDenySet = { cidrs: string[]; guardConfigured: boolean }

/**
 * The cluster-internal CIDR set the LAN classifier rejects a baseURL against,
 * plus whether the operator actually configured the guard. `cidrs` unions every
 * source HCC knows — the apiserver CIDRs, the nodelocal DNS CIDR, the
 * operator-declared cluster-internal ranges — and a zero-config FLOOR: the
 * apiserver ClusterIP as a /32 from KUBERNETES_SERVICE_HOST (the same expression
 * the k8s-api egress NetworkPolicy uses). The floor is IPv4-only (an IPv6 or
 * malformed value yields no floor entry rather than a CIDR the classifier would
 * ignore). `guardConfigured` reflects ONLY the operator's explicit
 * clusterInternalEgressCidrs — the floor is a safety net, not evidence the guard
 * was set — so the fail-closed check still trips when only the floor is present.
 */
export function resolveClusterInternalCidrs(): ClusterDenySet {
  const floor: string[] = []
  const apiHost = process.env.KUBERNETES_SERVICE_HOST
  if (apiHost && ipv4ToInt(apiHost) !== null) floor.push(`${apiHost}/32`)
  const cidrs = [
    ...config.k8sApiCidrs,
    ...(config.nodeLocalDnsCidr ? [config.nodeLocalDnsCidr] : []),
    ...config.clusterInternalEgressCidrs,
    ...floor,
  ]
  return { cidrs, guardConfigured: config.clusterInternalEgressCidrs.length > 0 }
}
