import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  withTransaction: vi.fn(),
  query: vi.fn(),
  committedEpoch: false,
}))

vi.mock('../src/db.js', () => ({
  pool: { query: vi.fn() },
  withTransaction: mocks.withTransaction,
}))

describe('revoke-all transaction boundary', () => {
  it('rolls back the security epoch when v2 session revocation fails', async () => {
    mocks.committedEpoch = false
    mocks.query.mockReset()
    mocks.query
      .mockImplementationOnce(async () => {
        mocks.committedEpoch = true
        return { rows: [], rowCount: 1 }
      })
      .mockRejectedValueOnce(new Error('session update failed'))
    mocks.withTransaction.mockImplementationOnce(async work => {
      const previousEpoch = mocks.committedEpoch
      try {
        return await work({ query: mocks.query })
      } catch (error) {
        mocks.committedEpoch = previousEpoch
        throw error
      }
    })

    const { revokeAllUserSessions } = await import('../src/services/auth/userSessionService.js')
    await expect(revokeAllUserSessions('user-1', 'security_event')).rejects.toThrow(
      'session update failed'
    )

    expect(mocks.withTransaction).toHaveBeenCalledTimes(1)
    expect(mocks.query).toHaveBeenCalledTimes(2)
    expect(mocks.committedEpoch).toBe(false)
  })
})
