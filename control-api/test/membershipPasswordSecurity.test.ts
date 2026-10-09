import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  transactionQuery: vi.fn(),
  compare: vi.fn(),
  hash: vi.fn(),
  revokeAll: vi.fn(),
}))

vi.mock('../src/db.js', () => ({
  pool: { query: mocks.poolQuery },
  withTransaction: async (work: (db: { query: typeof mocks.transactionQuery }) => unknown) =>
    work({ query: mocks.transactionQuery }),
}))
vi.mock('bcryptjs', () => ({
  default: { compare: mocks.compare, hash: mocks.hash },
}))
vi.mock('../src/services/auth/userSessionService.js', () => ({
  revokeAllUserSessions: mocks.revokeAll,
}))

describe('member password security events', () => {
  beforeEach(() => {
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.poolQuery.mockResolvedValue({ rows: [{ password_hash: 'old-hash' }], rowCount: 1 })
    mocks.compare.mockResolvedValue(true)
    mocks.hash.mockResolvedValue('next-hash')
    mocks.revokeAll.mockResolvedValue(2)
  })

  it('conditionally changes the credential and revokes sessions in the same transaction', async () => {
    mocks.transactionQuery.mockResolvedValueOnce({ rows: [{ id: 'user-1' }], rowCount: 1 })
    const { updateUserPassword } = await import('../src/services/directory/membership.js')

    await expect(
      updateUserPassword('user-1', 'user@example.com', 'old-password', 'next-password')
    ).resolves.toEqual({ updated: true })

    expect(mocks.transactionQuery).toHaveBeenCalledWith(
      expect.stringContaining('AND password_hash = $4'),
      ['user-1', 'user@example.com', 'next-hash', 'old-hash']
    )
    expect(mocks.revokeAll).toHaveBeenCalledWith(
      'user-1',
      'password_changed',
      expect.objectContaining({ query: mocks.transactionQuery })
    )
  })

  it('does not revoke when a concurrent credential change wins first', async () => {
    mocks.transactionQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    const { updateUserPassword } = await import('../src/services/directory/membership.js')

    await expect(
      updateUserPassword('user-1', 'user@example.com', 'old-password', 'next-password')
    ).resolves.toEqual({ error: 'invalid_current_password' })
    expect(mocks.revokeAll).not.toHaveBeenCalled()
  })
})
