import { describe, expect, it } from 'vitest'
import type { DeploymentDef, WorkflowRecipeCRD } from '../types'
import {
  buildWorkloadEgressNetworkPolicy,
  buildWorkloadIngressNetworkPolicy,
  classifyRecipeNetworkPolicyName,
  oauthBrokerEgressPolicyName,
  parseClusterLocalFqdn,
  resolveClusterLocalBinding,
  uiEgressPolicyName,
  uiIngressPolicyName,
  workloadEgressPolicyName,
  workloadIngressPolicyName,
} from './resourceBuilder'

function makeRecipe(workloads: DeploymentDef[]): WorkflowRecipeCRD {
  return {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: {
      name: 'sales-crm',
      namespace: 'sandbox-recipes',
      uid: 'uid-1',
    },
    spec: { workloads },
  }
}

describe('parseClusterLocalFqdn', () => {
  it('parses <svc>.<ns>.svc.cluster.local', () => {
    expect(parseClusterLocalFqdn('db.sandbox-recipes.svc.cluster.local')).toEqual({
      service: 'db',
      namespace: 'sandbox-recipes',
    })
  })

  it('tolerates a trailing dot', () => {
    expect(parseClusterLocalFqdn('db.sandbox-recipes.svc.cluster.local.')).toEqual({
      service: 'db',
      namespace: 'sandbox-recipes',
    })
  })

  it('returns null for external FQDNs', () => {
    expect(parseClusterLocalFqdn('api.anthropic.com')).toBeNull()
    expect(parseClusterLocalFqdn('graph.microsoft.com')).toBeNull()
  })

  it('returns null for non-conforming cluster-local shapes', () => {
    // No subdomain depth beyond <svc>.<ns> — extra labels would silently
    // accept ambiguous targets, so reject them.
    expect(parseClusterLocalFqdn('a.b.c.svc.cluster.local')).toBeNull()
    expect(parseClusterLocalFqdn('only-svc.cluster.local')).toBeNull()
  })
})

describe('resolveClusterLocalBinding', () => {
  const recipe = makeRecipe([
    { id: 'api', type: 'deployment', image: 'x' },
    { id: 'db', type: 'deployment', image: 'postgres' },
  ])

  it('matches a sibling workload by id', () => {
    const out = resolveClusterLocalBinding(
      'db.sandbox-recipes.svc.cluster.local',
      recipe,
      'sandbox-recipes'
    )
    expect(out).toEqual({ kind: 'cluster-local', workloadId: 'db', namespace: 'sandbox-recipes' })
  })

  it('returns null for external FQDNs', () => {
    expect(resolveClusterLocalBinding('api.anthropic.com', recipe, 'sandbox-recipes')).toBeNull()
  })

  it('REJECTS cluster-local FQDNs that point at a non-sibling workload', () => {
    // The cross-recipe guard — `nope` is not a workload in this recipe.
    const out = resolveClusterLocalBinding(
      'nope.sandbox-recipes.svc.cluster.local',
      recipe,
      'sandbox-recipes'
    )
    expect(out).toEqual({
      kind: 'mismatch',
      reason: expect.stringContaining('does not match any workload id in this recipe'),
    })
  })

  it('REJECTS cluster-local FQDNs targeting a different namespace', () => {
    const out = resolveClusterLocalBinding(
      'db.other-namespace.svc.cluster.local',
      recipe,
      'sandbox-recipes'
    )
    expect(out).toEqual({
      kind: 'mismatch',
      reason: expect.stringContaining('targets namespace "other-namespace"'),
    })
  })
})

