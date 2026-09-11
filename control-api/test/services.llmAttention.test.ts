import { describe, expect, it, vi } from 'vitest'
import { type StaleModelInput, computeAttention } from '../src/services/llmAttention.js'
import { type ModelImpactSources } from '../src/services/llmModelImpact.js'
import { mapGrantRow } from '../src/services/pluginWorkloadSdkDb.js'
import { MockGateway } from './mockGateway.js'

// Module-level tests for the attention feed builder. Host CRs come from the REAL
// gateway producer (`createResource` → per-namespace `listResource`, T1); the
// grant source is the output of the REAL `mapGrantRow` (T1). These complement
// the HTTP-contract tests in routes.adminAttention.test.ts (T4) with the cost
// (memoization) and fail-loud guarantees the endpoint depends on.

const PROVIDER = 'claude'
const MODEL_A = 'claude-haiku-4-5'
const MODEL_B = 'claude-opus-legacy'
const NAMESPACES = ['mcp-host', 'control-api']

function stale(model: string, display_name: string | null = null): StaleModelInput {
  return { provider: PROVIDER, model, display_name }
}

function makeGrantRow(model: string, overrides: Record<string, unknown> = {}) {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    recipe_namespace: 'sandbox-recipes',
    recipe_name: 'nightly-summary',
    capability_family: 'promptBridge',
    provider: PROVIDER,
    allowed_models: [model],
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

/** Sources wired to the real gateway producer, with an injected grant lookup. */
function sourcesFor(
  gateway: MockGateway,
  grantRowsByModel: Record<string, unknown[]> = {}
): ModelImpactSources {
  return {
    hostNamespaces: NAMESPACES,
    listHostsInNamespace: namespace => gateway.listResource('hosts', namespace),
    listGrantsForModel: async model =>
      ((grantRowsByModel[model] ?? []) as Record<string, unknown>[]).map(mapGrantRow),
  }
}

async function seedHost(gateway: MockGateway, name: string, model: string, namespace = 'mcp-host') {
  await gateway.createResource(
    'hosts',
    { metadata: { name }, spec: { model: { provider: PROVIDER, name: model } } },
    namespace
  )
}

describe('computeAttention', () => {
  it('emits an item only for referenced stale models, carrying the impact', async () => {
    const gateway = new MockGateway('mcp-host')
    await seedHost(gateway, 'agent-a', MODEL_A)

    const report = await computeAttention(
      [stale(MODEL_A, 'Claude Haiku'), stale(MODEL_B)],
      sourcesFor(gateway)
    )

    expect(report.items).toEqual([
      {
        kind: 'stale_model_referenced',
        provider: PROVIDER,
        model: MODEL_A,
        displayName: 'Claude Haiku',
        hostsAffected: [{ namespace: 'mcp-host', name: 'agent-a', roles: ['primary'] }],
        grantsAffected: [],
      },
    ])
    expect(typeof report.generatedAt).toBe('string')
  })

  it('an unreferenced stale model yields no item; empty stale set → empty feed', async () => {
    const gateway = new MockGateway('mcp-host') // no hosts
    expect((await computeAttention([stale(MODEL_A)], sourcesFor(gateway))).items).toEqual([])
    expect((await computeAttention([], sourcesFor(gateway))).items).toEqual([])
  })

  it('grant-only reference produces an item with grantsAffected', async () => {
    const gateway = new MockGateway('mcp-host')
    const report = await computeAttention(
      [stale(MODEL_A)],
      sourcesFor(gateway, { [MODEL_A]: [makeGrantRow(MODEL_A)] })
    )
    expect(report.items).toHaveLength(1)
    expect(report.items[0].grantsAffected).toEqual([
      {
        id: '22222222-2222-4222-8222-222222222222',
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'nightly-summary',
        capabilityFamily: 'promptBridge',
      },
    ])
    expect(report.items[0].hostsAffected).toEqual([])
  })

  it('COST: Host LIST runs once per namespace regardless of stale-set size (memoized)', async () => {
    const gateway = new MockGateway('mcp-host')
    await seedHost(gateway, 'agent-a', MODEL_A)
    const base = sourcesFor(gateway)
    const listSpy = vi.fn(base.listHostsInNamespace)
    const sources: ModelImpactSources = { ...base, listHostsInNamespace: listSpy }

    // Three stale models, two namespaces. Without memoization this would be 6
    // LISTs; memoized it is exactly one per namespace = 2.
    await computeAttention([stale(MODEL_A), stale(MODEL_B), stale('claude-x')], sources)

    expect(listSpy).toHaveBeenCalledTimes(NAMESPACES.length)
    const listedNamespaces = listSpy.mock.calls.map(c => c[0]).sort()
    expect(listedNamespaces).toEqual([...NAMESPACES].sort())
  })

  it('FAILS LOUD: a Host LIST rejection propagates (no partial feed)', async () => {
    const gateway = new MockGateway('mcp-host')
    gateway.listResource = vi.fn(async () => {
      throw new Error('k8s apiserver LIST failed')
    })
    await expect(
      computeAttention([stale(MODEL_A), stale(MODEL_B)], sourcesFor(gateway))
    ).rejects.toThrow(/LIST failed/)
  })

  it('FAILS LOUD on the GRANT side too: a grant-query rejection propagates', async () => {
    // The module docstring claims fail-loud for ANY source, not just the K8s
    // LIST. Prove the PG grant lookup half: if listGrantsForModel rejects, the
    // whole computation rejects rather than dropping a possibly-referenced model.
    const gateway = new MockGateway('mcp-host') // no hosts → forces the grant query to run
    const sources: ModelImpactSources = {
      hostNamespaces: NAMESPACES,
      listHostsInNamespace: namespace => gateway.listResource('hosts', namespace),
      listGrantsForModel: async () => {
        throw new Error('postgres grant query failed')
      },
    }
    await expect(computeAttention([stale(MODEL_A)], sources)).rejects.toThrow(/grant query failed/)
  })
})
