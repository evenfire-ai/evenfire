import { beforeEach, describe, expect, it, vi } from 'vitest'
import { googleLoginData } from '../src/services/directory/login.js'

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

// Password orchestration now runs against the real credential producer in
// bug192.passwordLogin.realPostgres.integration.test.ts. Google stays isolated here.
describe('directory Google login without team memberships', () => {
  beforeEach(() => {
    dbMocks.txQuery.mockReset()
    bcryptMock.compare.mockClear()
    bcryptMock.compare.mockResolvedValue(true)
  })

  it('returns a teamless member session instead of creating a default team for Google login', async () => {
    dbMocks.txQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'u1',
            email: 'a@b.com',
            name: 'Ada',
            picture: null,
            lifecycle_state: 'active',
            lifecycle_version: 1,
          },
        ],
        rowCount: 1,
      }) // SELECT user by email
      .mockResolvedValueOnce({
        rows: [{ id: 'u1', email: 'a@b.com', name: 'Ada', picture: null, lifecycle_version: 1 }],
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

  it('denies Google login for a retired user before profile healing or identity update', async () => {
    dbMocks.txQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'u-retired',
          email: 'retired@b.com',
          name: 'Retired',
          picture: null,
          lifecycle_state: 'retired',
          lifecycle_version: 2,
        },
      ],
      rowCount: 1,
    })

    await expect(googleLoginData({ email: 'retired@b.com', name: 'New name' })).resolves.toEqual({
      error: 'user_retired',
    })
    expect(dbMocks.txQuery).toHaveBeenCalledTimes(1)
  })
})
