import { beforeEach, vi } from 'vitest'
import { describe, expect, it } from 'vitest'
import type { DbClient } from '../src/db.js'
import { ensureDefaultTeamAndGrants } from '../src/services/directory/adminProvisioning.js'

const dbMocks = vi.hoisted(() => ({ txQuery: vi.fn() }))
vi.mock('../src/db.js', () => ({
  pool: { query: vi.fn() },
  withTransaction: async (work: (db: { query: typeof dbMocks.txQuery }) => Promise<unknown>) =>
    work({ query: dbMocks.txQuery }),
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
  beforeEach(() => dbMocks.txQuery.mockReset())

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
      email: 'New@Example.com',
      displayName: 'Ada',
      passwordHash: 'HASH',
      agentNames: ['chatllm'],
      contextIds: ['context1'],
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
      email: 'old@example.com',
      displayName: 'Old',
      passwordHash: 'H',
      agentNames: [],
      contextIds: [],
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
      email: 'old@example.com',
      displayName: 'Old',
      passwordHash: 'H',
      agentNames: [],
      contextIds: [],
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
      email: 'new@example.com',
      displayName: 'Ada',
      passwordHash: 'HASH',
      agentNames: ['chatllm'],
      contextIds: ['context1'],
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
})

describe('provisionMemberFromAdmin', () => {
  beforeEach(() => dbMocks.txQuery.mockReset())

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
  })
})
