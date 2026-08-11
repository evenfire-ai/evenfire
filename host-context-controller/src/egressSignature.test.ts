import { describe, expect, it } from 'vitest'
import type * as k8s from '@kubernetes/client-node'
import { egressSignature } from './networkPolicyReconciler'

function policy(egress: unknown[]): k8s.V1NetworkPolicy {
  return { spec: { podSelector: {}, policyTypes: ['Egress'], egress } } as k8s.V1NetworkPolicy
}

describe('egressSignature (issue #299 audit H1/R2-1)', () => {
  it('is INSENSITIVE to key order (R2-1)', () => {
    const a = policy([
      { to: [{ ipBlock: { cidr: '1.2.3.4/32' } }], ports: [{ protocol: 'TCP', port: 443 }] },
    ])
    const b = policy([
      { ports: [{ port: 443, protocol: 'TCP' }], to: [{ ipBlock: { cidr: '1.2.3.4/32' } }] },
    ])
    expect(egressSignature(a)).toBe(egressSignature(b))
  })

  it('DETECTS an ipBlock cidr change (no-op only for identical content)', () => {
    const a = policy([
      { to: [{ ipBlock: { cidr: '1.1.1.1/32' } }], ports: [{ protocol: 'TCP', port: 443 }] },
    ])
    const b = policy([
      { to: [{ ipBlock: { cidr: '2.2.2.2/32' } }], ports: [{ protocol: 'TCP', port: 443 }] },
    ])
    expect(egressSignature(a)).not.toBe(egressSignature(b))
  })

  it('DETECTS a selector-based `to` change (H1 — canonical captures full rule)', () => {
    const a = policy([
      { to: [{ podSelector: { matchLabels: { app: 'a' } } }], ports: [{ port: 8080 }] },
    ])
    const b = policy([
      { to: [{ podSelector: { matchLabels: { app: 'b' } } }], ports: [{ port: 8080 }] },
    ])
    expect(egressSignature(a)).not.toBe(egressSignature(b))
  })

  // H-C: the signature projects podSelector + policyTypes, not just spec.egress,
  // so an out-of-band drift with identical destination rules re-owns the policy.
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

  it('H-C: DETECTS a policyTypes change but is order-insensitive', () => {
    expect(egressSignature(withSpec({}, ['Egress']))).not.toBe(
      egressSignature(withSpec({}, ['Egress', 'Ingress']))
    )
    expect(egressSignature(withSpec({}, ['Egress', 'Ingress']))).toBe(
      egressSignature(withSpec({}, ['Ingress', 'Egress']))
    )
  })
})
