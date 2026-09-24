import { describe, expect, it } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import {
  buildNetworkPolicyReplacement,
  classifyNetworkPolicyOwnership,
  decideNetworkPolicyConvergence,
  networkPolicyMatchesDesired,
  networkPolicyMetadataMatchesDesired,
} from './networkPolicyConvergence'

const SPEC_HASH = 'clerum.io/spec-hash'

// The run lane's runtime HTTP egress state keys (workflowReconciler.ts). They
// are module-private there, so the literal strings are repeated here.
const RUN_LANE_PREVIOUS_CIDRS = 'clerum.io/runtime-http-egress-previous-cidrs'
const RUN_LANE_OWNED_ANNOTATIONS = new Set([
  'clerum.io/runtime-http-egress-current-cidrs',
  RUN_LANE_PREVIOUS_CIDRS,
  'clerum.io/runtime-http-egress-previous-expires-at',
  'clerum.io/runtime-http-egress-previous-cidr-expiries',
  'clerum.io/runtime-http-egress-resolved-at',
])

function runLanePolicy(): k8s.V1NetworkPolicy {
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: 'r-coord-to-wrc',
      namespace: 'sandbox-recipes',
      labels: { 'clerum.io/managed-by': 'wrc', 'clerum.io/recipe': 'r' },
      annotations: {
        'clerum.io/runtime-http-egress-current-cidrs': '203.0.113.10/32',
      },
    },
    spec: {
      podSelector: { matchLabels: { 'clerum.io/recipe': 'r' } },
      policyTypes: ['Egress'],
      egress: [{ to: [{ ipBlock: { cidr: '203.0.113.10/32' } }] }],
    },
  }
}

// These minimal fixtures isolate comparison and ownership edge cases. Real
// producer output and Kubernetes serialization are covered by the property suite.
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

  it('compares inferred mixed policyTypes with API defaults in either order', () => {
    const desired = policy()
    delete desired.spec!.policyTypes
    desired.spec!.egress = [{ ports: [{ port: 443 }] }]
    for (const policyTypes of [
      ['Ingress', 'Egress'],
      ['Egress', 'Ingress'],
    ]) {
      const live = structuredClone(desired)
      live.spec!.policyTypes = policyTypes
      expect(networkPolicyMatchesDesired(desired, live)).toBe(true)
    }
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
    desired.metadata!.annotations = { 'clerum.io/egress-fqdn-resolved-at': 'new-timestamp' }
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

  it('compares stable workload-egress annotations and removal of owned state', () => {
    const desired = policy()
    desired.metadata!.annotations = { 'clerum.io/test-contract': 'current' }
    const live = structuredClone(desired)
    live.metadata!.annotations!['clerum.io/test-contract'] = 'stale'
    expect(networkPolicyMetadataMatchesDesired(desired, live)).toBe(false)

    live.metadata!.annotations = {
      ...desired.metadata!.annotations,
      'clerum.io/egress-fqdn-state': 'stale',
    }
    expect(networkPolicyMetadataMatchesDesired(desired, live)).toBe(false)
    expect(networkPolicyMatchesDesired(desired, live)).toBe(false)
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

  describe('caller-owned annotation keys', () => {
    function liveWithStalePreviousCidrs(desired: k8s.V1NetworkPolicy): k8s.V1NetworkPolicy {
      const live = structuredClone(desired)
      live.metadata!.resourceVersion = '7'
      live.metadata!.annotations = {
        ...desired.metadata!.annotations,
        [RUN_LANE_PREVIOUS_CIDRS]: '198.51.100.4/32',
        'admission.example/audit': 'true',
      }
      return live
    }

    it('repairs a stale owned key absent from desired and drops it from the PUT body', () => {
      const desired = runLanePolicy()
      const live = liveWithStalePreviousCidrs(desired)

      expect(networkPolicyMatchesDesired(desired, live, RUN_LANE_OWNED_ANNOTATIONS)).toBe(false)
      expect(
        decideNetworkPolicyConvergence('workload-egress', desired, live, RUN_LANE_OWNED_ANNOTATIONS)
      ).toEqual({ action: 'replace', reason: 'live-drift' })

      const body = buildNetworkPolicyReplacement(desired, live, RUN_LANE_OWNED_ANNOTATIONS)
      expect(body.metadata!.annotations).toEqual({
        'clerum.io/runtime-http-egress-current-cidrs': '203.0.113.10/32',
        'admission.example/audit': 'true',
      })
      expect(body.metadata!.resourceVersion).toBe('7')
    })

    it('keeps the default owned set: an unknown key is preserved and does not count as drift', () => {
      const desired = runLanePolicy()
      const live = liveWithStalePreviousCidrs(desired)

      expect(networkPolicyMatchesDesired(desired, live)).toBe(true)
      expect(decideNetworkPolicyConvergence('workload-egress', desired, live)).toEqual({
        action: 'unchanged',
      })
      expect(
        buildNetworkPolicyReplacement(desired, live).metadata!.annotations![RUN_LANE_PREVIOUS_CIDRS]
      ).toBe('198.51.100.4/32')
    })

    it('reports the converged run-lane policy as unchanged with the caller-owned set', () => {
      const desired = runLanePolicy()
      const live = structuredClone(desired)
      live.metadata!.resourceVersion = '7'

      expect(
        decideNetworkPolicyConvergence('workload-egress', desired, live, RUN_LANE_OWNED_ANNOTATIONS)
      ).toEqual({ action: 'unchanged' })
    })
  })
})
