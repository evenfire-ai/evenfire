import { describe, expect, it } from 'vitest'
import {
  type ModelImpactSources,
  computeModelImpact,
  modelImpactHasReferences,
} from '../src/services/llmModelImpact.js'
import { mapGrantRow } from '../src/services/pluginWorkloadSdkDb.js'
import { MockGateway } from './mockGateway.js'

// Module-level tests for the impact enumerator. Host CRs come from the REAL
// gateway producer (`createResource` → per-namespace `listResource`, T1); the
// grant source is injected as the output of the REAL `mapGrantRow` (T1), never a
// hand-built DTO. MockGateway.listResource(plural, ns) scopes by namespace, so
// the per-namespace fan-out is exercised faithfully.

const PROVIDER = 'claude'
const MODEL = 'claude-haiku-4-5'

function makeGrantRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    recipe_namespace: 'sandbox-recipes',
    recipe_name: 'nightly-summary',
    capability_family: 'promptBridge',
    provider: PROVIDER,
    allowed_models: [MODEL],
    allowed_event_types: [],
    allowed_target_refs: [],
    allowed_user_refs: [],
    allowed_callers: ['worker'],
    quota_limits: {},
    model_policies: {},
    prompt_targets: [],
    default_target_ref: null,
    policy_revision: 1,
    policy_state: 'active',
    policy_reviewed_at: null,
    policy_reviewed_by: null,
    revocation_id: null,
    created_at: new Date('2026-07-01T00:00:00Z'),
    updated_at: new Date('2026-07-01T00:00:00Z'),
    ...overrides,
  }
}

function sourcesFrom(
  gateway: MockGateway,
  opts: { hostNamespaces?: string[]; grantRows?: unknown[] } = {}
): ModelImpactSources {
  return {
    hostNamespaces: opts.hostNamespaces ?? ['mcp-host'],
    listHostsInNamespace: namespace => gateway.listResource('hosts', namespace),
    listGrantsForModel: async () =>
      ((opts.grantRows ?? []) as Record<string, unknown>[]).map(mapGrantRow),
  }
}

describe('computeModelImpact', () => {
  it('reports EVERY role a single Host references the pair in', async () => {
    const gateway = new MockGateway('mcp-host')
    await gateway.createResource(
      'hosts',
      {
        metadata: { name: 'agent-a' },
        spec: {
          model: { provider: PROVIDER, name: MODEL }, // primary
          allowedModels: [{ provider: PROVIDER, model: MODEL }], // allowedModels
          llmPolicy: { fallbacks: [{ provider: PROVIDER, model: MODEL }] }, // fallback
        },
      },
      'mcp-host'
    )

    const impact = await computeModelImpact(PROVIDER, MODEL, sourcesFrom(gateway))
    expect(impact.hostsAffected).toHaveLength(1)
    expect(impact.hostsAffected[0].roles).toEqual(['primary', 'allowedModels', 'fallback'])
    expect(modelImpactHasReferences(impact)).toBe(true)
  })

  it('returns no references when nothing points at the pair', async () => {
    const gateway = new MockGateway('mcp-host')
    await gateway.createResource(
      'hosts',
      { metadata: { name: 'agent-a' }, spec: { model: { provider: PROVIDER, name: 'other' } } },
      'mcp-host'
    )
    const impact = await computeModelImpact(PROVIDER, MODEL, sourcesFrom(gateway))
    expect(impact.hostsAffected).toEqual([])
    expect(impact.grantsAffected).toEqual([])
    expect(modelImpactHasReferences(impact)).toBe(false)
  })

  it('maps grant references through the real mapGrantRow', async () => {
    const gateway = new MockGateway('mcp-host')
    const impact = await computeModelImpact(
      PROVIDER,
      MODEL,
      sourcesFrom(gateway, { grantRows: [makeGrantRow()] })
    )
    expect(impact.grantsAffected).toEqual([
      {
        id: '22222222-2222-4222-8222-222222222222',
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'nightly-summary',
        capabilityFamily: 'promptBridge',
      },
    ])
  })

  it('aggregates Host references across MULTIPLE namespaces (per-namespace scoping)', async () => {
    const gateway = new MockGateway('mcp-host')
    // MockGateway.listResource(plural, ns) filters by namespace, so a host in
    // ns-b must NOT surface under an ns-a LIST — this exercises real scoping.
    await gateway.createResource(
      'hosts',
      { metadata: { name: 'agent-a' }, spec: { model: { provider: PROVIDER, name: MODEL } } },
      'ns-a'
    )
    await gateway.createResource(
      'hosts',
      {
        metadata: { name: 'agent-b' },
        spec: { allowedModels: [{ provider: PROVIDER, model: MODEL }] },
      },
      'ns-b'
    )

    const impact = await computeModelImpact(
      PROVIDER,
      MODEL,
      sourcesFrom(gateway, { hostNamespaces: ['ns-a', 'ns-b'] })
    )
    const seen = impact.hostsAffected.map(h => `${h.namespace}/${h.name}`).sort()
    expect(seen).toEqual(['ns-a/agent-a', 'ns-b/agent-b'])
  })

  it('FAILS LOUD: a namespace LIST error REJECTS instead of returning a partial impact', async () => {
    const gateway = new MockGateway('mcp-host')
    await gateway.createResource(
      'hosts',
      { metadata: { name: 'agent-a' }, spec: { model: { provider: PROVIDER, name: MODEL } } },
      'ns-a'
    )
    const sources: ModelImpactSources = {
      hostNamespaces: ['ns-a', 'ns-broken'],
      listHostsInNamespace: async namespace => {
        if (namespace === 'ns-broken') throw new Error('k8s LIST failed')
        return gateway.listResource('hosts', namespace)
      },
      listGrantsForModel: async () => [],
    }
    await expect(computeModelImpact(PROVIDER, MODEL, sources)).rejects.toThrow('k8s LIST failed')
  })
})
