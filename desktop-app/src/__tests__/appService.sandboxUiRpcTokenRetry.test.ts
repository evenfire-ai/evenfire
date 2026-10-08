import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppService } from '../appService.js'

// The RPC-token retry around the sandbox-ui calls is exercised through the REAL
// AppService and the REAL RpcProxyClient: the errors the retry inspects are the
// ones the client actually throws for rpc-proxy's HTTP answers, fed through
// `fetch`. Only the RPC-token issuer (control-api via external-rest-api) and
// the Electron runtime are faked.

const mocks = vi.hoisted(() => ({
  getOrIssue: vi.fn(),
  clear: vi.fn(),
  openExternal: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/clerum-desktop-test') },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
  shell: { openExternal: mocks.openExternal },
}))

vi.mock('../config.js', () => ({
  getActiveEnvKey: () => 'test-env',
  config: {
    rpcProxyBaseUrl: 'https://rpc.example',
    externalRestApiBaseUrl: 'http://rest',
    desktopProfileUiBaseUrl: 'https://profile.example.com',
    desktopProfileUiBaseUrlExplicit: false,
    enableDevLoginUi: false,
    requestTimeoutMs: 60000,
    appName: 'test',
  },
}))

vi.mock('../rpcTokenManager.js', () => ({
  RpcTokenManager: class {
    getOrIssue = mocks.getOrIssue
    clear = mocks.clear
    getMetadata = vi.fn(() => ({ expiresAtMs: null, scopes: [], hostRefs: [] }))
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

// rpc-proxy answers with Express `res.status(n).json(body)`. The bodies are the
// ones its auth middleware (`requireScope`) and sandbox-ui routes emit.
function rpcProxyJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}
const UNAUTHORIZED = () => rpcProxyJson(401, { error: 'Unauthorized' })
const MISSING_SCOPE = () => rpcProxyJson(403, { error: 'Forbidden: missing scope' })
const ACL_DENIED = () => rpcProxyJson(403, { error: 'recipe_acl_denied' })

const SESSION_COOKIE =
  'clerum_sandbox_ui_session=tok; Path=/api/v1/sandbox-ui/sandbox-recipes/crm/; HttpOnly'
const mintOk = () => new Response(null, { status: 204, headers: { 'set-cookie': SESSION_COOKIE } })

const fetchMock = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()

function bearersSent(): string[] {
  return fetchMock.mock.calls.map(([, init]) =>
    String((init?.headers as Record<string, string> | undefined)?.authorization)
  )
}

function makeService(): AppService {
  const svc = new AppService()
  ;(svc as unknown as { sessionToken: string }).sessionToken = 'session-token'
  return svc
}

beforeEach(() => {
  vi.clearAllMocks()
  fetchMock.mockReset()
  mocks.getOrIssue.mockReset()
  mocks.getOrIssue
    .mockResolvedValueOnce({ token: 'stale' })
    .mockResolvedValueOnce({ token: 'fresh' })
    .mockResolvedValue({ token: 'unexpected-third' })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AppService.mintSandboxUiSession retries once with a fresh RPC token', () => {
  it('re-mints after a 401 and returns the session cookie', async () => {
    fetchMock.mockResolvedValueOnce(UNAUTHORIZED()).mockResolvedValueOnce(mintOk())

    await expect(makeService().mintSandboxUiSession('sandbox-recipes', 'crm')).resolves.toEqual({
      setCookie: SESSION_COOKIE,
    })

    expect(bearersSent()).toEqual(['Bearer stale', 'Bearer fresh'])
    expect(mocks.clear).toHaveBeenCalledOnce()
  })

  it('re-mints after a 403 for a missing scope', async () => {
    fetchMock.mockResolvedValueOnce(MISSING_SCOPE()).mockResolvedValueOnce(mintOk())

    await expect(makeService().mintSandboxUiSession('sandbox-recipes', 'crm')).resolves.toEqual({
      setCookie: SESSION_COOKIE,
    })

    expect(bearersSent()).toEqual(['Bearer stale', 'Bearer fresh'])
    expect(mocks.clear).toHaveBeenCalledOnce()
  })

  it('does not retry a recipe ACL denial', async () => {
    fetchMock.mockResolvedValueOnce(ACL_DENIED())

    await expect(makeService().mintSandboxUiSession('sandbox-recipes', 'crm')).rejects.toThrow(
      /\(403\)/
    )

    expect(bearersSent()).toEqual(['Bearer stale'])
    expect(mocks.clear).not.toHaveBeenCalled()
  })

  it('retries only once when the fresh token is rejected too', async () => {
    fetchMock.mockResolvedValueOnce(UNAUTHORIZED()).mockResolvedValueOnce(UNAUTHORIZED())

    await expect(makeService().mintSandboxUiSession('sandbox-recipes', 'crm')).rejects.toThrow(
      /\(401\)/
    )

    expect(bearersSent()).toEqual(['Bearer stale', 'Bearer fresh'])
    expect(mocks.clear).toHaveBeenCalledOnce()
  })
})

const AUTHORIZE_URL = 'https://accounts.example.com/o/oauth2/auth?client_id=x'
const authorizeOk = () => rpcProxyJson(200, { authorizeUrl: AUTHORIZE_URL })

describe('AppService.requestSandboxUiOauthAuthorize retries once with a fresh RPC token', () => {
  it('re-requests after a 401 and opens the returned authorize URL', async () => {
    fetchMock.mockResolvedValueOnce(UNAUTHORIZED()).mockResolvedValueOnce(authorizeOk())

    await expect(
      makeService().requestSandboxUiOauthAuthorize('sandbox-recipes', 'crm', 'salesforce')
    ).resolves.toBeUndefined()

    expect(mocks.openExternal).toHaveBeenCalledWith(AUTHORIZE_URL)
    expect(bearersSent()).toEqual(['Bearer stale', 'Bearer fresh'])
    expect(mocks.clear).toHaveBeenCalledOnce()
  })

  it('re-requests after a 403 for a missing scope', async () => {
    fetchMock.mockResolvedValueOnce(MISSING_SCOPE()).mockResolvedValueOnce(authorizeOk())

    await expect(
      makeService().requestSandboxUiOauthAuthorize('sandbox-recipes', 'crm', 'salesforce')
    ).resolves.toBeUndefined()

    expect(mocks.openExternal).toHaveBeenCalledWith(AUTHORIZE_URL)
    expect(bearersSent()).toEqual(['Bearer stale', 'Bearer fresh'])
  })

  it('does not retry a recipe ACL denial', async () => {
    fetchMock.mockResolvedValueOnce(ACL_DENIED())

    await expect(
      makeService().requestSandboxUiOauthAuthorize('sandbox-recipes', 'crm', 'salesforce')
    ).rejects.toThrow(/\(403\)/)

    expect(bearersSent()).toEqual(['Bearer stale'])
    expect(mocks.clear).not.toHaveBeenCalled()
    expect(mocks.openExternal).not.toHaveBeenCalled()
  })

  it('retries only once when the fresh token is rejected too', async () => {
    fetchMock.mockResolvedValueOnce(UNAUTHORIZED()).mockResolvedValueOnce(UNAUTHORIZED())

    await expect(
      makeService().requestSandboxUiOauthAuthorize('sandbox-recipes', 'crm', 'salesforce')
    ).rejects.toThrow(/\(401\)/)

    expect(bearersSent()).toEqual(['Bearer stale', 'Bearer fresh'])
    expect(mocks.clear).toHaveBeenCalledOnce()
    expect(mocks.openExternal).not.toHaveBeenCalled()
  })
})
