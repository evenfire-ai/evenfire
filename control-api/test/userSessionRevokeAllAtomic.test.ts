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
      .mockResolvedValueOnce({ rows: [{ id: 'user-1' }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ db_now: new Date('2026-08-27T00:00:01.000Z') }],
        rowCount: 1,
      })
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
    expect(mocks.query).toHaveBeenCalledTimes(4)
    expect(String(mocks.query.mock.calls[0]?.[0])).toContain('FOR UPDATE')
    expect(mocks.committedEpoch).toBe(false)
  })

  it('captures the revoke-all cutoff after acquiring the user lock', async () => {
    const cutoffs: Date[] = []
    const afterLock = new Date('2026-08-27T00:00:01.250Z')
    mocks.query.mockReset()
    mocks.query
      .mockResolvedValueOnce({ rows: [{ id: 'user-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ db_now: afterLock }], rowCount: 1 })
      .mockImplementationOnce(async (_sql, values) => {
        cutoffs.push(values[1] as Date)
        return { rows: [], rowCount: 1 }
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
    mocks.withTransaction.mockImplementationOnce(async work => work({ query: mocks.query }))

    const { revokeAllUserSessions } = await import('../src/services/auth/userSessionService.js')
    await expect(revokeAllUserSessions('user-1', 'security_event')).resolves.toBe(0)

    expect(String(mocks.query.mock.calls[0]?.[0])).toContain('FOR UPDATE')
    expect(String(mocks.query.mock.calls[1]?.[0])).toContain('clock_timestamp()')
    expect(cutoffs).toEqual([afterLock])
  })
})
