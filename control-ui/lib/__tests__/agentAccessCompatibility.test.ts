import { describe, expect, it, vi } from 'vitest'
import {
  agentNamesForContextAccess,
  applyAgentAccessCompatibilityUpdate,
  effectiveAgentNamesForAccess,
  planAgentAccessUpdate,
} from '../agentAccessCompatibility'
import type { HostResource } from '../api'

const hosts: HostResource[] = [
  { metadata: { name: 'agent-alpha' }, spec: { contextRef: 'ctx-alpha' } },
  { metadata: { name: 'agent-beta' }, spec: { contextRef: 'ctx-beta' } },
]
describe('planAgentAccessUpdate', () => {
  it('derives the effective Agent grant set from direct and Context-only access', () => {
    expect(
      effectiveAgentNamesForAccess({
        assignedAgentNames: ['agent-beta'],
        assignedContextIds: ['ctx-alpha', 'member-private-scope'],
        hosts,
      })
    ).toEqual(['agent-alpha', 'agent-beta'])
  })

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

  it('matches a Host to a membership only by the exact Context name it references', () => {
    const paddedHosts: HostResource[] = [
      { metadata: { name: 'agent-alpha' }, spec: { contextRef: 'ctx-alpha ' } },
    ]

    expect(planAgentAccessUpdate([], ['agent-alpha'], paddedHosts).contextIds).not.toContain(
      'ctx-alpha'
    )
    expect(agentNamesForContextAccess(['ctx-alpha'], paddedHosts)).toEqual([])
  })

  it('keeps a membership stored under a name no Host references while granting by name', () => {
    expect(planAgentAccessUpdate(['ctx-wire'], ['agent-alpha'], hosts)).toEqual({
      agentNames: ['agent-alpha'],
      contextIds: ['ctx-alpha', 'ctx-wire'],
    })
    expect(agentNamesForContextAccess(['ctx-wire'], hosts)).toEqual([])
  })
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
