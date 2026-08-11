import { describe, expect, it } from 'vitest'
import type * as k8s from '@kubernetes/client-node'
import { egressSignature } from './workflowRecipeReconciler'

function policy(egress: unknown[]): k8s.V1NetworkPolicy {
  return { spec: { podSelector: {}, policyTypes: ['Egress'], egress } } as k8s.V1NetworkPolicy
}

describe('egressSignature (issue #299 audit H1/R2-1)', () => {
  it('is INSENSITIVE to key order (R2-1): {to,ports} == {ports,to}, ipBlock key order', () => {
    const a = policy([
      { to: [{ ipBlock: { cidr: '1.2.3.4/32' } }], ports: [{ protocol: 'TCP', port: 443 }] },
    ])
    const b = policy([
      { ports: [{ port: 443, protocol: 'TCP' }], to: [{ ipBlock: { cidr: '1.2.3.4/32' } }] },
    ])
    expect(egressSignature(a)).toBe(egressSignature(b))
  })

  it('DETECTS a change in a selector-based `to` rule (H1 regression: internal egress must not be blind)', () => {
    // Same external ipBlock + port; only the internal podSelector target changes.
    const backendA = policy([
      { to: [{ ipBlock: { cidr: '140.82.112.3/32' } }], ports: [{ protocol: 'TCP', port: 443 }] },
      {
        to: [{ podSelector: { matchLabels: { app: 'backend-a' } } }],
        ports: [{ protocol: 'TCP', port: 8080 }],
      },
    ])
    const backendB = policy([
      { to: [{ ipBlock: { cidr: '140.82.112.3/32' } }], ports: [{ protocol: 'TCP', port: 443 }] },
      {
        to: [{ podSelector: { matchLabels: { app: 'backend-b' } } }],
        ports: [{ protocol: 'TCP', port: 8080 }],
      },
    ])
    // The old tuple signature collapsed both selector rules to "||TCP:8080" → equal (the bug).
    expect(egressSignature(backendA)).not.toBe(egressSignature(backendB))
  })

  it('DETECTS a namespaceSelector change', () => {
    const a = policy([
      { to: [{ namespaceSelector: { matchLabels: { ns: 'a' } } }], ports: [{ port: 80 }] },
    ])
    const b = policy([
      { to: [{ namespaceSelector: { matchLabels: { ns: 'b' } } }], ports: [{ port: 80 }] },
    ])
    expect(egressSignature(a)).not.toBe(egressSignature(b))
  })

  it('DETECTS an ipBlock cidr change and is a no-op for identical content', () => {
    const a = policy([
      { to: [{ ipBlock: { cidr: '1.1.1.1/32' } }], ports: [{ protocol: 'TCP', port: 443 }] },
    ])
    const b = policy([
      { to: [{ ipBlock: { cidr: '2.2.2.2/32' } }], ports: [{ protocol: 'TCP', port: 443 }] },
    ])
    expect(egressSignature(a)).not.toBe(egressSignature(b))
    expect(egressSignature(a)).toBe(
      egressSignature(
        policy([
          { to: [{ ipBlock: { cidr: '1.1.1.1/32' } }], ports: [{ protocol: 'TCP', port: 443 }] },
        ])
      )
    )
  })

  it('handles empty/absent egress deterministically', () => {
    expect(egressSignature(policy([]))).toBe(
      egressSignature({ spec: { podSelector: {}, policyTypes: ['Egress'] } } as k8s.V1NetworkPolicy)
    )
  })

  // H-C: the signature must project the FULL managed enforcement spec, not just
  // spec.egress — a policy whose podSelector or policyTypes drifted out-of-band
  // (same destination rules) must be treated as changed so the reconcile re-owns
  // it, instead of leaving external egress applied to the wrong pods.
  const sameEgress = [
    { to: [{ ipBlock: { cidr: '1.2.3.4/32' } }], ports: [{ protocol: 'TCP', port: 443 }] },
  ]
  const withSpec = (podSelector: unknown, policyTypes: string[]): k8s.V1NetworkPolicy =>
    ({ spec: { podSelector, policyTypes, egress: sameEgress } }) as k8s.V1NetworkPolicy

  it('H-C: DETECTS a podSelector drift even when egress rules are identical', () => {
    expect(egressSignature(withSpec({ matchLabels: { app: 'scanner' } }, ['Egress']))).not.toBe(
      egressSignature(withSpec({ matchLabels: { app: 'attacker' } }, ['Egress']))
    )
  })

  it('H-C: DETECTS a policyTypes change even when egress rules are identical', () => {
    expect(egressSignature(withSpec({}, ['Egress']))).not.toBe(
      egressSignature(withSpec({}, ['Egress', 'Ingress']))
    )
  })

  it('H-C: policyTypes order does not matter (Egress,Ingress == Ingress,Egress)', () => {
    expect(egressSignature(withSpec({}, ['Egress', 'Ingress']))).toBe(
      egressSignature(withSpec({}, ['Ingress', 'Egress']))
    )
  })
})
