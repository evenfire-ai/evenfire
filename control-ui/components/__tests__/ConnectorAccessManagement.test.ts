import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContextResource, HostResource, McpServerResource } from '@lib/api'
import * as api from '@lib/api'
import {
  addConnectorToAgentContexts,
  connectorAgentBindingsFromContexts,
  connectorAgentTargetsFromHosts,
  loadConnectorAccessState,
  removeConnectorFromAgentContext,
} from '@lib/connectorAccessManagement'

vi.mock('@lib/api', async importOriginal => ({
  ...(await importOriginal<typeof import('@lib/api')>()),
  getAgentTeams: vi.fn(),
  getAgentUsers: vi.fn(),
  updateContext: vi.fn(),
}))

function makeContext(
  name: string,
  contextId: string,
  mcpServers: string[],
  resourceVersion = '7'
): ContextResource {
  return {
    metadata: { name, resourceVersion },
    spec: { contextId, mcpServers, sharedFileSystems: [] },
  }
}

function makeHost(name: string, label: string, contextRef: string): HostResource {
  return { metadata: { name }, spec: { host: label, contextRef } }
}

function makeConnector(name: string): McpServerResource {
  return { metadata: { name, namespace: 'mcp-server' }, spec: {} }
}

describe('connector access management', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('groups agents by the Context they name and excludes unowned contexts', () => {
    const targets = connectorAgentTargetsFromHosts([
      makeHost('agent-b', 'Beta', 'shared-resource'),
      makeHost('agent-a', 'Alpha', 'shared-resource'),
      { metadata: {}, spec: { contextRef: 'missing-name' } },
      makeHost('agent-no-context', 'No Context', ''),
    ])
    const bindings = connectorAgentBindingsFromContexts(
      [
        makeContext('shared-resource', 'shared-id', ['search']),
        makeContext('private-context', 'private-context', ['search']),
      ],
      targets
    )

    expect(targets.map(target => target.label)).toEqual(['Alpha', 'Beta'])
    expect(bindings.search).toEqual([
      {
        contextRef: 'shared-resource',
        agents: [
          { id: 'agent-a', label: 'Alpha' },
          { id: 'agent-b', label: 'Beta' },
        ],
      },
    ])
  })

  it('derives sorted and deduplicated users and teams from the agents carrying the connector', async () => {
    vi.mocked(api.getAgentUsers).mockImplementation(async agentName => ({
      items:
        agentName === 'agent-a'
          ? [{ id: 'user-1', displayName: 'Ada' }]
          : [
              { id: 'user-1', displayName: 'Ada' },
              { id: 'user-2', displayName: 'Grace' },
            ],
    }))
    vi.mocked(api.getAgentTeams).mockImplementation(async agentName => ({
      items:
        agentName === 'agent-a'
          ? [{ id: 'team-1', name: 'Growth' }]
          : [
              { id: 'team-1', name: 'Growth' },
              { id: 'team-2', name: 'Research' },
            ],
    }))
    const state = await loadConnectorAccessState(
      [makeConnector('search')],
      [
        makeContext('context-a', 'context-a', ['search']),
        makeContext('context-b', 'context-b', ['search']),
      ],
      [makeHost('agent-a', 'Alpha', 'context-a'), makeHost('agent-b', 'Beta', 'context-b')]
    )

    expect(state.accessByConnectorKey['mcp-server/search']).toEqual({
      agents: [
        { id: 'agent-a', label: 'Alpha' },
        { id: 'agent-b', label: 'Beta' },
      ],
      users: [
        { id: 'user-1', label: 'Ada' },
        { id: 'user-2', label: 'Grace' },
      ],
      teams: [
        { id: 'team-1', label: 'Growth' },
        { id: 'team-2', label: 'Research' },
      ],
    })
    expect(state.warning).toBe('')
  })

  it('keeps fulfilled access rows and marks the user/team summary incomplete on partial failure', async () => {
    vi.mocked(api.getAgentUsers).mockResolvedValueOnce({ items: [{ id: 'user-1', name: 'Ada' }] })
    vi.mocked(api.getAgentUsers).mockRejectedValueOnce(new Error('directory unavailable'))
    vi.mocked(api.getAgentTeams).mockResolvedValue({ items: [{ id: 'team-1', name: 'Growth' }] })
    const state = await loadConnectorAccessState(
      [makeConnector('search')],
      [
        makeContext('context-a', 'context-a', ['search']),
        makeContext('context-b', 'context-b', ['search']),
      ],
      [makeHost('agent-a', 'Alpha', 'context-a'), makeHost('agent-b', 'Beta', 'context-b')]
    )

    expect(state.accessByConnectorKey['mcp-server/search'].users).toEqual([
      { id: 'user-1', label: 'Ada' },
    ])
    expect(state.accessByConnectorKey['mcp-server/search'].teams).toEqual([
      { id: 'team-1', label: 'Growth' },
    ])
    expect(state.warning).toMatch(/may be incomplete/)
  })

  it('does not let access failures from unrelated connectors warn the selected connector', async () => {
    vi.mocked(api.getAgentUsers).mockImplementation(async agentName => {
      if (agentName === 'agent-unrelated') throw new Error('directory unavailable')
      return { items: [{ id: 'user-1', name: 'Ada' }] }
    })
    vi.mocked(api.getAgentTeams).mockResolvedValue({ items: [{ id: 'team-1', name: 'Growth' }] })
    const state = await loadConnectorAccessState(
      [makeConnector('search')],
      [
        makeContext('selected-context', 'selected-context', ['search']),
        makeContext('unrelated-context', 'unrelated-context', ['other-connector']),
      ],
      [
        makeHost('agent-selected', 'Selected', 'selected-context'),
        makeHost('agent-unrelated', 'Unrelated', 'unrelated-context'),
      ]
    )

    expect(api.getAgentUsers).toHaveBeenCalledTimes(1)
    expect(api.getAgentUsers).toHaveBeenCalledWith('agent-selected')
    expect(api.getAgentTeams).toHaveBeenCalledTimes(1)
    expect(api.getAgentTeams).toHaveBeenCalledWith('agent-selected')
    expect(state.accessByConnectorKey['mcp-server/search'].users).toEqual([
      { id: 'user-1', label: 'Ada' },
    ])
    expect(state.warning).toBe('')
  })

  it('adds through the named context using its resource version and keeps its alias as stored', async () => {
    const context = makeContext('context-resource', 'context-alias', ['other-connector'])
    await addConnectorToAgentContexts(
      { name: 'search', namespace: 'mcp-server' },
      [
        { name: 'agent-a', contextRef: 'context-resource' },
        { name: 'agent-b', contextRef: 'context-resource' },
      ],
      [context]
    )

    expect(api.updateContext).toHaveBeenCalledTimes(1)
    expect(api.updateContext).toHaveBeenCalledWith('context-resource', {
      metadata: { resourceVersion: '7' },
      spec: {
        contextId: 'context-alias',
        mcpServers: ['other-connector', 'search'],
        sharedFileSystems: [],
      },
    })
  })

  it('refuses to write when an agent references a Context that is not loaded', async () => {
    await expect(
      addConnectorToAgentContexts(
        { name: 'search', namespace: 'mcp-server' },
        [{ name: 'agent-b', contextRef: 'context-alias' }],
        [makeContext('context-resource', 'context-alias', [])]
      )
    ).rejects.toThrow(/could not be resolved/)
    expect(api.updateContext).not.toHaveBeenCalled()
  })

  it('removes only the connector from the existing agent context binding', async () => {
    await removeConnectorFromAgentContext(
      'search',
      { contextRef: 'context-resource', agents: [{ id: 'agent-a', label: 'Alpha' }] },
      [makeContext('context-resource', 'context-alias', ['search', 'other-connector'])]
    )

    expect(api.updateContext).toHaveBeenCalledWith('context-resource', {
      metadata: { resourceVersion: '7' },
      spec: {
        contextId: 'context-alias',
        mcpServers: ['other-connector'],
        sharedFileSystems: [],
      },
    })
  })

  describe('when another Context carries the agent Context name as its alias', () => {
    // B is listed first so a lookup that also accepts spec.contextId would hit it before A.
    const collidingAlias = makeContext('ctx-b', 'ctx-a', ['search'], 'rv-b')
    const target = makeContext('ctx-a', 'ctx-a', [], 'rv-a')
    const contexts = [collidingAlias, target]

    it('binds the agent only to the Context whose name it references', () => {
      const targets = connectorAgentTargetsFromHosts([makeHost('agent-a', 'Alpha', 'ctx-a')])

      expect(connectorAgentBindingsFromContexts(contexts, targets)).toEqual({})
    })

    it('adds the connector to the named Context, never to the aliased one', async () => {
      await addConnectorToAgentContexts(
        { name: 'search', namespace: 'mcp-server' },
        [{ name: 'agent-a', contextRef: 'ctx-a' }],
        contexts
      )

      expect(api.updateContext).toHaveBeenCalledTimes(1)
      expect(api.updateContext).toHaveBeenCalledWith('ctx-a', {
        metadata: { resourceVersion: 'rv-a' },
        spec: { contextId: 'ctx-a', mcpServers: ['search'], sharedFileSystems: [] },
      })
    })

    it('removes the connector from the named Context, never from the aliased one', async () => {
      const named = makeContext('ctx-a', 'ctx-a', ['search', 'other'], 'rv-a')
      await removeConnectorFromAgentContext(
        'search',
        { contextRef: 'ctx-a', agents: [{ id: 'agent-a', label: 'Alpha' }] },
        [collidingAlias, named]
      )

      expect(api.updateContext).toHaveBeenCalledTimes(1)
      expect(api.updateContext).toHaveBeenCalledWith('ctx-a', {
        metadata: { resourceVersion: 'rv-a' },
        spec: { contextId: 'ctx-a', mcpServers: ['other'], sharedFileSystems: [] },
      })
    })
  })

  it('does not bind a Host whose contextRef only matches after trimming', () => {
    const targets = connectorAgentTargetsFromHosts([makeHost('agent-a', 'Alpha', 'ctx-a ')])
    const bindings = connectorAgentBindingsFromContexts(
      [makeContext('ctx-a', 'ctx-a', ['search'])],
      targets
    )

    expect(bindings.search).toBeUndefined()
  })
})
