import { describe, expect, it } from 'vitest'
import type * as k8s from '@kubernetes/client-node'
import { networkPolicyMatchesDesired } from '../utils'
import { asApiserverNetworkPolicy } from './asApiserverNetworkPolicy'

function desiredPolicy(overrides: Partial<k8s.V1NetworkPolicy> = {}): k8s.V1NetworkPolicy {
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: { name: 'np', namespace: 'ns', labels: { app: 'np' } },
    spec: {
      podSelector: { matchLabels: { app: 'np' } },
      ingress: [
        {
          _from: [{ podSelector: { matchLabels: { app: 'peer' } } }],
          ports: [{ port: 8080 }],
        },
      ],
    },
    ...overrides,
  }
}

describe('networkPolicyMatchesDesired', () => {
  it('CMP-NP-1: recorded apiserver blob equivalent to desired is true', () => {
    const desired = desiredPolicy()
    const existing = asApiserverNetworkPolicy(desired)
    expect(existing.spec).toBeDefined()
    expect(existing.spec?.ingress?.[0]?.ports?.[0]?.protocol).toBe('TCP')
    expect(existing.spec?.policyTypes).toEqual(['Ingress'])
    expect(existing.metadata?.resourceVersion).toBe('1783417')
    expect(networkPolicyMatchesDesired(desired, existing)).toBe(true)
  })

  it('CMP-NP-2: port or rule drift is not equivalent', () => {
    const desired = desiredPolicy()
    expect(
      networkPolicyMatchesDesired(desired, asApiserverNetworkPolicy(desired, { port: 9090 }))
    ).toBe(false)

    const ruleDrift = desiredPolicy({
      spec: {
        podSelector: { matchLabels: { app: 'np' } },
        ingress: [
          {
            _from: [{ podSelector: { matchLabels: { app: 'other' } } }],
            ports: [{ port: 8080 }],
          },
        ],
      },
    })
    expect(networkPolicyMatchesDesired(ruleDrift, asApiserverNetworkPolicy(desired))).toBe(false)
  })

  it('CMP-NP-3: label drift is not equivalent', () => {
    const desired = desiredPolicy()
    const labeled = desiredPolicy({
      metadata: { name: 'np', namespace: 'ns', labels: { app: 'other' } },
    })
    expect(networkPolicyMatchesDesired(labeled, asApiserverNetworkPolicy(desired))).toBe(false)
  })

  it('CMP-NP-4: extra annotation on existing is not equivalent', () => {
    const desired = desiredPolicy()
    const existing = asApiserverNetworkPolicy(desired)
    existing.metadata = {
      ...existing.metadata,
      annotations: { 'clerum.io/note': 'live-only' },
    }
    expect(networkPolicyMatchesDesired(desired, existing)).toBe(false)
  })

  it('CMP-NP-5: missing spec or undefined shapes fail open to write', () => {
    const desired = desiredPolicy()
    expect(networkPolicyMatchesDesired(desired, { metadata: { name: 'np' } })).toBe(false)
    expect(
      networkPolicyMatchesDesired(desired, { spec: null } as unknown as k8s.V1NetworkPolicy)
    ).toBe(false)
    expect(networkPolicyMatchesDesired(desired, undefined as unknown as k8s.V1NetworkPolicy)).toBe(
      false
    )
  })

  it('CMP-NP-6: key-order permutation is equal; rule-array reorder is not', () => {
    const desired: k8s.V1NetworkPolicy = {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: { name: 'np', namespace: 'ns', labels: { b: '2', a: '1' } },
      spec: {
        policyTypes: ['Ingress'],
        podSelector: { matchLabels: { app: 'np' } },
        ingress: [{ ports: [{ port: 80 }] }, { ports: [{ port: 443 }] }],
      },
    }
    const keyPermuted: k8s.V1NetworkPolicy = {
      kind: 'NetworkPolicy',
      apiVersion: 'networking.k8s.io/v1',
      spec: {
        ingress: [{ ports: [{ port: 80 }] }, { ports: [{ port: 443 }] }],
        podSelector: { matchLabels: { app: 'np' } },
        policyTypes: ['Ingress'],
      },
      metadata: { labels: { a: '1', b: '2' }, namespace: 'ns', name: 'np' },
    }
    expect(networkPolicyMatchesDesired(desired, keyPermuted)).toBe(true)

    const arrayReordered: k8s.V1NetworkPolicy = {
      ...desired,
      spec: {
        ...desired.spec,
        ingress: [{ ports: [{ port: 443 }] }, { ports: [{ port: 80 }] }],
      },
    }
    expect(networkPolicyMatchesDesired(desired, arrayReordered)).toBe(false)
  })
})
