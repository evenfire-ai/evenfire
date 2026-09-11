import { beforeEach, describe, expect, it, vi } from 'vitest'

const dbMocks = vi.hoisted(() => ({
  withTransaction: vi.fn(),
  setupInitialAdminCredentials: vi.fn(),
  provisionAdminDesktopWorkspace: vi.fn(),
}))

vi.mock('../src/db.js', () => ({ withTransaction: dbMocks.withTransaction }))
vi.mock('../src/services/adminAuthService.js', () => ({
  setupInitialAdminCredentials: dbMocks.setupInitialAdminCredentials,
}))
vi.mock('../src/services/directory/adminProvisioning.js', () => ({
  provisionAdminDesktopWorkspace: dbMocks.provisionAdminDesktopWorkspace,
}))

describe('setupInitialAdminWithDesktopWorkspace', () => {
  beforeEach(() => {
    dbMocks.withTransaction.mockReset()
    dbMocks.setupInitialAdminCredentials.mockReset()
    dbMocks.provisionAdminDesktopWorkspace.mockReset()
  })

  it('commits the admin and Desktop workspace through the same transaction client', async () => {
    const transactionDb = { query: vi.fn() }
    dbMocks.withTransaction.mockImplementationOnce(
      async (work: (db: typeof transactionDb) => unknown) => work(transactionDb)
    )
    dbMocks.setupInitialAdminCredentials.mockResolvedValueOnce({
      id: 'admin-1',
      username: 'admin',
      email: 'admin@example.com',
      passwordHash: 'hash',
      sessionVersion: 0,
      role: 'admin',
      status: 'active',
      failedAttempts: 0,
      lockedUntil: null,
    })
    dbMocks.provisionAdminDesktopWorkspace.mockResolvedValueOnce({ userId: 'user-1' })

    const { setupInitialAdminWithDesktopWorkspace } =
      await import('../src/services/initialAdminSetupService.js')
    const result = await setupInitialAdminWithDesktopWorkspace({
      bootstrapUsername: 'bootstrap',
      email: 'admin@example.com',
      username: 'admin',
      passwordHash: 'hash',
      displayName: 'admin',
      agentNames: ['chatllm'],
      contextIds: ['ctx-1'],
      seedPassword: true,
      linkDesktopOperator: true,
      requestId: 'request-1',
    })

    expect(result?.id).toBe('admin-1')
    expect(dbMocks.setupInitialAdminCredentials).toHaveBeenCalledWith(
      'bootstrap',
      'admin@example.com',
      'admin',
      'hash',
      transactionDb
    )
    expect(dbMocks.provisionAdminDesktopWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ controlAdminId: 'admin-1', linkDesktopOperator: true }),
      transactionDb
    )
  })

  it('does not provision when the bootstrap admin is unavailable', async () => {
    const transactionDb = { query: vi.fn() }
    dbMocks.withTransaction.mockImplementationOnce(
      async (work: (db: typeof transactionDb) => unknown) => work(transactionDb)
    )
    dbMocks.setupInitialAdminCredentials.mockResolvedValueOnce(null)

    const { setupInitialAdminWithDesktopWorkspace } =
      await import('../src/services/initialAdminSetupService.js')
    const result = await setupInitialAdminWithDesktopWorkspace({
      bootstrapUsername: 'bootstrap',
      email: 'admin@example.com',
      username: 'admin',
      passwordHash: 'hash',
      displayName: 'admin',
      agentNames: [],
      contextIds: [],
      linkDesktopOperator: true,
    })

    expect(result).toBeNull()
    expect(dbMocks.provisionAdminDesktopWorkspace).not.toHaveBeenCalled()
  })

  it('propagates Desktop provisioning failures so the outer transaction rolls back', async () => {
    const transactionDb = { query: vi.fn() }
    dbMocks.withTransaction.mockImplementationOnce(
      async (work: (db: typeof transactionDb) => unknown) => work(transactionDb)
    )
    dbMocks.setupInitialAdminCredentials.mockResolvedValueOnce({
      id: 'admin-1',
      username: 'admin',
      email: 'admin@example.com',
      passwordHash: 'hash',
      sessionVersion: 0,
      role: 'admin',
      status: 'active',
      failedAttempts: 0,
      lockedUntil: null,
    })
    dbMocks.provisionAdminDesktopWorkspace.mockRejectedValueOnce(new Error('link conflict'))

    const { setupInitialAdminWithDesktopWorkspace } =
      await import('../src/services/initialAdminSetupService.js')
    await expect(
      setupInitialAdminWithDesktopWorkspace({
        bootstrapUsername: 'bootstrap',
        email: 'admin@example.com',
        username: 'admin',
        passwordHash: 'hash',
        displayName: 'admin',
        agentNames: [],
        contextIds: [],
        seedPassword: true,
        linkDesktopOperator: true,
        requestId: 'request-1',
      })
    ).rejects.toThrow('link conflict')
  })
})
