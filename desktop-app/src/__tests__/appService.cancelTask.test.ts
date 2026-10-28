import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { establishAcceptedPasswordSession } from '../../testSupport/acceptedPasswordSession.js'
import { testSessionMe, testSessionTokenForIdentity } from '../../testSupport/authTestFixtures.js'
// ── import after mocks are set up ────────────────────────────────────────────

import { AppService } from '../appService.js'
import { TokenStore } from '../tokenStore.js'

const fixture = vi.hoisted(() => ({ directory: '' }))
const sessionMe = testSessionMe({ id: '1', teamId: 'team-1' })
const sessionToken = testSessionTokenForIdentity(sessionMe.id, sessionMe.teamId)

// ── mock dependencies before AppService is imported ──────────────────────────

vi.mock('../config.js', () => ({
  getActiveEnvKey: () => 'test_env-000000000000',
  getActiveRuntimeConfigOptionId: () => null,
  getActiveLegacyEnvKeys: () => [],
  getActiveLegacyEnvKeyInventory: () => ({ keys: [], complete: true }),
  hydrateDesktopRuntimeConfig: vi.fn(),
  isDesktopRuntimeConfigured: () => true,
  config: {
    rpcProxyBaseUrl: 'http://proxy',
    externalRestApiBaseUrl: 'http://rest',
    enableDevLoginUi: false,
    requestTimeoutMs: 60000,
    appName: 'test',
  },
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => fixture.directory,
    isPackaged: false,
    isReady: () => true,
  },
  safeStorage: { isEncryptionAvailable: () => false },
}))

const mockGetOrIssue = vi.fn()
const mockRpcTokenManagerClear = vi.fn()
const mockRpcTokenManagerGetMetadata = vi.fn().mockReturnValue({
  expiresAtMs: null,
  scopes: [],
  hostRefs: [],
})

vi.mock('../rpcTokenManager.js', () => ({
  RpcTokenManager: class {
    getOrIssue = mockGetOrIssue
    clear = mockRpcTokenManagerClear
    getMetadata = mockRpcTokenManagerGetMetadata
  },
}))

const mockCancelTask = vi.fn()
const mockHealth = vi.fn().mockResolvedValue({ status: 'ok' })

vi.mock('../rpcProxyClient.js', () => ({
  RpcProxyClient: class {
    health = mockHealth
    cancelTask = mockCancelTask
  },
}))

vi.mock('../authClient.js', () => ({
  AuthClient: class {
    health = vi.fn().mockResolvedValue({ status: 'ok' })
    getMe = vi.fn()
    passwordLogin = vi.fn()
  },
}))

// ── helpers ───────────────────────────────────────────────────────────────────

const tempDirectories: string[] = []

async function makeService(): Promise<AppService> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-cancel-task-'))
  tempDirectories.push(directory)
  fixture.directory = directory
  const svc = new AppService({
    tokenStore: new TokenStore({ isolatedUserDataPath: directory }),
    getUserDataDirectory: () => directory,
  })
  await establishAcceptedPasswordSession(svc, { token: sessionToken, me: sessionMe })
  mockRpcTokenManagerClear.mockClear()
  ;(svc as any).rpcTokenManager = {
    getOrIssue: mockGetOrIssue,
    clear: mockRpcTokenManagerClear,
    getMetadata: mockRpcTokenManagerGetMetadata,
  }
  return svc
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('AppService.cancelTask', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetOrIssue.mockResolvedValue({ token: 'fixture-rpc-token', expiresInSeconds: 300 })
    mockCancelTask.mockResolvedValue(undefined)
  })

  afterEach(async () => {
    await Promise.all(
      tempDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true }))
    )
  })

  it('issues a wake-capable RPC token then calls rpcClient.cancelTask', async () => {
    const svc = await makeService()

    await svc.cancelTask('myhost', 'abc')

    expect(mockGetOrIssue).toHaveBeenCalledWith(
      sessionToken,
      ['host:message:invoke', 'host:task:read', 'host:wake:write'],
      ['myhost'],
      expect.any(String)
    )
    expect(mockCancelTask).toHaveBeenCalledWith('fixture-rpc-token', 'myhost', 'abc')
  })

  it('throws if not authenticated', async () => {
    const svc = new AppService()
    await expect(svc.cancelTask('myhost', 'abc')).rejects.toThrow(
      'The credential is not owned by the current authenticated session'
    )
    expect(mockGetOrIssue).not.toHaveBeenCalled()
    expect(mockCancelTask).not.toHaveBeenCalled()
  })

  it('throws if hostRef is empty', async () => {
    const svc = await makeService()
    await expect(svc.cancelTask('', 'abc')).rejects.toThrow('hostRef')
  })

  it('throws if taskId is empty', async () => {
    const svc = await makeService()
    await expect(svc.cancelTask('myhost', '')).rejects.toThrow('taskId')
  })
})
