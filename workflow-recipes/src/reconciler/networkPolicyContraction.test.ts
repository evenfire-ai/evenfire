import { describe, expect, it } from 'vitest'
import type * as k8s from '@kubernetes/client-node'
import { intersectNetworkPolicyRules, networkPolicySpecSignature } from './networkPolicyContraction'

const peer = {
  namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'sandbox-ui' } },
  podSelector: { matchLabels: { 'clerum.io/recipe': 'one' } },
}
const ingress = (ports: number[]): k8s.V1NetworkPolicyIngressRule[] => [
  {
    _from: [peer],
    ports: ports.map(port => ({ port, protocol: 'TCP' })),
  },
]
const policy = (rules?: k8s.V1NetworkPolicyIngressRule[]): k8s.V1NetworkPolicy => ({
  spec: {
    podSelector: { matchLabels: { app: 'backend' } },
    policyTypes: ['Ingress'],
    ...(rules ? { ingress: rules } : {}),
  },
})

describe('WRC NetworkPolicy permission contraction', () => {
  it('compares API-omitted empty top-level lists as equivalent', () => {
    expect(networkPolicySpecSignature(policy())).toBe(networkPolicySpecSignature(policy([])))
  })

  it('compares grouped, split, duplicated and reordered permissions as equivalent', () => {
    expect(networkPolicySpecSignature(policy(ingress([8080, 9090])))).toBe(
      networkPolicySpecSignature(policy([...ingress([9090]), ...ingress([8080, 8080])]))
    )
  })

  it('preserves the namespace-and-pod conjunction while splitting peer alternatives', () => {
    const other = {
      namespaceSelector: peer.namespaceSelector,
      podSelector: { matchLabels: { 'clerum.io/recipe': 'two' } },
    }
    const result = intersectNetworkPolicyRules(
      [{ _from: [peer, other], ports: [{ port: 8080 }] }],
      ingress([8080]),
      '_from'
    )
    expect(result).toEqual(ingress([8080]))
    expect(result[0]._from).toEqual([peer])
    expect(
      intersectNetworkPolicyRules(
        [
          {
            _from: [
              { namespaceSelector: peer.namespaceSelector },
              { podSelector: peer.podSelector },
            ],
            ports: [{ port: 8080 }],
          },
        ],
        ingress([8080]),
        '_from'
      )
    ).toEqual([])
  })

  it('keeps TCP defaulting while rejecting different protocols', () => {
    expect(
      intersectNetworkPolicyRules(
        [{ _from: [peer], ports: [{ port: 8080 }] }],
        ingress([8080]),
        '_from'
      )
    ).toEqual(ingress([8080]))
    expect(
      intersectNetworkPolicyRules(
        [{ _from: [peer], ports: [{ port: 8080, protocol: 'UDP' }] }],
        ingress([8080]),
        '_from'
      )
    ).toEqual([])
  })

  it('does not equate inner omitted peers or ports to a deny rule', () => {
    expect(networkPolicySpecSignature(policy([{}]))).not.toBe(
      networkPolicySpecSignature(policy([]))
    )
    expect(networkPolicySpecSignature(policy([{ _from: [peer] }]))).not.toBe(
      networkPolicySpecSignature(policy(ingress([8080])))
    )
    expect(intersectNetworkPolicyRules([{}], ingress([8080]), '_from')).toEqual(ingress([8080]))
    expect(intersectNetworkPolicyRules(ingress([8080]), [{}], '_from')).toEqual(ingress([8080]))
  })

  it('does not ignore an IP exception or an endPort restriction', () => {
    const wanted = [
      { to: [{ ipBlock: { cidr: '8.8.8.0/24' } }], ports: [{ port: 443, protocol: 'TCP' }] },
    ]
    expect(
      intersectNetworkPolicyRules(
        [{ ...wanted[0], to: [{ ipBlock: { cidr: '8.8.8.0/24', except: ['8.8.8.8/32'] } }] }],
        wanted,
        'to'
      )
    ).toEqual([])
    expect(
      intersectNetworkPolicyRules(
        [{ ...wanted[0], ports: [{ port: 443, endPort: 444, protocol: 'TCP' }] }],
        wanted,
        'to'
      )
    ).toEqual([])
  })

  it('cannot prove an unknown rule restriction by dropping it', () => {
    const unknown = { ...ingress([8080])[0], futureRestriction: true }
    expect(intersectNetworkPolicyRules([unknown], ingress([8080]), '_from')).toEqual([])
    expect(networkPolicySpecSignature(policy([unknown]))).not.toBe(
      networkPolicySpecSignature(policy(ingress([8080])))
    )
  })

  it('preserves selectors and effective isolation types in equivalence checks', () => {
    expect(networkPolicySpecSignature(policy())).not.toBe(
      networkPolicySpecSignature({ spec: { ...policy().spec!, podSelector: {} } })
    )
    expect(networkPolicySpecSignature(policy())).not.toBe(
      networkPolicySpecSignature({ spec: { ...policy().spec!, policyTypes: ['Egress'] } })
    )
  })
})
