import { describe, expect, it, vi } from 'vitest'
import {
  AuthorizationRequestMemo,
  resolveLiveAuthorizationInTransaction,
} from '../src/services/access/liveAuthorizationResolver.js'
import { canonicalResourceIdentity } from '../src/services/access/resourceIdentity.js'

const host = canonicalResourceIdentity({
  environmentId: 'cluster-a',
  type: 'host',
  logicalId: 'mcp-host/agent-a',
  displayName: 'Agent A',
})

function principalRow(overrides: Record<string, unknown> = {}) {
  return {
    user_id: '00000000-0000-4000-8000-000000000001',
    user_revision: 7,
    resource_revision: 3,
    session_live: true,
    memberships: [
      {
        teamId: '00000000-0000-4000-8000-000000000010',
        role: 'member',
        membershipUpdatedAt: '2026-08-10T12:00:00.000Z',
        teamRevision: 4,
      },
      {
        teamId: '00000000-0000-4000-8000-000000000020',
        role: 'admin',
        membershipUpdatedAt: '2026-08-10T12:01:00.000Z',
        teamRevision: 9,
      },
    ],
    ...overrides,
  }
}

function dbFor(grants: Record<string, unknown>[], principal = principalRow()) {
  return {
    query: vi
      .fn()
      .mockResolvedValueOnce({ rows: [principal], rowCount: 1 })
      .mockResolvedValueOnce({ rows: grants, rowCount: grants.length }),
  }
}

describe('live authorization resolver', () => {
  it('uses every current membership and retains all direct/team provenance', async () => {
    const direct = {
      kind: 'direct',
      grant_id: 'user_agents:user-1:agent-a',
      capabilities: ['host.read'],
    }
    const teamA = {
      kind: 'team',
      grant_id: 'team_agents:team-a:agent-a',
      team_id: '00000000-0000-4000-8000-000000000010',
      current_role: 'member',
      capabilities: ['host.read'],
    }
    const teamB = {
      kind: 'team',
      grant_id: 'team_agents:team-b:agent-a',
      team_id: '00000000-0000-4000-8000-000000000020',
      current_role: 'admin',
      capabilities: ['host.read'],
    }
    const db = dbFor([direct, teamB, teamA])

    const result = await resolveLiveAuthorizationInTransaction(
      {
        principalUserId: '00000000-0000-4000-8000-000000000001',
        sid: '00000000-0000-4000-8000-000000000100',
        requiredCapability: 'host.read',
        resource: host,
      },
      db
    )

    expect(result.status).toBe('allowed')
    if (result.status !== 'allowed') return
    expect(result.paths).toHaveLength(3)
    expect(
      result.paths
        .map(path => path.teamId)
        .filter(Boolean)
        .sort()
    ).toEqual(['00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000020'])
    expect(result.paths.find(path => path.teamId?.endsWith('20'))?.currentRole).toBe('admin')
    expect(result.authorizationRevision).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(db.query.mock.calls[1]?.[1]?.[3]).toEqual([
      '00000000-0000-4000-8000-000000000010',
      '00000000-0000-4000-8000-000000000020',
    ])
  })

  it('requires an explicit path when current path behaviors differ', async () => {
    const db = dbFor([
      {
        kind: 'direct',
        grant_id: 'user_agents:user-1:agent-a',
        capabilities: ['host.read'],
        budget_ref: 'personal-budget',
      },
      {
        kind: 'team',
        grant_id: 'team_agents:team-a:agent-a',
        team_id: '00000000-0000-4000-8000-000000000010',
        current_role: 'member',
        capabilities: ['host.read'],
        budget_ref: 'team-budget',
      },
    ])

    const result = await resolveLiveAuthorizationInTransaction(
      {
        principalUserId: '00000000-0000-4000-8000-000000000001',
        requiredCapability: 'host.read',
        resource: host,
        requireSelectedPath: true,
      },
      db
    )

    expect(result.status).toBe('access_path_required')
    if (result.status === 'access_path_required') {
      expect(result.safePathDescriptors).toHaveLength(2)
      expect(result.safePathDescriptors.every(path => path.id.startsWith('ap1_'))).toBe(true)
    }
  })

  it('rejects stale or tampered path handles and fails unknown capabilities closed', async () => {
    const stale = await resolveLiveAuthorizationInTransaction(
      {
        principalUserId: '00000000-0000-4000-8000-000000000001',
        requiredCapability: 'host.read',
        resource: host,
        requestedAccessPathId: 'ap1_tampered',
      },
      dbFor([
        {
          kind: 'direct',
          grant_id: 'user_agents:user-1:agent-a',
          capabilities: ['host.read'],
        },
      ])
    )
    expect(stale.status).toBe('access_path_stale')

    const denied = await resolveLiveAuthorizationInTransaction(
      {
        principalUserId: '00000000-0000-4000-8000-000000000001',
        requiredCapability: 'host.teleport',
        resource: host,
      },
      { query: vi.fn() }
    )
    expect(denied).toEqual({ status: 'denied', code: 'unknown_capability' })
  })

  it('denies a revoked session and request-local memoization isolates path and target', async () => {
    const revoked = await resolveLiveAuthorizationInTransaction(
      {
        principalUserId: '00000000-0000-4000-8000-000000000001',
        sid: '00000000-0000-4000-8000-000000000100',
        requiredCapability: 'host.read',
        resource: host,
      },
      dbFor([], principalRow({ session_live: false }))
    )
    expect(revoked).toEqual({ status: 'denied', code: 'session_not_live' })

    const memo = new AuthorizationRequestMemo()
    const factory = vi.fn().mockResolvedValue({ status: 'denied', code: 'forbidden' })
    const base = {
      principalUserId: '00000000-0000-4000-8000-000000000001',
      requiredCapability: 'host.read',
      resource: host,
    }
    await memo.getOrCreate(base, factory)
    await memo.getOrCreate(base, factory)
    await memo.getOrCreate({ ...base, requestedAccessPathId: 'ap1_other' }, factory)
    await memo.getOrCreate({ ...base, operationTarget: { teamId: 'team-a' } }, factory)
    expect(factory).toHaveBeenCalledTimes(3)
  })
})
