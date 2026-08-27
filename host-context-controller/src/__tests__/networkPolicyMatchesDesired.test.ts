import { describe, expect, it } from 'vitest'
import type * as k8s from '@kubernetes/client-node'
import { networkPolicyMatchesDesired } from '../utils'
import { RECORDED_NETWORKPOLICY, asApiserverNetworkPolicy } from './asApiserverNetworkPolicy'

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

  it('CMP-NP-7: omitted egress protocol matches apiserver TCP default-fill', () => {
    const desired: k8s.V1NetworkPolicy = {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: { name: 'np', namespace: 'ns', labels: { app: 'np' } },
      spec: {
        podSelector: { matchLabels: { app: 'np' } },
        egress: [{ ports: [{ port: 443 }] }],
      },
    }
    const existing = asApiserverNetworkPolicy(desired)
    expect(existing.spec?.egress?.[0]?.ports?.[0]?.protocol).toBe('TCP')
    expect(desired.spec?.egress?.[0]?.ports?.[0]?.protocol).toBeUndefined()
    expect(networkPolicyMatchesDesired(desired, existing)).toBe(true)
  })

  it('CMP-NP-8: omitted policyTypes with egress matches Ingress+Egress default-fill', () => {
    const desired: k8s.V1NetworkPolicy = {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: { name: 'np', namespace: 'ns', labels: { app: 'np' } },
      spec: {
        podSelector: { matchLabels: { app: 'np' } },
        egress: [{ ports: [{ port: 443 }] }],
      },
    }
    const existing = asApiserverNetworkPolicy(desired)
    expect(desired.spec?.policyTypes).toBeUndefined()
    expect(existing.spec?.policyTypes).toEqual(['Ingress', 'Egress'])
    expect(networkPolicyMatchesDesired(desired, existing)).toBe(true)
  })

  it('CMP-NP-9: empty policyTypes is treated as omitted apiserver default-fill', () => {
    const desired = desiredPolicy({
      spec: {
        podSelector: { matchLabels: { app: 'np' } },
        policyTypes: [],
        ingress: [
          {
            _from: [{ podSelector: { matchLabels: { app: 'peer' } } }],
            ports: [{ port: 8080 }],
          },
        ],
      },
    })
    const existing = asApiserverNetworkPolicy(desired)
    expect(desired.spec?.policyTypes).toEqual([])
    expect(existing.spec?.policyTypes).toEqual(['Ingress'])
    expect(networkPolicyMatchesDesired(desired, existing)).toBe(true)
  })

  it('CMP-NP-10: omitted rule ports stay omitted on the recorded overlay', () => {
    const desired = desiredPolicy({
      spec: {
        podSelector: { matchLabels: { app: 'np' } },
        ingress: [{ _from: [{ podSelector: { matchLabels: { app: 'peer' } } }] }],
      },
    })
    const existing = asApiserverNetworkPolicy(desired)
    expect(desired.spec?.ingress?.[0]?.ports).toBeUndefined()
    expect(existing.spec?.ingress?.[0]?.ports).toBeUndefined()
    expect(networkPolicyMatchesDesired(desired, existing)).toBe(true)
  })

  it('CMP-NP-11: UDP is not stripped; UDP vs TCP is not equivalent', () => {
    const desired: k8s.V1NetworkPolicy = {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: { name: 'np', namespace: 'ns', labels: { app: 'np' } },
      spec: {
        podSelector: { matchLabels: { app: 'np' } },
        egress: [{ ports: [{ port: 53, protocol: 'UDP' }] }],
      },
    }
    const existing = asApiserverNetworkPolicy(desired)
    expect(existing.spec?.egress?.[0]?.ports?.[0]?.protocol).toBe('UDP')
    expect(networkPolicyMatchesDesired(desired, existing)).toBe(true)

    const tcpLive = asApiserverNetworkPolicy(desired)
    const tcpPort = tcpLive.spec?.egress?.[0]?.ports?.[0]
    expect(tcpPort).toBeDefined()
    tcpPort!.protocol = 'TCP'
    expect(networkPolicyMatchesDesired(desired, tcpLive)).toBe(false)
  })

  it('CMP-NP-12: recorded nested port fields survive the overlay', () => {
    const desired = desiredPolicy()
    const existing = asApiserverNetworkPolicy(desired)
    const recordedPort = RECORDED_NETWORKPOLICY.spec?.ingress?.[0]?.ports?.[0]
    const livePort = existing.spec?.ingress?.[0]?.ports?.[0] as Record<string, unknown> | undefined
    expect(recordedPort).toBeDefined()
    expect(livePort).toBeDefined()
    for (const key of Object.keys(recordedPort as object)) {
      if (key === 'port') continue
      expect(livePort![key]).toEqual((recordedPort as Record<string, unknown>)[key])
    }
  })

  it('CMP-NP-13: empty egress array vs omitted fails open to write', () => {
    const omitted = desiredPolicy()
    const emptyEgress: k8s.V1NetworkPolicy = {
      ...omitted,
      spec: { ...omitted.spec, egress: [] },
    }
    expect(networkPolicyMatchesDesired(emptyEgress, asApiserverNetworkPolicy(omitted))).toBe(false)
  })
})
