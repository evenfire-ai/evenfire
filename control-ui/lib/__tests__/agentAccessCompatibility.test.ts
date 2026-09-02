import { describe, expect, it, vi } from 'vitest'
import {
  agentNamesForContextAccess,
  applyAgentAccessCompatibilityUpdate,
  planAgentAccessUpdate,
} from '../agentAccessCompatibility'
import type { ContextResource, HostResource } from '../api'

const hosts: HostResource[] = [
  { metadata: { name: 'agent-alpha' }, spec: { contextRef: 'ctx-alpha' } },
  { metadata: { name: 'agent-beta' }, spec: { contextRef: 'ctx-beta' } },
]
const contexts: ContextResource[] = [
  { metadata: { name: 'ctx-alpha' }, spec: { contextId: 'ctx-alpha', mcpServers: [] } },
  { metadata: { name: 'ctx-beta' }, spec: { contextId: 'ctx-beta', mcpServers: [] } },
  {
    metadata: { name: 'member-private-scope' },
    spec: { contextId: 'member-private-scope', mcpServers: [] },
  },
]

describe('planAgentAccessUpdate', () => {
  it('keeps only the member’s already-assigned unowned scopes', () => {
    const result = planAgentAccessUpdate(['member-private-scope'], ['agent-alpha'], hosts)

    expect(result).toEqual({
      agentNames: ['agent-alpha'],
      contextIds: ['ctx-alpha', 'member-private-scope'],
    })
    expect(result.contextIds).not.toContain('unrelated-unowned-scope')
  })

  it('keeps only the team’s already-assigned unowned scopes', () => {
    const result = planAgentAccessUpdate([], ['agent-beta'], hosts)

    expect(result).toEqual({
      agentNames: ['agent-beta'],
      contextIds: ['ctx-beta'],
    })
    expect(result.contextIds).not.toContain('unrelated-unowned-scope')
  })

  it('drops a revoked Agent scope while retaining a shared selected scope once', () => {
    const sharedHosts: HostResource[] = [
      { metadata: { name: 'agent-alpha' }, spec: { contextRef: 'ctx-shared' } },
      { metadata: { name: 'agent-beta' }, spec: { contextRef: 'ctx-shared' } },
      { metadata: { name: 'agent-revoked' }, spec: { contextRef: 'ctx-revoked' } },
    ]

    expect(
      planAgentAccessUpdate(
        ['ctx-shared', 'ctx-revoked'],
        ['agent-beta', 'agent-alpha'],
        sharedHosts
      )
    ).toEqual({
      agentNames: ['agent-alpha', 'agent-beta'],
      contextIds: ['ctx-shared'],
    })
  })

  it.each(['member', 'team'])(
    'preserves existing %s access through mismatched Context aliases',
    () => {
      const aliasedContexts: ContextResource[] = [
        {
          metadata: { name: 'ctx-resource' },
          spec: { contextId: 'ctx-wire', mcpServers: [] },
        },
      ]
      const aliasedHosts: HostResource[] = [
        { metadata: { name: 'agent-alpha' }, spec: { contextRef: 'ctx-wire' } },
      ]

      expect(
        planAgentAccessUpdate(['ctx-resource'], ['agent-alpha'], aliasedHosts, aliasedContexts)
      ).toEqual({ agentNames: ['agent-alpha'], contextIds: ['ctx-resource'] })
      expect(agentNamesForContextAccess(['ctx-resource'], aliasedHosts, aliasedContexts)).toEqual([
        'agent-alpha',
      ])
    }
  )
})

describe('applyAgentAccessCompatibilityUpdate', () => {
  it.each(['member', 'team'])(
    'does not start the %s Context write when the Agent CAS is stale',
    async () => {
      const staleCas = Object.assign(new Error('Precondition failed'), { status: 412 })
      const updateAgents = vi.fn().mockRejectedValue(staleCas)
      const loadCurrentContextIds = vi.fn().mockResolvedValue(['member-private-scope'])
      const updateContexts = vi.fn().mockResolvedValue({})

      await expect(
        applyAgentAccessCompatibilityUpdate({
          contexts,
          hosts,
          loadCurrentContextIds,
          nextGrantedAgentNames: ['agent-alpha'],
          updateAgents,
          updateContexts,
        })
      ).rejects.toBe(staleCas)
      expect(updateAgents).toHaveBeenCalledOnce()
      expect(loadCurrentContextIds).not.toHaveBeenCalled()
      expect(updateContexts).not.toHaveBeenCalled()
    }
  )

  it.each(['member', 'team'])(
    'does not restore an unowned Context revoked after the %s page loaded',
    async () => {
      const calls: string[] = []
      const updateContexts = vi.fn(async (contextIds: string[]) => {
        calls.push('contexts')
        return { contextIds }
      })

      const result = await applyAgentAccessCompatibilityUpdate({
        contexts,
        hosts,
        loadCurrentContextIds: async () => {
          calls.push('refresh-contexts')
          // The page originally saw ctx-sensitive, but another admin revoked
          // it before this post-CAS refresh.
          return []
        },
        nextGrantedAgentNames: ['agent-alpha'],
        updateAgents: async agentNames => {
          calls.push('agents')
          return { agentNames }
        },
        updateContexts,
      })

      expect(calls).toEqual(['agents', 'refresh-contexts', 'contexts'])
      expect(updateContexts).toHaveBeenCalledWith(['ctx-alpha'])
      expect(updateContexts).not.toHaveBeenCalledWith(expect.arrayContaining(['ctx-sensitive']))
      expect(result[1]).toEqual({ contextIds: ['ctx-alpha'] })
    }
  )

  it('writes refreshed Context compatibility state only after the Agent CAS succeeds', async () => {
    const calls: string[] = []
    const result = await applyAgentAccessCompatibilityUpdate({
      contexts,
      hosts,
      loadCurrentContextIds: async () => {
        calls.push('refresh-contexts')
        return ['member-private-scope']
      },
      nextGrantedAgentNames: ['agent-alpha'],
      updateAgents: async () => {
        calls.push('agents')
        return { agentNames: ['agent-alpha'] }
      },
      updateContexts: async contextIds => {
        calls.push('contexts')
        return { contextIds }
      },
    })

    expect(calls).toEqual(['agents', 'refresh-contexts', 'contexts'])
    expect(result).toEqual([
      { agentNames: ['agent-alpha'] },
      { contextIds: ['ctx-alpha', 'member-private-scope'] },
    ])
  })
})
