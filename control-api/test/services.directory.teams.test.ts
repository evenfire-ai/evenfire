import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addMemberToTeam,
  adminDeleteTeam,
  adminDeleteUser,
  createTeam,
  createTeamForUser,
  getTeamById,
  listAllTeams,
  listMembers,
  softDeleteMember,
  updateMemberRole,
} from '../src/services/directory/index.js'

const dbMocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  txQuery: vi.fn(),
  appendPermissionEvents: vi.fn(),
}))

vi.mock('../src/db.js', () => ({
  pool: {
    query: dbMocks.poolQuery,
  },
  withTransaction: async (work: (db: { query: typeof dbMocks.txQuery }) => Promise<unknown>) =>
    work({ query: dbMocks.txQuery }),
}))

vi.mock('../src/services/tracing/controlApiPermissionEvents.js', () => ({
  appendControlApiPermissionEventsInTransaction: dbMocks.appendPermissionEvents,
}))

describe('services/directory team management unit tests', () => {
  beforeEach(() => {
    dbMocks.poolQuery.mockReset()
    dbMocks.txQuery.mockReset()
    dbMocks.appendPermissionEvents.mockReset()
    dbMocks.appendPermissionEvents.mockResolvedValue('operation-1')
  })

  it('listAllTeams maps member counts to numbers', async () => {
    dbMocks.poolQuery.mockResolvedValue({
      rows: [
        { id: 'team-1', name: 'Core', member_count: '2' },
        { id: 'team-2', name: 'Ops', member_count: 0 },
      ],
      rowCount: 2,
    })

    const result = await listAllTeams()

    expect(result).toEqual([
      { id: 'team-1', name: 'Core', memberCount: 2 },
      { id: 'team-2', name: 'Ops', memberCount: 0 },
    ])
    expect(dbMocks.poolQuery).toHaveBeenCalledTimes(1)
  })

  it('getTeamById returns null when team is not found', async () => {
    dbMocks.poolQuery.mockResolvedValue({ rows: [], rowCount: 0 })

    const result = await getTeamById('team-missing')

    expect(result).toBeNull()
    expect(dbMocks.poolQuery).toHaveBeenCalledWith(expect.stringContaining('FROM teams'), [
      'team-missing',
    ])
  })

  it('getTeamById returns team when present', async () => {
    dbMocks.poolQuery.mockResolvedValue({
      rows: [{ id: 'team-1', name: 'Core Team' }],
      rowCount: 1,
    })

    const result = await getTeamById('team-1')
    expect(result).toEqual({ id: 'team-1', name: 'Core Team' })
  })

  it('createTeam creates only the team shell without member rows', async () => {
    dbMocks.poolQuery.mockResolvedValue({
      rows: [{ id: 'team-1', name: 'Core Team' }],
      rowCount: 1,
    })

    const result = await createTeam('Core Team')

    expect(result).toEqual({ id: 'team-1', name: 'Core Team' })
    expect(dbMocks.poolQuery).toHaveBeenCalledTimes(1)
    expect(dbMocks.poolQuery).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO teams'), [
      'Core Team',
    ])
  })

  it('createTeamForUser adds the creator as admin', async () => {
    dbMocks.poolQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'team-1', name: 'Core Team' }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })

    const result = await createTeamForUser('user-1', 'Core Team')

    expect(result).toEqual({ id: 'team-1', name: 'Core Team' })
    expect(dbMocks.poolQuery).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining(`VALUES($1, $2, 'admin', 'active')`),
      ['team-1', 'user-1']
    )
  })

  it('addMemberToTeam upserts and returns membership row', async () => {
    dbMocks.txQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }).mockResolvedValueOnce({
      rows: [{ team_id: 'team-1', user_id: 'user-1', role: 'member', status: 'active' }],
      rowCount: 1,
    })

    const result = await addMemberToTeam('team-1', 'user-1', 'admin-1', 'member')

    expect(result).toEqual({
      team_id: 'team-1',
      user_id: 'user-1',
      role: 'member',
      status: 'active',
    })
    expect(dbMocks.txQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO team_members'),
      ['team-1', 'user-1', 'member']
    )
    expect(dbMocks.appendPermissionEvents).toHaveBeenCalledWith(
      expect.objectContaining({ query: dbMocks.txQuery }),
      expect.objectContaining({
        operatorSub: 'admin-1',
        changes: [
          expect.objectContaining({
            action: 'grant',
            resourceClass: 'team_membership',
            subject: { kind: 'user', id: 'user-1' },
          }),
        ],
      })
    )
  })

  it('records role replacement as a revoke and grant for the same target user', async () => {
    dbMocks.txQuery
      .mockResolvedValueOnce({ rows: [{ role: 'member' }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ team_id: 'team-1', user_id: 'user-1', role: 'admin', status: 'active' }],
        rowCount: 1,
      })

    await updateMemberRole('team-1', 'user-1', 'admin', 'operator-1')

    expect(dbMocks.appendPermissionEvents).toHaveBeenCalledWith(
      expect.objectContaining({ query: dbMocks.txQuery }),
      expect.objectContaining({
        operatorSub: 'operator-1',
        changes: [
          expect.objectContaining({
            action: 'revoke',
            resourceRef: 'team_membership:team-1:role:member',
            subject: { kind: 'user', id: 'user-1' },
          }),
          expect.objectContaining({
            action: 'grant',
            resourceRef: 'team_membership:team-1:role:admin',
            subject: { kind: 'user', id: 'user-1' },
          }),
        ],
      })
    )
  })

  it('records membership removal only when an active membership was deleted', async () => {
    dbMocks.txQuery.mockResolvedValueOnce({
      rows: [{ team_id: 'team-1', user_id: 'user-1', role: 'member', status: 'deleted' }],
      rowCount: 1,
    })

    await expect(softDeleteMember('team-1', 'user-1', 'operator-1')).resolves.toEqual(
      expect.objectContaining({ status: 'deleted' })
    )
    expect(dbMocks.appendPermissionEvents).toHaveBeenCalledWith(
      expect.objectContaining({ query: dbMocks.txQuery }),
      expect.objectContaining({
        operatorSub: 'operator-1',
        changes: [
          expect.objectContaining({
            action: 'revoke',
            resourceClass: 'team_membership',
            subject: { kind: 'user', id: 'user-1' },
            status: 'membership_removed',
          }),
        ],
      })
    )
  })

  it('listMembers selects only public member fields', async () => {
    dbMocks.poolQuery.mockResolvedValue({
      rows: [{ id: 'u1', email: 'u@example.com', name: 'User', role: 'member', status: 'active' }],
      rowCount: 1,
    })

    const result = await listMembers('team-1')

    expect(result).toEqual([
      { id: 'u1', email: 'u@example.com', name: 'User', role: 'member', status: 'active' },
    ])
    const [sql, params] = dbMocks.poolQuery.mock.calls[0]
    expect(sql).not.toContain('display_name')
    expect(sql).not.toContain('channels')
    expect(params).toEqual(['team-1'])
  })

  it('adminDeleteTeam returns id when deleted', async () => {
    dbMocks.txQuery.mockResolvedValueOnce({ rows: [{ id: 't1' }], rowCount: 1 })
    dbMocks.txQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    dbMocks.txQuery.mockResolvedValueOnce({ rows: [{ id: 't1' }], rowCount: 1 })

    await expect(adminDeleteTeam('t1')).resolves.toEqual({ ok: true, id: 't1' })
    expect(dbMocks.txQuery).toHaveBeenNthCalledWith(1, expect.stringContaining('FOR UPDATE'), [
      't1',
    ])
    expect(dbMocks.txQuery).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('FROM team_members'),
      ['t1']
    )
    expect(dbMocks.txQuery).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('DELETE FROM teams'),
      ['t1']
    )
  })

  it('adminDeleteTeam returns not_found when team missing', async () => {
    dbMocks.txQuery.mockResolvedValue({ rows: [], rowCount: 0 })
    await expect(adminDeleteTeam('missing')).resolves.toEqual({ error: 'not_found' })
    expect(dbMocks.txQuery).toHaveBeenCalledTimes(1)
  })

  it('adminDeleteTeam refuses to delete teams with active members', async () => {
    dbMocks.txQuery.mockResolvedValueOnce({ rows: [{ id: 't1' }], rowCount: 1 })
    dbMocks.txQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 })

    await expect(adminDeleteTeam('t1')).resolves.toEqual({ error: 'team_not_empty' })
    expect(dbMocks.txQuery).toHaveBeenCalledTimes(2)
    expect(dbMocks.txQuery).not.toHaveBeenCalledWith(expect.stringContaining('DELETE FROM teams'), [
      't1',
    ])
  })

  it('adminDeleteUser returns not_found when user missing', async () => {
    dbMocks.txQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    await expect(adminDeleteUser('u1')).resolves.toEqual({ error: 'not_found' })
  })

  it('adminDeleteUser does not inspect team memberships before deleting the user row', async () => {
    dbMocks.txQuery.mockResolvedValueOnce({ rows: [{ x: 1 }], rowCount: 1 })
    dbMocks.txQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    dbMocks.txQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    dbMocks.txQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    dbMocks.txQuery.mockResolvedValueOnce({ rows: [{ id: 'u1' }], rowCount: 1 })
    await expect(adminDeleteUser('u1')).resolves.toEqual({ ok: true, id: 'u1' })

    const sqls = dbMocks.txQuery.mock.calls.map(([sql]) => String(sql))
    expect(sqls.some(sql => sql.includes('FROM team_members'))).toBe(false)
  })

  it('adminDeleteUser disables approval mediums before deleting the user row', async () => {
    dbMocks.txQuery.mockResolvedValueOnce({ rows: [{ x: 1 }], rowCount: 1 })
    dbMocks.txQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    dbMocks.txQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    dbMocks.txQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    dbMocks.txQuery.mockResolvedValueOnce({ rows: [{ id: 'u1' }], rowCount: 1 })
    await expect(adminDeleteUser('u1')).resolves.toEqual({ ok: true, id: 'u1' })
    expect(dbMocks.txQuery).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('FROM gfs_desktop_operator_links'),
      ['u1']
    )
    expect(dbMocks.txQuery).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('UPDATE workflow_approval_medium_accounts'),
      ['u1']
    )
    expect(dbMocks.txQuery).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining('UPDATE workflow_approval_medium_challenges'),
      ['u1']
    )
    expect(dbMocks.txQuery).toHaveBeenNthCalledWith(
      5,
      expect.stringContaining('DELETE FROM users'),
      ['u1']
    )
  })

  it('refuses the legacy hard-delete when operator-link history is retained', async () => {
    dbMocks.txQuery.mockResolvedValueOnce({ rows: [{ x: 1 }], rowCount: 1 })
    dbMocks.txQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 })

    await expect(adminDeleteUser('u1')).resolves.toEqual({
      error: 'gfs_operator_link_history_retained',
    })
    expect(dbMocks.txQuery).toHaveBeenCalledTimes(2)
    expect(dbMocks.txQuery).not.toHaveBeenCalledWith(expect.stringContaining('DELETE FROM users'), [
      'u1',
    ])
  })
})
