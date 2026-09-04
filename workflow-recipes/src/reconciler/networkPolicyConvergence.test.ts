import { describe, expect, it } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import {
  classifyNetworkPolicyOwnership,
  decideNetworkPolicyConvergence,
  networkPolicyMatchesDesired,
  networkPolicyMetadataMatchesDesired,
} from './networkPolicyConvergence'

const SPEC_HASH = 'clerum.io/spec-hash'

function policy(): k8s.V1NetworkPolicy {
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: 'wl-ingress-r-w',
      namespace: 'sandbox-recipes',
      labels: {
        'clerum.io/managed-by': 'workflow-recipes',
        'clerum.io/recipe': 'r',
      },
    },
    spec: {
      podSelector: { matchLabels: { 'clerum.io/workload': 'w' } },
      policyTypes: ['Ingress'],
      ingress: [{ ports: [{ port: 8080, protocol: 'TCP' }] }],
    },
  }
}

function gatewayPolicy(ownerUid = 'uid-new'): k8s.V1NetworkPolicy {
  return {
    ...policy(),
    metadata: {
      name: 'allow-webhook-proxy-ingress-r',
      namespace: 'sandbox-recipes',
      labels: {
        'clerum.io/managed-by': 'workflow-recipes',
        'clerum.io/recipe-namespace': 'sandbox-recipes',
        'clerum.io/recipe-name': 'r',
        'clerum.io/webhook-gateway': 'true',
      },
      ownerReferences: [
        {
          apiVersion: 'clerum.io/v1alpha1',
          kind: 'WorkflowRecipe',
          name: 'r',
          uid: ownerUid,
          controller: true,
          blockOwnerDeletion: true,
        },
      ],
    },
  }
}

