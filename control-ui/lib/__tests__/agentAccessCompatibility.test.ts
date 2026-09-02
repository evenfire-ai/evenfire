import { describe, expect, it } from 'vitest'
import { planAgentAccessUpdate } from '../agentAccessCompatibility'
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
