import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { establishAcceptedPasswordSession } from '../../testSupport/acceptedPasswordSession.js'
import { testSessionMe, testSessionTokenForIdentity } from '../../testSupport/authTestFixtures.js'
// ── import after mocks are set up ─────────────────────────────────────────────

import { AppService } from '../appService.js'
import { ApiError } from '../httpClient.js'
import { TokenStore } from '../tokenStore.js'

const fixture = vi.hoisted(() => ({ directory: '' }))
const sessionMe = testSessionMe({ id: '7', teamId: 'team-1' })
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

const mockInvokeHostMessage = vi.fn()
const mockHealth = vi.fn().mockResolvedValue({ status: 'ok' })

vi.mock('../rpcProxyClient.js', () => ({
  RpcProxyClient: class {
    health = mockHealth
    invokeHostMessage = mockInvokeHostMessage
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
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-host-waking-'))
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

function wakingApiError(): ApiError {
  return new ApiError(
    '503 Service Unavailable: Host is waking up',
    503,
    JSON.stringify({
      code: 'host_waking',
      hostRef: 'myhost',
      retryAfterMs: 2000,
      message: 'Host is waking up',
    })
  )
}

function drainingApiError(): ApiError {
  return new ApiError(
    '503 Service Unavailable: host draining',
    503,
    JSON.stringify({ code: 'host_draining' })
  )
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('AppService.invokeHostMessage host-availability plumbing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetOrIssue.mockResolvedValue({ token: 'fixture-rpc-token', expiresInSeconds: 300 })
  })

  afterEach(async () => {
    vi.useRealTimers()
    await Promise.all(
      tempDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true }))
    )
  })

  it('maps a structured host_waking 503 to a stable error carrying the code token', async () => {
    const svc = await makeService()
    mockInvokeHostMessage.mockRejectedValue(wakingApiError())

    await expect(svc.invokeHostMessage('myhost', { content: 'hi' })).rejects.toThrow(
      /^host_waking: agent host "myhost" is waking up/
    )
    // The waking retryable must never be treated as a token-refresh case.
    expect(mockRpcTokenManagerClear).not.toHaveBeenCalled()
    expect(mockInvokeHostMessage).toHaveBeenCalledTimes(1)
  })

  it('maps a structured host_draining 503 to a stable error carrying the code token', async () => {
    const svc = await makeService()
    mockInvokeHostMessage.mockRejectedValue(drainingApiError())

    await expect(svc.invokeHostMessage('myhost', { content: 'hi' })).rejects.toThrow(
      /^host_draining: agent host "myhost" is draining/
    )
  })

  it('maps host_waking thrown on the post-refresh retry as well', async () => {
    const svc = await makeService()
    mockInvokeHostMessage
      .mockRejectedValueOnce(new ApiError('401 Unauthorized: bad token', 401, ''))
      .mockRejectedValueOnce(wakingApiError())

    await expect(svc.invokeHostMessage('myhost', { content: 'hi' })).rejects.toThrow(
      /^host_waking:/
    )
    expect(mockRpcTokenManagerClear).toHaveBeenCalledTimes(1)
    expect(mockInvokeHostMessage).toHaveBeenCalledTimes(2)
    expect(mockGetOrIssue).toHaveBeenNthCalledWith(
      1,
      sessionToken,
      ['host:message:invoke', 'host:task:read', 'host:wake:write'],
      ['myhost'],
      expect.any(String)
    )
    expect(mockGetOrIssue).toHaveBeenNthCalledWith(
      2,
      sessionToken,
      ['host:message:invoke', 'host:task:read', 'host:wake:write'],
      ['myhost'],
      expect.any(String)
    )
  })

  it('leaves a plain 503 without an availability code untouched', async () => {
    const svc = await makeService()
    const plain = new ApiError('503 Service Unavailable: overloaded', 503, '{"error":"busy"}')
    mockInvokeHostMessage.mockRejectedValue(plain)

    await expect(svc.invokeHostMessage('myhost', { content: 'hi' })).rejects.toBe(plain)
  })

  it('forwards an optional piggybacked model through the field allow-list (R2 Option A)', async () => {
    const svc = await makeService()
    mockInvokeHostMessage.mockResolvedValue({ taskId: 't1', status: 'pending' })

    await svc.invokeHostMessage('myhost', { content: 'hi', model: 'claude-opus-4-8' })

    // The contextualRequest is a field allow-list; `model` must be threaded
    // through explicitly so the runtime can validate+persist the session model.
    expect(mockInvokeHostMessage).toHaveBeenCalledWith(
      'fixture-rpc-token',
      'myhost',
      expect.objectContaining({ content: 'hi', model: 'claude-opus-4-8' }),
      undefined
    )
  })

  it('omits model when no selection is piggybacked (additive/optional)', async () => {
    const svc = await makeService()
    mockInvokeHostMessage.mockResolvedValue({ taskId: 't2', status: 'pending' })

    await svc.invokeHostMessage('myhost', { content: 'hi' })

    const forwarded = mockInvokeHostMessage.mock.calls[0]?.[2] as Record<string, unknown>
    expect('model' in forwarded).toBe(false)
  })
})
