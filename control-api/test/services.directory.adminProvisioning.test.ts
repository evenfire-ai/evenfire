import { beforeEach, vi } from 'vitest'
import { describe, expect, it } from 'vitest'
import type { DbClient } from '../src/db.js'
import { ensureDefaultTeamAndGrants } from '../src/services/directory/adminProvisioning.js'

const dbMocks = vi.hoisted(() => ({ txQuery: vi.fn() }))
const traceMocks = vi.hoisted(() => ({ appendPermissionEvents: vi.fn() }))
const operatorLinkMocks = vi.hoisted(() => ({ linkInTransaction: vi.fn() }))
vi.mock('../src/db.js', () => ({
  pool: { query: vi.fn() },
  withTransaction: async (work: (db: { query: typeof dbMocks.txQuery }) => Promise<unknown>) =>
    work({ query: dbMocks.txQuery }),
}))
vi.mock('../src/services/tracing/controlApiPermissionEvents.js', () => ({
  appendControlApiPermissionEventsInTransaction: traceMocks.appendPermissionEvents,
}))
vi.mock('../src/services/gfsDesktopOperatorLinkService.js', () => ({
  gfsDesktopOperatorLinkService: {
    linkInTransaction: operatorLinkMocks.linkInTransaction,
  },
}))

describe('ensureDefaultTeamAndGrants', () => {
  it('creates team + admin membership + team/user grants when user has none', async () => {
    const query = vi.fn()
    query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // SELECT admin team → none
      .mockResolvedValueOnce({ rows: [{ id: 'team-1' }], rowCount: 1 }) // INSERT teams
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // INSERT team_members
      .mockResolvedValue({ rows: [], rowCount: 1 }) // grants
    const db: Pick<DbClient, 'query'> = { query }

    const teamId = await ensureDefaultTeamAndGrants(db, 'user-1', 'Ada', ['chatllm'], ['context1'])

    expect(teamId).toBe('team-1')
    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO teams'), ['Ada team'])
    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO team_members'), [
      'team-1',
      'user-1',
    ])
    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO team_agents'), [
      'team-1',
      'chatllm',
    ])
    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO user_agents'), [
      'user-1',
      'chatllm',
    ])
    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO team_contexts'), [
      'team-1',
      'context1',
    ])
    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO user_contexts'), [
      'user-1',
      'context1',
    ])
  })

  it('reuses the existing admin team (no INSERT INTO teams)', async () => {
    const query = vi.fn()
    query
      .mockResolvedValueOnce({ rows: [{ id: 'team-existing' }], rowCount: 1 }) // SELECT admin team
      .mockResolvedValue({ rows: [], rowCount: 1 }) // grants
    const db: Pick<DbClient, 'query'> = { query }

    const teamId = await ensureDefaultTeamAndGrants(db, 'user-1', 'Ada', ['chatllm'], ['context1'])

    expect(teamId).toBe('team-existing')
    expect(query).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO teams'),
      expect.anything()
    )
  })
})

