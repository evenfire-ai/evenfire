import { describe, expect, it, vi } from 'vitest'
import {
  applyAgentAccessCompatibilityUpdate,
  planAgentAccessUpdate,
} from '../agentAccessCompatibility'
import type { HostResource } from '../api'

const hosts: HostResource[] = [
  { metadata: { name: 'agent-alpha' }, spec: { contextRef: 'ctx-alpha' } },
  { metadata: { name: 'agent-beta' }, spec: { contextRef: 'ctx-beta' } },
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
})

describe('applyAgentAccessCompatibilityUpdate', () => {
  it.each(['member', 'team'])(
    'does not start the %s Context write when the Agent CAS is stale',
    async () => {
      const staleCas = Object.assign(new Error('Precondition failed'), { status: 412 })
      const updateAgents = vi.fn().mockRejectedValue(staleCas)
      const updateContexts = vi.fn().mockResolvedValue({})

      await expect(applyAgentAccessCompatibilityUpdate(updateAgents, updateContexts)).rejects.toBe(
        staleCas
      )
      expect(updateAgents).toHaveBeenCalledOnce()
      expect(updateContexts).not.toHaveBeenCalled()
    }
  )

  it('writes Context compatibility state only after the Agent CAS succeeds', async () => {
    const calls: string[] = []
    const result = await applyAgentAccessCompatibilityUpdate(
      async () => {
        calls.push('agents')
        return { agentNames: ['agent-alpha'] }
      },
      async () => {
        calls.push('contexts')
        return { contextIds: ['ctx-alpha'] }
      }
    )

    expect(calls).toEqual(['agents', 'contexts'])
    expect(result).toEqual([{ agentNames: ['agent-alpha'] }, { contextIds: ['ctx-alpha'] }])
  })
})
