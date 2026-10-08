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

  it('groups agents by their authoritative context and excludes unowned contexts', () => {
    const targets = connectorAgentTargetsFromHosts([
      makeHost('agent-b', 'Beta', 'shared-id'),
      makeHost('agent-a', 'Alpha', 'shared-id'),
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

  it('adds through the resolved context using its resource version and keeps unrelated fields', async () => {
    const context = makeContext('context-resource', 'context-alias', ['other-connector'])
    await addConnectorToAgentContexts(
      { name: 'search', namespace: 'mcp-server' },
      [
        { name: 'agent-a', contextRef: 'context-alias' },
        { name: 'agent-b', contextRef: 'context-resource' },
      ],
      [context],
      {}
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

  it('preserves the existing context/OAuth restriction and does not write on mismatch', async () => {
    await expect(
      addConnectorToAgentContexts(
        { name: 'search', namespace: 'mcp-server' },
        [{ name: 'agent-b', contextRef: 'context-b' }],
        [makeContext('context-a', 'context-a', [])],
        { contextRef: 'context-a', oauth: { grantScope: 'context' } }
      )
    ).rejects.toThrow(/shared OAuth identity/)
    expect(api.updateContext).not.toHaveBeenCalled()
  })

  it('removes only the connector from the existing agent context binding', async () => {
    await removeConnectorFromAgentContext(
      'search',
      { contextRef: 'context-alias', agents: [{ id: 'agent-a', label: 'Alpha' }] },
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
})
