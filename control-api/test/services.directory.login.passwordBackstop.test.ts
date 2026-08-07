import { beforeEach, describe, expect, it, vi } from 'vitest'
import { googleLoginData, passwordLoginData } from '../src/services/directory/login.js'

const bcryptMock = vi.hoisted(() => ({ compare: vi.fn(), hash: vi.fn(async () => 'h') }))
vi.mock('bcryptjs', () => ({ default: bcryptMock }))

const dbMocks = vi.hoisted(() => ({ txQuery: vi.fn() }))
vi.mock('../src/db.js', () => ({
  pool: { query: vi.fn() },
  withTransaction: async (work: (db: { query: typeof dbMocks.txQuery }) => Promise<unknown>) =>
    work({ query: dbMocks.txQuery }),
}))
vi.mock('../src/config.js', () => ({
  config: { adminDefaultAgentNames: ['chatllm'], adminDefaultContextIds: ['context1'] },
}))

describe('directory login without team memberships', () => {
  beforeEach(() => {
    dbMocks.txQuery.mockReset()
    bcryptMock.compare.mockResolvedValue(true)
  })

  it('returns a teamless member session instead of creating a default team for password login', async () => {
    dbMocks.txQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'u1', email: 'a@b.com', name: 'Ada', picture: null, password_hash: 'hash' }],
        rowCount: 1,
      }) // SELECT user by email
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // findFirstActiveMembership → none
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // accepted invitation memberships
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // UPDATE accepted invitations
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // findFirstActiveMembership after heal → none

    const result = await passwordLoginData({ email: 'a@b.com', password: 'x' })

    expect(result).toMatchObject({
      membership: { team_id: null, role: 'member', team_name: null },
    })
    expect(dbMocks.txQuery).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO teams'),
      expect.anything()
    )
    expect(dbMocks.txQuery).toHaveBeenCalledWith(
      expect.stringContaining("WHERE team_members.status <> 'deleted'"),
      ['u1', 'a@b.com']
    )
  })

  it('skips accepted invitation healing when password login already has a membership', async () => {
    dbMocks.txQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'u1', email: 'a@b.com', name: 'Ada', picture: null, password_hash: 'hash' }],
        rowCount: 1,
      }) // SELECT user by email
      .mockResolvedValueOnce({
        rows: [{ team_id: 't1', role: 'member', team_name: 'Team 1' }],
        rowCount: 1,
      }) // findFirstActiveMembership

    const result = await passwordLoginData({ email: 'a@b.com', password: 'x' })

    expect(result).toMatchObject({
      membership: { team_id: 't1', role: 'member', team_name: 'Team 1' },
    })
    expect(dbMocks.txQuery).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO team_members'),
      expect.anything()
    )
    expect(dbMocks.txQuery).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE invitations'),
      expect.anything()
    )
  })

  it('heals accepted invitations when password login has no active membership', async () => {
    dbMocks.txQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'u1', email: 'a@b.com', name: 'Ada', picture: null, password_hash: 'hash' }],
        rowCount: 1,
      }) // SELECT user by email
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // findFirstActiveMembership → none
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // accepted invitation memberships
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE accepted invitations
      .mockResolvedValueOnce({
        rows: [{ team_id: 't1', role: 'member', team_name: 'Team 1' }],
        rowCount: 1,
      }) // findFirstActiveMembership

    const result = await passwordLoginData({ email: 'a@b.com', password: 'x' })

    expect(result).toMatchObject({
      membership: { team_id: 't1', role: 'member', team_name: 'Team 1' },
    })
    expect(dbMocks.txQuery.mock.calls[1][0]).toContain('WHERE tm.user_id = $1')
    expect(dbMocks.txQuery.mock.calls[2][0]).toContain('INSERT INTO team_members')
    expect(dbMocks.txQuery.mock.calls[2][0]).toContain("WHERE team_members.status <> 'deleted'")
    expect(dbMocks.txQuery.mock.calls[3][0]).toContain('UPDATE invitations')
    expect(dbMocks.txQuery.mock.calls[4][0]).toContain('WHERE tm.user_id = $1')
  })

  it('returns a teamless member session instead of creating a default team for Google login', async () => {
    dbMocks.txQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'u1', email: 'a@b.com', name: 'Ada', picture: null }],
        rowCount: 1,
      }) // SELECT user by email
      .mockResolvedValueOnce({
        rows: [{ id: 'u1', email: 'a@b.com', name: 'Ada', picture: null }],
        rowCount: 1,
      }) // UPDATE user
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // INSERT profiles
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // accepted invitation memberships
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // UPDATE accepted invitations
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // findFirstActiveMembership → none
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // findPendingInvitationMembership → none

    const result = await googleLoginData({ email: 'a@b.com', name: 'Ada' })

    expect(result).toMatchObject({
      membership: { team_id: null, role: 'member', team_name: null },
    })
    expect(dbMocks.txQuery).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO teams'),
      expect.anything()
    )
    expect(dbMocks.txQuery).toHaveBeenCalledWith(
      expect.stringContaining("WHERE team_members.status <> 'deleted'"),
      ['u1', 'a@b.com']
    )
  })

  it('does not select a pending invitation as the Google session team', async () => {
    dbMocks.txQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'u1', email: 'a@b.com', name: 'Ada', picture: null }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{ id: 'u1', email: 'a@b.com', name: 'Ada', picture: null }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [{ team_id: 'pending-team', role: 'admin', team_name: 'Pending Team' }],
        rowCount: 1,
      })

    const result = await googleLoginData({ email: 'a@b.com', name: 'Ada' })

    expect(result).toMatchObject({
      membership: { team_id: null, role: 'member', team_name: null },
    })
  })

  it('does NOT self-heal (no team created) when the password is wrong', async () => {
    bcryptMock.compare.mockResolvedValue(false)
    dbMocks.txQuery.mockResolvedValueOnce({
      rows: [{ id: 'u1', email: 'a@b.com', name: 'Ada', picture: null, password_hash: 'hash' }],
      rowCount: 1,
    }) // SELECT user

    const result = await passwordLoginData({ email: 'a@b.com', password: 'wrong' })

    expect(result).toBeNull()
    expect(dbMocks.txQuery).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO teams'),
      expect.anything()
    )
  })

  it('does NOT self-heal when the email is unknown', async () => {
    dbMocks.txQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }) // SELECT user → none

    const result = await passwordLoginData({ email: 'nobody@b.com', password: 'x' })

    expect(result).toBeNull()
    expect(dbMocks.txQuery).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO teams'),
      expect.anything()
    )
  })
})
