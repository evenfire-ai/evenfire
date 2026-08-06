import { beforeEach, describe, expect, it, vi } from 'vitest'

const dbMocks = vi.hoisted(() => ({
  txQuery: vi.fn(),
}))

vi.mock('../src/config.js', () => ({
  config: { oauthEncryptionKey: '00'.repeat(32) },
}))

vi.mock('../src/db.js', () => ({
  pool: { query: vi.fn() },
  withTransaction: async (work: (db: { query: typeof dbMocks.txQuery }) => Promise<unknown>) =>
    work({ query: dbMocks.txQuery }),
}))

const { createIdentityProviderSetup } = await import('../src/services/identityProviders/setup.js')

describe('identity provider setup replacement', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('cancels an abandoned active setup before creating a fresh one', async () => {
    const row = {
      id: 'setup-2',
      provider: 'microsoft',
      status: 'draft',
      current_step: 1,
      draft: {},
      client_secret_encrypted: null,
      connection_id: null,
      execution: {},
      created_at: new Date('2026-08-06T00:00:00.000Z'),
      updated_at: new Date('2026-08-06T00:00:00.000Z'),
    }
    dbMocks.txQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [row], rowCount: 1 })

    await expect(
      createIdentityProviderSetup({
        provider: 'microsoft',
        adminUserId: 'admin-1',
        initialDraft: {},
        replaceActive: true,
      })
    ).resolves.toMatchObject({ id: 'setup-2', status: 'draft' })

    expect(dbMocks.txQuery).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("SET status = 'cancelled'"),
      ['microsoft']
    )
    expect(dbMocks.txQuery).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining('INSERT INTO identity_provider_setup_sessions'),
      expect.any(Array)
    )
  })

  it('refuses to replace a setup while its import lease is active', async () => {
    dbMocks.txQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: 'setup-running' }], rowCount: 1 })

    await expect(
      createIdentityProviderSetup({
        provider: 'microsoft',
        adminUserId: 'admin-1',
        initialDraft: {},
        replaceActive: true,
      })
    ).rejects.toMatchObject({ status: 409, message: 'Microsoft import is currently running' })

    expect(
      dbMocks.txQuery.mock.calls.some(([sql]) =>
        String(sql).includes('INSERT INTO identity_provider_setup_sessions')
      )
    ).toBe(false)
  })
})
