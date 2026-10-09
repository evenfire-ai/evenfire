import { describe, expect, it, vi } from 'vitest'
import { config } from '../src/config.js'
import {
  type ContextMembershipDirectory,
  getUserMemberContexts,
} from '../src/services/access/contextMembership.js'
import { MockGateway } from './mockGateway.js'

/**
 * #989 — OAuth connect membership must follow agent access. A user granted an
 * agent (user_agents, or team_agents via an active team) is a member of that
 * agent's Context, even without a legacy user_contexts row.
 */

function seedHost(
  gateway: MockGateway,
  name: string,
  contextRef: string,
  opts: { enabled?: boolean } = {}
): void {
  void gateway.createResource(
    'hosts',
    {
      metadata: { name },
      spec: { contextRef, ...(opts.enabled === false ? { enabled: false } : {}) },
    },
    config.hostsNamespace
  )
}

function directory(
  overrides: Partial<{
    userContexts: string[]
    userAgents: string[]
    teams: string[]
    teamAgents: Record<string, string[]>
  }> = {}
): ContextMembershipDirectory {
  return {
    getUserContexts: vi.fn(async (userId: string) => ({
      userId,
      contextIds: overrides.userContexts ?? [],
    })),
    getUserAgents: vi.fn(async (userId: string) => ({
      userId,
      agentNames: overrides.userAgents ?? [],
    })),
    listTeams: vi.fn(async (_userId: string, currentTeamId: string) => ({
      currentTeamId,
      items: (overrides.teams ?? []).map(id => ({ id, name: id, role: 'member' })),
    })),
    getTeamAgents: vi.fn(async (teamId: string) => ({
      teamId,
      agentNames: overrides.teamAgents?.[teamId] ?? [],
    })),
  }
}

describe('getUserMemberContexts (#989)', () => {
  it('keeps the legacy user_contexts membership', async () => {
    const gateway = new MockGateway()
    const result = await getUserMemberContexts(
      gateway as never,
      'user-1',
      directory({ userContexts: ['ctx-legacy'] })
    )
    expect(result.contextIds).toEqual(['ctx-legacy'])
  })

  it('adds the Context of an agent granted directly to the user (user_agents)', async () => {
    const gateway = new MockGateway()
    seedHost(gateway, 'jose-agent', 'jose-agent-60946')
    seedHost(gateway, 'other-agent', 'other-ctx')
    const result = await getUserMemberContexts(
      gateway as never,
      'user-1',
      directory({ userAgents: ['jose-agent'] })
    )
    expect(result.contextIds).toEqual(['jose-agent-60946'])
  })

  it("adds the Context of an agent granted to one of the user's active teams (team_agents)", async () => {
    const gateway = new MockGateway()
    seedHost(gateway, 'team-agent', 'team-ctx')
    const result = await getUserMemberContexts(
      gateway as never,
      'user-1',
      directory({ teams: ['team-a', 'team-b'], teamAgents: { 'team-b': ['team-agent'] } })
    )
    expect(result.contextIds).toEqual(['team-ctx'])
  })

  it('ignores a disabled agent, matching chat access', async () => {
    const gateway = new MockGateway()
    seedHost(gateway, 'off-agent', 'off-ctx', { enabled: false })
    const result = await getUserMemberContexts(
      gateway as never,
      'user-1',
      directory({ userAgents: ['off-agent'] })
    )
    expect(result.contextIds).toEqual([])
  })

  // Mirrors the connectors producer (buildAgentDirectoryEntry): a Host it would
  // not list must not grant membership either.
  it.each([
    [
      'being deleted',
      {
        name: 'gone-agent',
        namespace: config.hostsNamespace,
        deletionTimestamp: '2026-10-01T00:00:00Z',
      },
    ],
    ['reported from another namespace', { name: 'gone-agent', namespace: 'elsewhere' }],
  ])('ignores a granted agent whose Host is %s', async (_label, metadata) => {
    const gateway = {
      listResource: vi.fn(async () => [{ metadata, spec: { contextRef: 'gone-ctx' } }]),
    }
    const result = await getUserMemberContexts(
      gateway as never,
      'user-1',
      directory({ userAgents: ['gone-agent'] })
    )
    expect(result.contextIds).toEqual([])
  })

  it('ignores a granted agent whose Host no longer exists', async () => {
    const gateway = new MockGateway()
    const result = await getUserMemberContexts(
      gateway as never,
      'user-1',
      directory({ userAgents: ['deleted-agent'] })
    )
    expect(result.contextIds).toEqual([])
  })

  it('does not read Hosts when the user has no agent grants', async () => {
    const gateway = new MockGateway()
    const listResource = vi.spyOn(gateway, 'listResource')
    await getUserMemberContexts(gateway as never, 'user-1', directory({ userContexts: ['ctx'] }))
    expect(listResource).not.toHaveBeenCalled()
  })

  it('deduplicates and sorts the union', async () => {
    const gateway = new MockGateway()
    seedHost(gateway, 'a', 'ctx-b')
    seedHost(gateway, 'b', 'ctx-a')
    const result = await getUserMemberContexts(
      gateway as never,
      'user-1',
      directory({
        userContexts: ['ctx-b'],
        userAgents: ['a'],
        teams: ['t'],
        teamAgents: { t: ['a', 'b'] },
      })
    )
    expect(result.contextIds).toEqual(['ctx-a', 'ctx-b'])
  })

  // PR #1004 R2: a Host contextRef names a Context RESOURCE while a legacy
  // user_contexts id may be a wire-id alias, so membership keeps each
  // reference's origin for the identity resolver.
  it('tags each reference with its origin and keeps the same string from both origins', async () => {
    const gateway = new MockGateway()
    seedHost(gateway, 'a', 'ctx-a')
    seedHost(gateway, 'b', 'ctx-shared')
    const result = await getUserMemberContexts(
      gateway as never,
      'user-1',
      directory({
        userContexts: ['ctx-shared', 'ctx-wire-legacy'],
        userAgents: ['a', 'b'],
        teams: ['t'],
        teamAgents: { t: ['a'] },
      })
    )
    expect(result.members).toEqual([
      { ref: 'ctx-a', origin: 'host' },
      { ref: 'ctx-shared', origin: 'host' },
      { ref: 'ctx-shared', origin: 'legacy' },
      { ref: 'ctx-wire-legacy', origin: 'legacy' },
    ])
    expect(result.contextIds).toEqual(['ctx-a', 'ctx-shared', 'ctx-wire-legacy'])
  })

  it('has no members for a user without grants', async () => {
    const result = await getUserMemberContexts(new MockGateway() as never, 'user-1', directory())
    expect(result.members).toEqual([])
  })
})