describe('buildWorkloadEgressNetworkPolicy', () => {
  const recipe = makeRecipe([
    {
      id: 'api',
      type: 'deployment',
      image: 'x',
      egressBindings: [
        { dns: 'db.sandbox-recipes.svc.cluster.local', port: 5432, protocol: 'TCP' },
        { dns: 'api.anthropic.com', port: 443, protocol: 'TCP' },
      ],
    },
    { id: 'db', type: 'deployment', image: 'postgres' },
  ])

  it('returns null when the workload has no bindings', () => {
    const wl = recipe.spec.workloads!.find(w => w.id === 'db')!
    const out = buildWorkloadEgressNetworkPolicy(wl, recipe, 'sandbox-recipes', [])
    expect(out).toBeNull()
  })

  it('emits namespaceSelector + sibling podSelector for cluster-local + ipBlock for external', () => {
    const wl = recipe.spec.workloads!.find(w => w.id === 'api')!
    const out = buildWorkloadEgressNetworkPolicy(wl, recipe, 'sandbox-recipes', [
      { cidr: '54.10.0.1/32', port: 443, source: { kind: 'fqdn', fqdn: 'api.anthropic.com' } },
    ])
    expect(out).not.toBeNull()
    expect(out!.metadata!.name).toBe('wl-egress-sales-crm-api')
    expect(out!.metadata!.namespace).toBe('sandbox-recipes')
    expect(out!.spec!.podSelector!.matchLabels).toEqual({
      'clerum.io/recipe': 'sales-crm',
      'clerum.io/workload': 'api',
    })
    expect(out!.spec!.policyTypes).toEqual(['Egress'])
    expect(out!.spec!.egress).toHaveLength(2)

    const clusterLocal = out!.spec!.egress![0]
    expect(clusterLocal.to![0].namespaceSelector!.matchLabels).toEqual({
      'kubernetes.io/metadata.name': 'sandbox-recipes',
    })
    expect(clusterLocal.to![0].podSelector!.matchLabels).toEqual({
      'clerum.io/recipe': 'sales-crm',
      'clerum.io/workload': 'db',
    })
    expect(clusterLocal.ports).toEqual([{ port: 5432, protocol: 'TCP' }])

    const external = out!.spec!.egress![1]
    expect(external.to![0].ipBlock!.cidr).toBe('54.10.0.1/32')
    // /32 public — RFC1918 except[] is trimmed.
    expect(external.to![0].ipBlock!.except).toBeUndefined()
    expect(external.ports).toEqual([{ port: 443, protocol: 'TCP' }])
  })

  it('never emits ports-only egress rules or empty selectors', () => {
    const wl = recipe.spec.workloads!.find(w => w.id === 'api')!
    const out = buildWorkloadEgressNetworkPolicy(wl, recipe, 'sandbox-recipes', [
      { cidr: '54.10.0.1/32', port: 443, source: { kind: 'fqdn', fqdn: 'api.anthropic.com' } },
    ])!

    for (const rule of out.spec!.egress!) {
      expect(rule.ports?.length).toBeGreaterThan(0)
      expect(rule.to?.length).toBeGreaterThan(0)
      for (const peer of rule.to!) {
        expect(peer.namespaceSelector).not.toEqual({})
        expect(peer.podSelector).not.toEqual({})
      }
    }
  })
})

describe('buildWorkloadIngressNetworkPolicy', () => {
  const recipe = makeRecipe([
    { id: 'api', type: 'deployment', image: 'x' },
    { id: 'db', type: 'deployment', image: 'postgres' },
  ])

  it('returns null when the target has no sibling sources', () => {
    const target = recipe.spec.workloads!.find(w => w.id === 'db')!
    expect(buildWorkloadIngressNetworkPolicy(target, recipe, 'sandbox-recipes', [])).toBeNull()
  })

  it('emits one ingress rule per source workload, all routed through sibling labels', () => {
    const target = recipe.spec.workloads!.find(w => w.id === 'db')!
    const out = buildWorkloadIngressNetworkPolicy(target, recipe, 'sandbox-recipes', [
      { fromWorkloadId: 'api', fromNamespace: 'sandbox-recipes', port: 5432, protocol: 'TCP' },
      {
        fromWorkloadId: 'followup',
        fromNamespace: 'sandbox-recipes',
        port: 5432,
        protocol: 'TCP',
      },
    ])
    expect(out).not.toBeNull()
    expect(out!.metadata!.name).toBe('wl-ingress-sales-crm-db')
    expect(out!.spec!.policyTypes).toEqual(['Ingress'])
    expect(out!.spec!.ingress).toHaveLength(2)
    expect(out!.spec!.ingress![0]._from![0].podSelector!.matchLabels).toEqual({
      'clerum.io/recipe': 'sales-crm',
      'clerum.io/workload': 'api',
    })
    expect(out!.spec!.ingress![1]._from![0].podSelector!.matchLabels).toEqual({
      'clerum.io/recipe': 'sales-crm',
      'clerum.io/workload': 'followup',
    })
  })

  it('never emits ports-only ingress rules or empty selectors', () => {
    const target = recipe.spec.workloads!.find(w => w.id === 'db')!
    const out = buildWorkloadIngressNetworkPolicy(target, recipe, 'sandbox-recipes', [
      { fromWorkloadId: 'api', fromNamespace: 'sandbox-recipes', port: 5432, protocol: 'TCP' },
    ])!

    for (const rule of out.spec!.ingress!) {
      expect(rule.ports?.length).toBeGreaterThan(0)
      expect(rule._from?.length).toBeGreaterThan(0)
      for (const peer of rule._from!) {
        expect(peer.namespaceSelector).not.toEqual({})
        expect(peer.podSelector).not.toEqual({})
      }
    }
  })
})