describe('NetworkPolicy live convergence', () => {
  it('treats API metadata/defaulting and the legacy spec-hash as equivalent', () => {
    const desired = policy()
    const live = structuredClone(desired)
    live.metadata = {
      ...live.metadata,
      uid: 'policy-uid',
      resourceVersion: '9',
      generation: 3,
      creationTimestamp: new Date('2026-09-04T00:00:00Z'),
      annotations: { [SPEC_HASH]: 'legacy-seal' },
    }
    live.spec!.ingress![0].ports![0].protocol = undefined

    expect(networkPolicyMatchesDesired(desired, live)).toBe(true)
    expect(decideNetworkPolicyConvergence('workload-ingress', desired, live)).toEqual({
      action: 'unchanged',
    })
  })

  it('normalizes empty rule arrays and API-defaulted policyTypes', () => {
    const desired = policy()
    desired.spec = { podSelector: {}, policyTypes: [], ingress: [], egress: [] }
    const live = policy()
    live.spec = { podSelector: {}, policyTypes: ['Ingress'] }

    expect(networkPolicyMatchesDesired(desired, live)).toBe(true)
  })

  it('normalizes the client model _from field and the Kubernetes wire from field', () => {
    const desired = policy()
    desired.spec!.ingress = [
      {
        _from: [{ podSelector: { matchLabels: { app: 'gateway' } } }],
        ports: [{ port: 8090, protocol: 'TCP' }],
      },
    ]
    const live = structuredClone(desired)
    const liveRule = live.spec!.ingress![0] as k8s.V1NetworkPolicyIngressRule & {
      from?: k8s.V1NetworkPolicyPeer[]
    }
    liveRule.from = liveRule._from
    delete liveRule._from

    expect(networkPolicyMatchesDesired(desired, live)).toBe(true)
  })

  it('ignores admission metadata outside the keys authored by WRC', () => {
    const desired = policy()
    const live = structuredClone(desired)
    live.metadata!.labels = { ...live.metadata!.labels, 'admission.example/tier': 'audited' }
    live.metadata!.annotations = { 'admission.example/audit': 'true' }
    live.metadata!.finalizers = ['admission.example/cleanup']

    expect(networkPolicyMatchesDesired(desired, live)).toBe(true)

    live.metadata!.labels!['clerum.io/recipe'] = 'foreign'
    expect(networkPolicyMatchesDesired(desired, live)).toBe(false)
  })

  it('repairs live enforcement drift even when the stored spec-hash is preserved', () => {
    const desired = policy()
    const live = structuredClone(desired)
    live.metadata!.resourceVersion = '9'
    live.metadata!.annotations = { [SPEC_HASH]: 'still-matches-the-old-desired' }
    live.spec!.podSelector = {}
    live.spec!.ingress = [{}]

    expect(networkPolicyMatchesDesired(desired, live)).toBe(false)
    expect(decideNetworkPolicyConvergence('workload-ingress', desired, live)).toEqual({
      action: 'replace',
      reason: 'live-drift',
    })
  })

  it('makes workload-egress metadata drift bypass its temporal prefilter', () => {
    const desired = policy()
    const live = structuredClone(desired)
    live.metadata!.annotations = { 'clerum.io/egress-fqdn-resolved-at': 'old-timestamp' }

    expect(networkPolicyMetadataMatchesDesired(desired, live)).toBe(true)

    live.metadata!.labels = { ...live.metadata!.labels, 'clerum.io/recipe': 'wrong' }
    expect(networkPolicyMetadataMatchesDesired(desired, live)).toBe(false)

    live.metadata!.labels = desired.metadata!.labels
    live.metadata!.deletionTimestamp = new Date('2026-09-04T00:00:00Z')
    expect(networkPolicyMetadataMatchesDesired(desired, live)).toBe(false)

    delete live.metadata!.deletionTimestamp
    live.metadata!.ownerReferences = [
      {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        name: 'foreign',
        uid: 'foreign-uid',
        controller: true,
      },
    ]
    expect(networkPolicyMetadataMatchesDesired(desired, live)).toBe(false)
  })

  it('repairs a stale or missing gateway owner only for the same WRC recipe identity', () => {
    const desired = gatewayPolicy('uid-new')
    const stale = gatewayPolicy('uid-old')
    const missing = gatewayPolicy('uid-new')
    delete missing.metadata!.ownerReferences

    expect(classifyNetworkPolicyOwnership('webhook-gateway', desired, stale)).toEqual({
      kind: 'repairable-owner',
    })
    expect(classifyNetworkPolicyOwnership('webhook-gateway', desired, missing)).toEqual({
      kind: 'repairable-owner',
    })
    expect(decideNetworkPolicyConvergence('webhook-gateway', desired, stale)).toEqual({
      action: 'replace',
      reason: 'owner-repair',
    })
  })

  it('does not repair a stale gateway owner when the WRC recipe identity labels drifted', () => {
    const desired = gatewayPolicy('uid-new')
    const wrongRecipe = gatewayPolicy('uid-old')
    wrongRecipe.metadata!.labels!['clerum.io/recipe-name'] = 'another-recipe'

    expect(classifyNetworkPolicyOwnership('webhook-gateway', desired, wrongRecipe)).toEqual({
      kind: 'conflict',
      reason: 'identity-label-mismatch',
    })
    expect(decideNetworkPolicyConvergence('webhook-gateway', desired, wrongRecipe)).toEqual({
      action: 'conflict',
      reason: 'identity-label-mismatch',
    })
  })

  it('refuses a gateway policy controlled by a different owner', () => {
    const desired = gatewayPolicy('uid-new')
    const foreign = gatewayPolicy('uid-new')
    foreign.metadata!.ownerReferences = [
      {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        name: 'foreign',
        uid: 'foreign-uid',
        controller: true,
      },
    ]

    expect(classifyNetworkPolicyOwnership('webhook-gateway', desired, foreign)).toEqual({
      kind: 'conflict',
      reason: 'controller-owner-mismatch',
    })
    expect(decideNetworkPolicyConvergence('webhook-gateway', desired, foreign)).toEqual({
      action: 'conflict',
      reason: 'controller-owner-mismatch',
    })
  })

  it('refuses a controller owner on a family that must be ownerless', () => {
    const desired = policy()
    const foreign = structuredClone(desired)
    foreign.metadata!.ownerReferences = [
      {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        name: 'foreign',
        uid: 'foreign-uid',
        controller: true,
      },
    ]

    expect(classifyNetworkPolicyOwnership('workload-ingress', desired, foreign)).toEqual({
      kind: 'conflict',
      reason: 'owner-reference-mismatch',
    })
    expect(decideNetworkPolicyConvergence('workload-ingress', desired, foreign)).toEqual({
      action: 'conflict',
      reason: 'owner-reference-mismatch',
    })
  })

  it('never reports a terminating policy as unchanged or replaceable', () => {
    const desired = gatewayPolicy()
    const terminating = gatewayPolicy()
    terminating.metadata!.deletionTimestamp = new Date('2026-09-04T00:00:00Z')

    expect(decideNetworkPolicyConvergence('webhook-gateway', desired, terminating)).toEqual({
      action: 'retry',
      reason: 'terminating',
    })
  })
})
