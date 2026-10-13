import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  agentAccessTargetsFromHosts,
  attachServerToAgentContexts,
  resolveAgentContextRefs,
} from '../agentAccessTargets'
import * as api from '../api'

vi.mock('../api', async importOriginal => ({
  ...(await importOriginal<typeof import('../api')>()),
  getContext: vi.fn(),
  updateContext: vi.fn(),
}))

const TARGETS = [
  {
    name: 'agents/product',
    label: 'Product',
    description: 'agents/product',
    contextRef: 'ctx-product',
  },
  { name: 'agents/sales', label: 'Sales', description: 'agents/sales', contextRef: 'ctx-sales' },
  {
    name: 'agents/sales-2',
    label: 'Sales 2',
    description: 'agents/sales-2',
    contextRef: 'ctx-sales',
  },
]

describe('agentAccessTargetsFromHosts', () => {
  it('keeps Hosts that own a Context, labelled and sorted by display name', () => {
    const targets = agentAccessTargetsFromHosts([
      { metadata: { name: 'zeta' }, spec: { contextRef: ' ctx-z ' } },
      { metadata: { name: 'no-context' }, spec: {} },
      { metadata: { name: 'alpha' }, spec: { contextRef: 'ctx-a' } },
    ])
    expect(targets.map(target => [target.name, target.contextRef])).toEqual([
      ['alpha', 'ctx-a'],
      ['zeta', 'ctx-z'],
    ])
  })

  it('labels an agent with its display name (spec.host) when it has one', () => {
    const [target] = agentAccessTargetsFromHosts([
      { metadata: { name: 'jose-agent' }, spec: { contextRef: 'ctx', host: 'Jose Assistant' } },
    ])
    expect(target.label).toBe('Jose Assistant')
  })

  it('describes each agent with its immutable name', () => {
    const [target] = agentAccessTargetsFromHosts([
      { metadata: { name: 'jose-agent' }, spec: { contextRef: 'ctx', host: 'Jose Assistant' } },
    ])
    expect(target.description).toBe('jose-agent')
  })

  it('qualifies agents that share a display name with their name, and only those', () => {
    const targets = agentAccessTargetsFromHosts([
      { metadata: { name: 'research-two' }, spec: { contextRef: 'ctx-2', host: 'Research' } },
      { metadata: { name: 'ops-agent' }, spec: { contextRef: 'ctx-ops', host: 'Ops' } },
      { metadata: { name: 'research-one' }, spec: { contextRef: 'ctx-1', host: 'Research' } },
    ])
    expect(targets.map(target => [target.label, target.description, target.contextRef])).toEqual([
      ['Ops', 'ops-agent', 'ctx-ops'],
      ['Research (research-one)', 'research-one', 'ctx-1'],
      ['Research (research-two)', 'research-two', 'ctx-2'],
    ])
  })
})

describe('resolveAgentContextRefs', () => {
  it('returns the distinct Contexts of the selected agents, in selection order', () => {
    const resolved = resolveAgentContextRefs(
      ['agents/sales', 'agents/product', 'agents/sales-2', 'agents/missing'],
      TARGETS
    )
    expect(resolved.contextRefs).toEqual(['ctx-sales', 'ctx-product'])
    expect(resolved.selectedTargets.map(target => target.name)).toEqual([
      'agents/sales',
      'agents/product',
      'agents/sales-2',
    ])
  })
})

describe('attachServerToAgentContexts', () => {
  afterEach(() => {
    vi.mocked(api.getContext).mockReset()
    vi.mocked(api.updateContext).mockReset()
  })

  it('appends the server to each Context with a CAS write and skips ones that have it', async () => {
    vi.mocked(api.getContext).mockImplementation(async name => ({
      metadata: { name, resourceVersion: `rv-${name}` },
      spec: { contextId: name, mcpServers: name === 'ctx-sales' ? ['linear'] : ['other'] },
    }))
    vi.mocked(api.updateContext).mockResolvedValue({} as never)

    const failed = await attachServerToAgentContexts(
      'linear',
      ['ctx-product', 'ctx-sales'],
      TARGETS
    )

    expect(failed).toEqual([])
    expect(api.updateContext).toHaveBeenCalledTimes(1)
    expect(api.updateContext).toHaveBeenCalledWith(
      'ctx-product',
      expect.objectContaining({
        metadata: expect.objectContaining({ resourceVersion: 'rv-ctx-product' }),
        spec: expect.objectContaining({ mcpServers: ['other', 'linear'] }),
      })
    )
  })

  it('reports the labels of every agent whose Context could not be updated', async () => {
    vi.mocked(api.getContext).mockImplementation(async name => {
      if (name === 'ctx-sales') throw new Error('boom')
      return { metadata: { name, resourceVersion: 'rv' }, spec: { mcpServers: [] } }
    })
    vi.mocked(api.updateContext).mockResolvedValue({} as never)

    const failed = await attachServerToAgentContexts(
      'linear',
      ['ctx-product', 'ctx-sales'],
      TARGETS
    )

    expect(failed).toEqual(['Sales', 'Sales 2'])
  })
})