describe('policy name composition', () => {
  it('keeps every already-valid short policy name byte-identical', () => {
    expect(workloadEgressPolicyName('sales', 'api')).toBe('wl-egress-sales-api')
    expect(workloadIngressPolicyName('sales', 'api')).toBe('wl-ingress-sales-api')
    expect(uiIngressPolicyName('sales', 'api')).toBe('ui-ingress-sales-api')
    expect(uiEgressPolicyName('sales')).toBe('ui-egress-sales')
    expect(oauthBrokerEgressPolicyName('sales')).toBe('wf-sales-oauth-broker-egress')
  })

  it('fits inside 63 chars even with a long recipe name', () => {
    const longRecipe = 'recipe-with-an-extremely-long-name-that-might-overflow'
    const e = workloadEgressPolicyName(longRecipe, 'api')
    const i = workloadIngressPolicyName(longRecipe, 'api')
    expect(e.length).toBeLessThanOrEqual(63)
    expect(i.length).toBeLessThanOrEqual(63)
    expect(e).toMatch(/^wl-egress-/)
    expect(i).toMatch(/^wl-ingress-/)
    // Trailing hyphens are stripped so we never produce `prefix--workload`.
    expect(e).not.toMatch(/--/)
    expect(i).not.toMatch(/--/)
  })

  it('keeps every valid maximum-length workload id within the DNS-1123 limit', () => {
    const workloadId = 'a'.repeat(63)

    for (const name of [
      workloadEgressPolicyName('r', workloadId),
      workloadIngressPolicyName('r', workloadId),
      uiIngressPolicyName('r', workloadId),
    ]) {
      expect(name).toMatch(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/)
      expect(name.length).toBeLessThanOrEqual(63)
    }
  })

  it('keeps the entire CRD-valid recipe/workload length matrix within 63 characters', () => {
    for (let recipeLength = 1; recipeLength <= 63; recipeLength += 1) {
      for (let workloadLength = 1; workloadLength <= 63; workloadLength += 1) {
        const recipeName = 'r'.repeat(recipeLength)
        const workloadId = 'w'.repeat(workloadLength)
        for (const name of [
          workloadEgressPolicyName(recipeName, workloadId),
          workloadIngressPolicyName(recipeName, workloadId),
          uiIngressPolicyName(recipeName, workloadId),
        ]) {
          expect(name.length).toBeLessThanOrEqual(63)
        }
      }
    }
  })

  it('keeps per-recipe UI and OAuth policy names valid for maximum recipe names', () => {
    const recipeName = 'r'.repeat(63)
    for (const name of [uiEgressPolicyName(recipeName), oauthBrokerEgressPolicyName(recipeName)]) {
      expect(name).toMatch(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/)
      expect(name.length).toBeLessThanOrEqual(63)
    }
    expect(oauthBrokerEgressPolicyName(recipeName)).toMatch(/^wf-/)
    expect(oauthBrokerEgressPolicyName(recipeName)).toMatch(/-oauth-broker-egress$/)
  })

  it('hashes overflow identities so trimming at a hyphen cannot collapse distinct workloads', () => {
    const egressA = `${'a'.repeat(51)}-${'x'.repeat(11)}`
    const egressB = `${'a'.repeat(51)}-${'y'.repeat(11)}`
    const ingressA = `${'a'.repeat(50)}-${'x'.repeat(12)}`
    const ingressB = `${'a'.repeat(50)}-${'y'.repeat(12)}`

    expect(workloadEgressPolicyName('r', egressA)).not.toBe(workloadEgressPolicyName('r', egressB))
    expect(workloadIngressPolicyName('r', ingressA)).not.toBe(
      workloadIngressPolicyName('r', ingressB)
    )
    expect(uiIngressPolicyName('r', ingressA)).not.toBe(uiIngressPolicyName('r', ingressB))
  })

  it('classifies every overflow-safe builder name back to its owning family', () => {
    const recipeName = 'r'.repeat(63)
    const workloadId = 'w'.repeat(63)

    expect(classifyRecipeNetworkPolicyName(workloadEgressPolicyName(recipeName, workloadId))).toBe(
      'wl-egress'
    )
    expect(classifyRecipeNetworkPolicyName(workloadIngressPolicyName(recipeName, workloadId))).toBe(
      'wl-ingress'
    )
    expect(classifyRecipeNetworkPolicyName(uiIngressPolicyName(recipeName, workloadId))).toBe(
      'ui-ingress'
    )
    expect(classifyRecipeNetworkPolicyName(uiEgressPolicyName(recipeName))).toBe('ui-egress')
    expect(classifyRecipeNetworkPolicyName(oauthBrokerEgressPolicyName(recipeName))).toBe(
      'oauth-broker-egress'
    )
  })
})
