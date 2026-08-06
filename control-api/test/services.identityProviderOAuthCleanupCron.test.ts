import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/db.js', () => ({
  pool: { query: vi.fn() },
}))

const { pool } = await import('../src/db.js')
const { cleanupIdentityProviderOAuthArtifacts } =
  await import('../src/services/identityProviderOAuthCleanupCron.js')

describe('identity provider OAuth cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('removes expired and old consumed states and login codes in bounded batches', async () => {
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rowCount: 3, rows: [] } as never)
      .mockResolvedValueOnce({ rowCount: 5, rows: [] } as never)

    await expect(cleanupIdentityProviderOAuthArtifacts(250)).resolves.toEqual({
      states: 3,
      loginCodes: 5,
    })
    expect(pool.query).toHaveBeenCalledTimes(2)
    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("consumed_at < NOW() - INTERVAL '15 minutes'"),
      [250]
    )
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("consumed_at < NOW() - INTERVAL '15 minutes'"),
      [250]
    )
  })
})
