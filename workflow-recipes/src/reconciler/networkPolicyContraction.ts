import type * as k8s from '@kubernetes/client-node'

type Rule = k8s.V1NetworkPolicyEgressRule & k8s.V1NetworkPolicyIngressRule
type PeerKey = 'to' | '_from'

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)])
    )
  }
  return value
}

function signature(value: unknown): string {
  return JSON.stringify(canonical(value))
}

function uniqueRules(rules: Rule[]): Rule[] {
  return [...new Map(rules.map(rule => [signature(rule), rule])).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, rule]) => rule)
}

/** Split only the OR lists; namespaceSelector + podSelector stay one AND peer.
 * Empty/missing inner lists mean unrestricted, unlike empty top-level rules.
 * Keep all other fields when comparing; an unknown restriction must not vanish.
 */
function splitRules(rules: Rule[] | undefined, peerKey: PeerKey): Rule[] {
  return uniqueRules(
    (rules ?? []).flatMap(rule => {
      const peers = rule[peerKey]?.length ? rule[peerKey]! : [undefined]
      const ports = rule.ports?.length ? rule.ports : [undefined]
      return peers.flatMap(peer =>
        ports.map(port => ({
          ...rule,
          [peerKey]: peer ? [peer] : undefined,
          ports: port ? [{ ...port, protocol: port.protocol ?? 'TCP' }] : undefined,
        }))
      )
    })
  )
}

export function effectivePolicyTypes(spec: k8s.V1NetworkPolicySpec | undefined): string[] {
  return [
    ...(spec?.policyTypes?.length
      ? spec.policyTypes
      : ['Ingress', ...(spec?.egress?.length ? ['Egress'] : [])]),
  ].sort()
}

/** Normalize Kubernetes omitempty only at the rule-list boundary. Nested empty
 * peers/ports have different semantics and are handled by splitRules instead.
 */
export function networkPolicySpecSignature(policy: k8s.V1NetworkPolicy): string {
  return signature({
    ...policy.spec,
    podSelector: policy.spec?.podSelector ?? {},
    policyTypes: effectivePolicyTypes(policy.spec),
    egress: splitRules(policy.spec?.egress, 'to'),
    ingress: splitRules(policy.spec?.ingress, '_from'),
  })
}

function supportedRule(rule: Rule, peerKey: PeerKey): boolean {
  return (
    Object.entries(rule).every(
      ([key, value]) => value === undefined || key === peerKey || key === 'ports'
    ) &&
    (rule.ports ?? []).every(port =>
      Object.entries(port).every(
        ([key, value]) =>
          value === undefined || key === 'port' || key === 'protocol' || key === 'endPort'
      )
    )
  )
}

/** Intersection of the finite rule shapes emitted by WRC. Peers are matched as
 * whole conjunctions; ports preserve protocol and endPort. Unrestricted live
 * dimensions can be narrowed to current intent, never the reverse. Unrecognized
 * fields cannot prove a retained permission and are deliberately not copied.
 */
export function intersectNetworkPolicyRules(
  existing: Rule[] | undefined,
  desired: Rule[] | undefined,
  peerKey: PeerKey
): Rule[] {
  const liveRules = splitRules(existing, peerKey).filter(rule => supportedRule(rule, peerKey))
  const desiredRules = splitRules(desired, peerKey).filter(rule => supportedRule(rule, peerKey))
  const retained: Rule[] = []
  for (const wanted of desiredRules) {
    for (const live of liveRules) {
      const wantedPeer = wanted[peerKey]?.[0]
      const livePeer = live[peerKey]?.[0]
      if (wantedPeer && livePeer && signature(wantedPeer) !== signature(livePeer)) continue
      const wantedPort = wanted.ports?.[0]
      const livePort = live.ports?.[0]
      if (wantedPort && livePort) {
        if (wantedPort.protocol !== livePort.protocol) continue
        if (
          wantedPort.port !== undefined &&
          livePort.port !== undefined &&
          signature(wantedPort) !== signature(livePort)
        )
          continue
        // endPort is never discarded to pretend an unsupported range is all ports.
        if (
          (wantedPort.endPort !== undefined && wantedPort.port === undefined) ||
          (livePort.endPort !== undefined && livePort.port === undefined)
        )
          continue
      }
      const peer = wantedPeer ?? livePeer
      const port = wantedPort?.port !== undefined ? wantedPort : (livePort ?? wantedPort)
      retained.push({
        [peerKey]: peer ? [peer] : undefined,
        ports: port ? [port] : undefined,
      })
    }
  }
  return uniqueRules(retained)
}