describe('provisionAdminDesktopWorkspace', () => {
  beforeEach(() => {
    dbMocks.txQuery.mockReset()
    operatorLinkMocks.linkInTransaction.mockReset()
    operatorLinkMocks.linkInTransaction.mockResolvedValue({
      created: true,
      link: {
        desktopUserId: 'user-1',
        controlAdminId: 'admin-1',
        source: 'initial_setup',
        createdAt: new Date('2026-08-10T12:00:00.000Z'),
      },
    })
  })

  it('creates user, sets password, and provisions team + grants for a new email', async () => {
    dbMocks.txQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // SELECT users by email → none
      .mockResolvedValueOnce({ rows: [{ id: 'user-1' }], rowCount: 1 }) // INSERT users
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // INSERT profiles
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE users password
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // SELECT admin team → none
      .mockResolvedValueOnce({ rows: [{ id: 'team-1' }], rowCount: 1 }) // INSERT teams
      .mockResolvedValue({ rows: [], rowCount: 1 }) // membership + grants

    const mod = await import('../src/services/directory/adminProvisioning.js')
    await mod.provisionAdminDesktopWorkspace({
      controlAdminId: 'admin-1',
      email: 'New@Example.com',
      displayName: 'Ada',
      passwordHash: 'HASH',
      agentNames: ['chatllm'],
      contextIds: ['context1'],
      linkDesktopOperator: false,
    })

    expect(dbMocks.txQuery).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO users'), [
      'new@example.com',
      'Ada',
    ])
    expect(dbMocks.txQuery).toHaveBeenCalledWith(expect.stringContaining('UPDATE users'), [
      'user-1',
      'HASH',
    ])
    expect(dbMocks.txQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO team_agents'),
      ['team-1', 'chatllm']
    )
  })

  it('reuses an existing user (no INSERT INTO users) and still sets the password', async () => {
    dbMocks.txQuery
      .mockResolvedValueOnce({ rows: [{ id: 'user-9' }], rowCount: 1 }) // SELECT users by email → found
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // INSERT profiles
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE password
      .mockResolvedValueOnce({ rows: [{ id: 'team-x' }], rowCount: 1 }) // SELECT admin team → found
      .mockResolvedValue({ rows: [], rowCount: 1 })

    const mod = await import('../src/services/directory/adminProvisioning.js')
    await mod.provisionAdminDesktopWorkspace({
      controlAdminId: 'admin-1',
      email: 'old@example.com',
      displayName: 'Old',
      passwordHash: 'H',
      agentNames: [],
      contextIds: [],
      linkDesktopOperator: false,
    })

    expect(dbMocks.txQuery).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO users'),
      expect.anything()
    )
    expect(dbMocks.txQuery).toHaveBeenCalledWith(expect.stringContaining('UPDATE users'), [
      'user-9',
      'H',
    ])
  })

  it('seedPassword:false leaves an existing user password untouched', async () => {
    dbMocks.txQuery
      .mockResolvedValueOnce({ rows: [{ id: 'user-9' }], rowCount: 1 }) // SELECT users by email → found
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // INSERT profiles
      .mockResolvedValueOnce({ rows: [{ id: 'team-x' }], rowCount: 1 }) // SELECT admin team → found (no password UPDATE consumed)
      .mockResolvedValue({ rows: [], rowCount: 1 }) // grants

    const mod = await import('../src/services/directory/adminProvisioning.js')
    await mod.provisionAdminDesktopWorkspace({
      controlAdminId: 'admin-1',
      email: 'old@example.com',
      displayName: 'Old',
      passwordHash: 'H',
      agentNames: [],
      contextIds: [],
      linkDesktopOperator: false,
      seedPassword: false,
    })

    expect(dbMocks.txQuery).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE users'),
      expect.anything()
    )
  })

  it('seedPassword:false skips the password write but still provisions team + grants', async () => {
    dbMocks.txQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // SELECT users by email → none
      .mockResolvedValueOnce({ rows: [{ id: 'user-1' }], rowCount: 1 }) // INSERT users
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // INSERT profiles
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // SELECT admin team → none (no password UPDATE consumed)
      .mockResolvedValueOnce({ rows: [{ id: 'team-1' }], rowCount: 1 }) // INSERT teams
      .mockResolvedValue({ rows: [], rowCount: 1 }) // membership + grants

    const mod = await import('../src/services/directory/adminProvisioning.js')
    await mod.provisionAdminDesktopWorkspace({
      controlAdminId: 'admin-1',
      email: 'new@example.com',
      displayName: 'Ada',
      passwordHash: 'HASH',
      agentNames: ['chatllm'],
      contextIds: ['context1'],
      linkDesktopOperator: false,
      seedPassword: false,
    })

    expect(dbMocks.txQuery).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE users'),
      expect.anything()
    )
    expect(dbMocks.txQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO team_agents'),
      ['team-1', 'chatllm']
    )
  })

  it('creates the exact initial-setup operator link inside the Desktop provisioning transaction', async () => {
    dbMocks.txQuery
      .mockResolvedValueOnce({ rows: [{ id: 'user-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'team-1' }], rowCount: 1 })

    const mod = await import('../src/services/directory/adminProvisioning.js')
    const result = await mod.provisionAdminDesktopWorkspace({
      controlAdminId: 'admin-1',
      email: 'admin@example.com',
      displayName: 'Admin',
      passwordHash: 'HASH',
      agentNames: [],
      contextIds: [],
      linkDesktopOperator: true,
    })

    expect(result).toEqual({ userId: 'user-1' })
    expect(operatorLinkMocks.linkInTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ query: dbMocks.txQuery }),
      {
        desktopUserId: 'user-1',
        controlAdminId: 'admin-1',
        operatorSub: 'admin-1',
        source: 'initial_setup',
      }
    )
  })

  it('fails the Desktop provisioning transaction when initial link creation fails', async () => {
    dbMocks.txQuery
      .mockResolvedValueOnce({ rows: [{ id: 'user-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'team-1' }], rowCount: 1 })
    operatorLinkMocks.linkInTransaction.mockRejectedValueOnce(new Error('link conflict'))

    const mod = await import('../src/services/directory/adminProvisioning.js')
    await expect(
      mod.provisionAdminDesktopWorkspace({
        controlAdminId: 'admin-1',
        email: 'admin@example.com',
        displayName: 'Admin',
        passwordHash: 'HASH',
        agentNames: [],
        contextIds: [],
        linkDesktopOperator: true,
      })
    ).rejects.toThrow('link conflict')
  })
})

describe('provisionMemberFromAdmin', () => {
  beforeEach(() => {
    dbMocks.txQuery.mockReset()
    traceMocks.appendPermissionEvents.mockReset()
    traceMocks.appendPermissionEvents.mockResolvedValue(null)
  })

  it('creates a password-seeded member without creating a team when no teams are selected', async () => {
    dbMocks.txQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'admin-1',
            username: 'ada',
            email: 'ada@example.com',
            password_hash: 'HASH',
          },
        ],
        rowCount: 1,
      }) // SELECT control admin
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // SELECT member by email → none
      .mockResolvedValueOnce({
        rows: [{ id: 'user-1', email: 'ada@example.com', name: 'ada' }],
        rowCount: 1,
      }) // INSERT users
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // INSERT profiles
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE users password

    const mod = await import('../src/services/directory/adminProvisioning.js')
    const result = await mod.provisionMemberFromAdmin({
      adminId: 'admin-1',
      operatorSub: 'operator-admin-1',
      teamAssignments: [],
      seedPassword: true,
    })

    expect(result).toMatchObject({
      created: true,
      user: { id: 'user-1', email: 'ada@example.com', name: 'ada' },
    })
    expect(dbMocks.txQuery).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO teams'),
      expect.anything()
    )
    expect(dbMocks.txQuery).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO team_members'),
      expect.anything()
    )
    expect(traceMocks.appendPermissionEvents).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        operatorSub: 'operator-admin-1',
        operatorKind: 'control_admin',
        changes: [
          expect.objectContaining({
            action: 'grant',
            resourceClass: 'platform_user_access',
            subject: { kind: 'user', id: 'user-1' },
          }),
        ],
      })
    )
  })

  it('records the exact revoke and grant when an operator changes a member role', async () => {
    dbMocks.txQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'admin-1',
            username: 'ada',
            email: 'ada@example.com',
            password_hash: 'HASH',
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{ id: 'user-1', email: 'ada@example.com', name: 'ada' }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ team_id: 'team-1', role: 'member', status: 'active' }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })

    const mod = await import('../src/services/directory/adminProvisioning.js')
    await mod.provisionMemberFromAdmin({
      adminId: 'admin-1',
      operatorSub: 'operator-admin-1',
      teamAssignments: [{ teamId: 'team-1', role: 'admin' }],
      seedPassword: false,
    })

    expect(traceMocks.appendPermissionEvents).toHaveBeenCalledWith(expect.anything(), {
      operatorSub: 'operator-admin-1',
      operatorKind: 'control_admin',
      changes: [
        {
          action: 'revoke',
          resourceClass: 'team_membership',
          resourceRef: 'team_membership:team-1:role:member',
          subject: { kind: 'user', id: 'user-1' },
          teamId: 'team-1',
          status: 'role_replaced',
        },
        {
          action: 'grant',
          resourceClass: 'team_membership',
          resourceRef: 'team_membership:team-1:role:admin',
          subject: { kind: 'user', id: 'user-1' },
          teamId: 'team-1',
          status: 'role_assigned',
        },
      ],
    })
  })
})
