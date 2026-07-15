import { beforeEach, describe, expect, it, vi } from 'vitest'
// ── import after mocks are set up ────────────────────────────────────────────

import { AppService } from '../appService.js'

// ── mock dependencies before AppService is imported ──────────────────────────

vi.mock('../config.js', () => ({
  config: {
    rpcProxyBaseUrl: 'http://proxy',
    externalRestApiBaseUrl: 'http://rest',
    enableDevLoginUi: false,
    requestTimeoutMs: 60000,
    appName: 'test',
  },
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
  },
}))

vi.mock('../tokenStore.js', () => ({
  TokenStore: class {
    getSessionToken = vi.fn().mockResolvedValue(null)
    setSessionToken = vi.fn()
    clearSessionToken = vi.fn()
  },
}))

// ── helpers ───────────────────────────────────────────────────────────────────

function makeService(): AppService {
  const svc = new AppService()
  // Inject a session token directly via the private field.
  // We access it via a cast to bypass TypeScript visibility.
  ;(svc as unknown as { sessionToken: string }).sessionToken = 'session-token'
  // issueRpcTokenForHostRefs requires a resolvable current team; with me.teamId
  // set it short-circuits without hitting authClient or switching teams.
  ;(svc as unknown as { me: unknown }).me = { id: 1, teamId: 'team-1' }
  return svc
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('AppService.cancelTask', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetOrIssue.mockResolvedValue({ token: 'rpc-token' })
    mockCancelTask.mockResolvedValue(undefined)
  })

  it('issues a wake-capable RPC token then calls rpcClient.cancelTask', async () => {
    const svc = makeService()

    await svc.cancelTask('myhost', 'abc')

    expect(mockGetOrIssue).toHaveBeenCalledWith(
      'session-token',
      ['host:message:invoke', 'host:task:read', 'host:wake:write'],
      ['myhost']
    )
    expect(mockCancelTask).toHaveBeenCalledWith('rpc-token', 'myhost', 'abc')
  })

  it('throws if not authenticated', async () => {
    const svc = new AppService()
    // No session token set
    await expect(svc.cancelTask('myhost', 'abc')).rejects.toThrow('Not authenticated')
  })

  it('throws if hostRef is empty', async () => {
    const svc = makeService()
    await expect(svc.cancelTask('', 'abc')).rejects.toThrow('hostRef')
  })

  it('throws if taskId is empty', async () => {
    const svc = makeService()
    await expect(svc.cancelTask('myhost', '')).rejects.toThrow('taskId')
  })
})
