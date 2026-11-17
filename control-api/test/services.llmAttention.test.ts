import { describe, expect, it, vi } from 'vitest'
import type { AttentionCandidateRow } from '../src/services/llmAllowedModels.js'
import { computeAttention } from '../src/services/llmAttention.js'
import {
  type ModelConsumerSources,
  modelConsumerSourcesFromGateway,
} from '../src/services/llmModelConsumers.js'
import { MockGateway } from './mockGateway.js'

// Cost and fail-loud guarantees of the feed builder, over sources wired to the
// real gateway producer. What the feed emits for each consumer and
// acknowledgement is asserted against real PostgreSQL in
// llmAttention.realPostgres.integration.test.ts.

const PROVIDER = 'claude'
const HOST_NAMESPACES = ['mcp-host', 'control-api']
const RECIPE_NAMESPACES = ['sandbox-recipes']

vi.mock('../src/services/pluginWorkloadSdkDb.js', () => ({
  listGrantsReferencingModel: vi.fn(async () => []),
  listGrantsReferencingPromptTarget: vi.fn(async () => []),
}))

function candidate(model: string): AttentionCandidateRow {
  return {
    provider: PROVIDER,
    model,
    display_name: null,
    stale: true,
    deprecated: true,
    stale_episode: 1,
    deprecated_episode: 1,
    attention_ack: null,
  }
}

function sourcesFor(gateway: MockGateway): ModelConsumerSources {
  return modelConsumerSourcesFromGateway(gateway, {
    hostNamespaces: HOST_NAMESPACES,
    recipeNamespaces: RECIPE_NAMESPACES,
  })
}

describe('computeAttention', () => {
  it('I-C1: one Host LIST per namespace and one recipe LIST per request, whatever the row count', async () => {
    const gateway = new MockGateway('mcp-host')
    await gateway.createResource(
      'hosts',
      { metadata: { name: 'agent-a' }, spec: { model: { provider: PROVIDER, name: 'm-1' } } },
      'mcp-host'
    )
    const base = sourcesFor(gateway)
    const listHosts = vi.fn(base.listHostsInNamespace)
    const listRecipes = vi.fn(base.listRecipesInNamespace)

    await computeAttention([candidate('m-1'), candidate('m-2'), candidate('m-3')], {
      ...base,
      listHostsInNamespace: listHosts,
      listRecipesInNamespace: listRecipes,
    })

    expect(listHosts.mock.calls.map(c => c[0]).sort()).toEqual([...HOST_NAMESPACES].sort())
    expect(listRecipes.mock.calls.map(c => c[0])).toEqual(RECIPE_NAMESPACES)
  })

  it.each([
    [
      'Host LIST',
      { listHostsInNamespace: async () => Promise.reject(new Error('host LIST failed')) },
    ],
    [
      'recipe LIST',
      { listRecipesInNamespace: async () => Promise.reject(new Error('recipe LIST failed')) },
    ],
    [
      'allowed_models grant query',
      { listGrantsForModel: async () => Promise.reject(new Error('grant query failed')) },
    ],
    [
      'prompt-target grant query',
      { listPromptTargetGrants: async () => Promise.reject(new Error('prompt query failed')) },
    ],
  ] as const)('fails loud when the %s rejects (no partial feed)', async (_name, failing) => {
    const gateway = new MockGateway('mcp-host')
    await expect(
      computeAttention([candidate('m-1')], { ...sourcesFor(gateway), ...failing })
    ).rejects.toThrow(/failed/)
  })
})
