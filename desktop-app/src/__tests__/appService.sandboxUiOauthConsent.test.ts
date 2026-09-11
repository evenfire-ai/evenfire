/**
 * Tests for AppService.requestSandboxUiOauthAuthorize
 *
 * Covers:
 *   - background=true + dialog response=0 (Cancel)  → shell.openExternal NOT called, rpc NOT made
 *   - background=true + dialog response=1 (Allow)   → authorize URL fetched + shell.openExternal called
 *   - background=true + focused BrowserWindow       → showMessageBox called with win argument
 *   - background=false                              → no dialog shown, openExternal called directly
 *   - token refresh on 401                          → rpcTokenManager.clear + retry
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppService } from '../appService.js'
import { ApiError } from '../httpClient.js'

// ── Hoisted mock refs (must be created before vi.mock factories hoist) ────────
const mocks = vi.hoisted(() => ({
  showMessageBox: vi.fn(),
  getFocusedWindow: vi.fn<() => null | { id: number }>(),
  openExternal: vi.fn(),
  requestSandboxUiOauthAuthorizeUrl: vi.fn(),
  getOrIssue: vi.fn(),
  rpcTokenManagerClear: vi.fn(),
  rpcTokenManagerGetMetadata: vi
    .fn()
    .mockReturnValue({ expiresAtMs: null, scopes: [], hostRefs: [] }),
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/clerum-desktop-test') },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
  dialog: { showMessageBox: mocks.showMessageBox },
  BrowserWindow: { getFocusedWindow: mocks.getFocusedWindow },
  shell: { openExternal: mocks.openExternal },
}))

vi.mock('../config.js', () => ({
  config: {
    rpcProxyBaseUrl: 'http://proxy',
    externalRestApiBaseUrl: 'http://rest',
    desktopProfileUiBaseUrl: 'https://profile.example.com',
    enableDevLoginUi: false,
    requestTimeoutMs: 60000,
    appName: 'test',
  },
}))

vi.mock('../rpcTokenManager.js', () => ({
  RpcTokenManager: class {
    getOrIssue = mocks.getOrIssue
    clear = mocks.rpcTokenManagerClear
    getMetadata = mocks.rpcTokenManagerGetMetadata
  },
}))

vi.mock('../rpcProxyClient.js', () => ({
  RpcProxyClient: class {
    health = vi.fn().mockResolvedValue({ status: 'ok' })
    requestSandboxUiOauthAuthorizeUrl = mocks.requestSandboxUiOauthAuthorizeUrl
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeService(): AppService {
  const svc = new AppService()
  ;(svc as unknown as { sessionToken: string }).sessionToken = 'session-token'
  return svc
}

const RECIPE_NS = 'sandbox-recipes'
const RECIPE_NAME = 'crm-recipe'
const CLIENT_ID = 'salesforce'
const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth?...'

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AppService.requestSandboxUiOauthAuthorize', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getOrIssue.mockResolvedValue({ token: 'rpc-token' })
    mocks.requestSandboxUiOauthAuthorizeUrl.mockResolvedValue({ authorizeUrl: AUTHORIZE_URL })
    mocks.getFocusedWindow.mockReturnValue(null)
    // Default: user clicks Allow (response=1)
    mocks.showMessageBox.mockResolvedValue({ response: 1 })
    mocks.openExternal.mockResolvedValue(undefined)
  })

  it('background=true + dialog Cancel (response=0) → does NOT call shell.openExternal', async () => {
    mocks.showMessageBox.mockResolvedValue({ response: 0 })

    const svc = makeService()
    await svc.requestSandboxUiOauthAuthorize(RECIPE_NS, RECIPE_NAME, CLIENT_ID, true)

    expect(mocks.showMessageBox).toHaveBeenCalledOnce()
    expect(mocks.openExternal).not.toHaveBeenCalled()
  })

  it('background=true + dialog Allow (response=1) → fetches URL and calls shell.openExternal', async () => {
    mocks.showMessageBox.mockResolvedValue({ response: 1 })

    const svc = makeService()
    await svc.requestSandboxUiOauthAuthorize(RECIPE_NS, RECIPE_NAME, CLIENT_ID, true)

    expect(mocks.requestSandboxUiOauthAuthorizeUrl).toHaveBeenCalledWith(
      'rpc-token',
      RECIPE_NS,
      RECIPE_NAME,
      CLIENT_ID,
      true
    )
    expect(mocks.showMessageBox).toHaveBeenCalledOnce()
    expect(mocks.openExternal).toHaveBeenCalledWith(AUTHORIZE_URL)
  })

  it('background=true with a focused BrowserWindow → showMessageBox called with win argument', async () => {
    const fakeWin = { id: 42 }
    mocks.getFocusedWindow.mockReturnValue(fakeWin)
    mocks.showMessageBox.mockResolvedValue({ response: 1 })

    const svc = makeService()
    await svc.requestSandboxUiOauthAuthorize(RECIPE_NS, RECIPE_NAME, CLIENT_ID, true)

    // First arg is the BrowserWindow, second is the options object
    expect(mocks.showMessageBox).toHaveBeenCalledWith(
      fakeWin,
      expect.objectContaining({ buttons: ['Cancel', 'Allow background access'] })
    )
  })

  it('background=false → no dialog shown; shell.openExternal called directly', async () => {
    const svc = makeService()
    await svc.requestSandboxUiOauthAuthorize(RECIPE_NS, RECIPE_NAME, CLIENT_ID, false)

    expect(mocks.showMessageBox).not.toHaveBeenCalled()
    expect(mocks.requestSandboxUiOauthAuthorizeUrl).toHaveBeenCalledWith(
      'rpc-token',
      RECIPE_NS,
      RECIPE_NAME,
      CLIENT_ID,
      false
    )
    expect(mocks.openExternal).toHaveBeenCalledWith(AUTHORIZE_URL)
  })

  // R4-L8a — the authorize URL comes from rpc-proxy; a compromised or
  // misconfigured upstream returning a non-`https:` scheme must never reach
  // `shell.openExternal`, which would hand `file:`/`javascript:`/`http:` to the
  // OS protocol handler. Same boundary the tests above mock (the rpc client's
  // returned `authorizeUrl` string).
  it.each([
    ['http:', 'http://accounts.google.com/o/oauth2/v2/auth'],
    ['javascript:', 'javascript:alert(document.cookie)'],
    ['file:', 'file:///etc/passwd'],
    ['data:', 'data:text/html,<script>alert(1)</script>'],
    ['clerum:', 'clerum://oauth?clientId=evil'],
  ])(
    'rejects a non-https authorize URL (%s) and does NOT call shell.openExternal',
    async (_label, maliciousUrl) => {
      mocks.requestSandboxUiOauthAuthorizeUrl.mockResolvedValue({ authorizeUrl: maliciousUrl })

      const svc = makeService()
      await expect(
        svc.requestSandboxUiOauthAuthorize(RECIPE_NS, RECIPE_NAME, CLIENT_ID, false)
      ).rejects.toThrow(/unsupported scheme|malformed/)

      expect(mocks.openExternal).not.toHaveBeenCalled()
    }
  )

  // Exercises the `malformed` branch of the guard: `new URL()` throws, the
  // helper catches and rethrows without ever reaching `shell.openExternal`.
  it.each([
    ['unparseable', 'not-a-url'],
    ['empty', ''],
  ])(
    'rejects a malformed authorize URL (%s) and does NOT call shell.openExternal',
    async (_label, malformedUrl) => {
      mocks.requestSandboxUiOauthAuthorizeUrl.mockResolvedValue({ authorizeUrl: malformedUrl })

      const svc = makeService()
      await expect(
        svc.requestSandboxUiOauthAuthorize(RECIPE_NS, RECIPE_NAME, CLIENT_ID, false)
      ).rejects.toThrow(/^Refusing to open a malformed external URL$/)

      expect(mocks.openExternal).not.toHaveBeenCalled()
    }
  )

  it('does not leak the malformed input in the rejection message', async () => {
    // `ht!tp://…` has an invalid scheme char → `new URL()` throws → malformed branch.
    mocks.requestSandboxUiOauthAuthorizeUrl.mockResolvedValue({
      authorizeUrl: 'ht!tp://SUPER_SECRET_ONLY_IN_MALFORMED',
    })

    const svc = makeService()
    let caught: Error | undefined
    try {
      await svc.requestSandboxUiOauthAuthorize(RECIPE_NS, RECIPE_NAME, CLIENT_ID, false)
    } catch (e) {
      caught = e as Error
    }
    expect(caught?.message).toBe('Refusing to open a malformed external URL')
    expect(caught?.message).not.toContain('SUPER_SECRET_ONLY_IN_MALFORMED')
    expect(mocks.openExternal).not.toHaveBeenCalled()
  })

  it('does not leak the authorize URL (query/secrets) in the rejection message', async () => {
    mocks.requestSandboxUiOauthAuthorizeUrl.mockResolvedValue({
      authorizeUrl: 'http://evil.example/authorize?token=SUPER_SECRET',
    })

    const svc = makeService()
    await expect(
      svc.requestSandboxUiOauthAuthorize(RECIPE_NS, RECIPE_NAME, CLIENT_ID, false)
    ).rejects.toThrow(/^Refusing to open external URL with unsupported scheme "http:"$/)
    expect(mocks.openExternal).not.toHaveBeenCalled()
  })

  it('retries with a fresh RPC token when the first call gets a 401', async () => {
    mocks.requestSandboxUiOauthAuthorizeUrl
      .mockRejectedValueOnce(new ApiError('Unauthorized', 401, ''))
      .mockResolvedValueOnce({ authorizeUrl: AUTHORIZE_URL })
    mocks.getOrIssue
      .mockResolvedValueOnce({ token: 'rpc-token-old' })
      .mockResolvedValueOnce({ token: 'rpc-token-new' })
    mocks.showMessageBox.mockResolvedValue({ response: 1 })

    const svc = makeService()
    await svc.requestSandboxUiOauthAuthorize(RECIPE_NS, RECIPE_NAME, CLIENT_ID, true)

    expect(mocks.rpcTokenManagerClear).toHaveBeenCalledOnce()
    expect(mocks.requestSandboxUiOauthAuthorizeUrl).toHaveBeenCalledTimes(2)
    expect(mocks.requestSandboxUiOauthAuthorizeUrl).toHaveBeenLastCalledWith(
      'rpc-token-new',
      RECIPE_NS,
      RECIPE_NAME,
      CLIENT_ID,
      true
    )
    expect(mocks.openExternal).toHaveBeenCalledWith(AUTHORIZE_URL)
  })
})
