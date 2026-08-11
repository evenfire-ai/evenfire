import { describe, expect, it, vi } from 'vitest'
import {
  AuthorizationRequestMemo,
  resolveLiveAuthorization,
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

    expect(result.status).toBe('access_path_required')
    if (result.status !== 'access_path_required') return
    expect(result.safePathDescriptors).toHaveLength(3)
    expect(
      result.safePathDescriptors
        .map(path => path.teamId)
        .filter(Boolean)
        .sort()
    ).toEqual(['00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000020'])
    expect(db.query.mock.calls[1]?.[1]?.[2]).toBe('agent-a')
    expect(db.query.mock.calls[1]?.[1]?.[3]).toEqual([
      '00000000-0000-4000-8000-000000000010',
      '00000000-0000-4000-8000-000000000020',
    ])
  })

  it('selects a deterministic path only when every current behavior is equivalent', async () => {
    const result = await resolveLiveAuthorizationInTransaction(
      {
        principalUserId: '00000000-0000-4000-8000-000000000001',
        requiredCapability: 'host.read',
        resource: host,
      },
      dbFor([
        {
          kind: 'direct',
          grant_id: 'user_agents:user-1:agent-z',
          capabilities: ['host.read'],
        },
        {
          kind: 'direct',
          grant_id: 'user_agents:user-1:agent-a',
          capabilities: ['host.read'],
        },
      ])
    )

    expect(result.status).toBe('allowed')
    if (result.status !== 'allowed') return
    expect(result.paths).toHaveLength(2)
    expect(result.selectedPath?.grantId).toBe('user_agents:user-1:agent-a')
    expect(result.resolvedBehavior).toEqual(result.selectedPath?.behavior)
  })

  it('binds team-member targets to a current relationship in the same snapshot', async () => {
    const team = canonicalResourceIdentity({
      environmentId: 'cluster-a',
      type: 'team',
      logicalId: '00000000-0000-4000-8000-000000000010',
      displayName: 'Team A',
    })
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [principalRow()], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }),
    }

    const result = await resolveLiveAuthorizationInTransaction(
      {
        principalUserId: '00000000-0000-4000-8000-000000000001',
        requiredCapability: 'team.member.manage',
        resource: team,
        operationTarget: {
          teamId: team.logicalId,
          userId: '00000000-0000-4000-8000-000000000099',
        },
      },
      db
    )

    expect(result).toEqual({ status: 'denied', code: 'forbidden' })
    expect(String(db.query.mock.calls[1]?.[0])).toContain("status = 'active'")
    expect(db.query.mock.calls[1]?.[1]).toEqual([
      team.logicalId,
      '00000000-0000-4000-8000-000000000099',
    ])
  })

  it('does not let an inviter authorize an administrator invitation target', async () => {
    const team = canonicalResourceIdentity({
      environmentId: 'cluster-a',
      type: 'team',
      logicalId: '00000000-0000-4000-8000-000000000010',
      displayName: 'Team A',
    })
    const inviterPrincipal = principalRow({
      memberships: [
        {
          teamId: team.logicalId,
          role: 'inviter',
          membershipUpdatedAt: '2026-08-10T12:00:00.000Z',
          teamRevision: 4,
        },
      ],
    })

    const result = await resolveLiveAuthorizationInTransaction(
      {
        principalUserId: '00000000-0000-4000-8000-000000000001',
        requiredCapability: 'team.member.invite',
        resource: team,
        operationTarget: { teamId: team.logicalId, role: 'admin' },
      },
      dbFor(
        [
          {
            kind: 'team',
            grant_id: `team_members:${team.logicalId}:user-1`,
            team_id: team.logicalId,
            current_role: 'inviter',
            capabilities: ['team.member.invite'],
          },
        ],
        inviterPrincipal
      )
    )

    expect(result).toEqual({ status: 'denied', code: 'forbidden' })
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
      },
      db
    )

    expect(result.status).toBe('access_path_required')
    if (result.status === 'access_path_required') {
      expect(result.safePathDescriptors).toHaveLength(2)
      expect(result.safePathDescriptors.every(path => path.id.startsWith('ap1_'))).toBe(true)
    }
  })

  it('binds explicit target-team context and cannot satisfy it with a direct or other-team path', async () => {
    const result = await resolveLiveAuthorizationInTransaction(
      {
        principalUserId: '00000000-0000-4000-8000-000000000001',
        requiredCapability: 'host.read',
        resource: host,
        operationTarget: { teamId: '00000000-0000-4000-8000-000000000020' },
      },
      dbFor([
        {
          kind: 'direct',
          grant_id: 'user_agents:user-1:agent-a',
          capabilities: ['host.read'],
        },
        {
          kind: 'team',
          grant_id: 'team_agents:team-a:agent-a',
          team_id: '00000000-0000-4000-8000-000000000010',
          current_role: 'member',
          capabilities: ['host.read'],
        },
      ])
    )

    expect(result).toEqual({ status: 'denied', code: 'forbidden' })
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

  it('treats deleted operational resources as not found before grant evaluation', async () => {
    const result = await resolveLiveAuthorization(
      {
        principalUserId: '00000000-0000-4000-8000-000000000001',
        requiredCapability: 'host.read',
        resource: host,
      },
      {
        gateway: {
          getResource: vi.fn().mockResolvedValue({
            metadata: {
              name: 'agent-a',
              namespace: 'mcp-host',
              deletionTimestamp: '2026-08-10T14:00:00.000Z',
            },
          }),
          listResource: vi.fn(),
        } as never,
      }
    )

    expect(result).toEqual({ status: 'not_found', code: 'not_found' })
  })

  it('returns typed unavailable when operational lifecycle cannot be verified', async () => {
    const result = await resolveLiveAuthorization(
      {
        principalUserId: '00000000-0000-4000-8000-000000000001',
        requiredCapability: 'host.read',
        resource: host,
      },
      {
        correlationId: 'corr-operational',
        gateway: {
          getResource: vi.fn().mockRejectedValue(new Error('internal cluster endpoint')),
          listResource: vi.fn(),
        } as never,
      }
    )

    expect(result).toEqual({
      status: 'unavailable',
      dependencyClass: 'operational_resource_store',
      retryable: true,
      correlationId: 'corr-operational',
    })
  })
})
