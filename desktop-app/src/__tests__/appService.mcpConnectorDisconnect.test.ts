/**
 * Tests for the proactive-connectors destructive path in the main process
 * (spec 11 U3/U4): AppService.disconnectMcpServer and the confirm-dialog guard
 * shared with AppService.requestMcpOauthAuthorize.
 *
 * This is the missing detector for B-2: the panel adds a team-scoped, native-
 * dialog-gated revocation with NO main-process test, so a mutation that turns
 * the revoke into a no-op, ignores the user's cancel, or drops the connect
 * consent dialog all stay green. These tests assert the OBSERVABLE main-side
 * effect — whether `deleteMcpOauthGrant` / `requestMcpOauthAuthorizeUrl` is
 * actually called, and the dialog copy — so they kill M13 / M14 / M15.
 *
 * `issueRpcTokenForHostRefs` (team resolution + token mint) is stubbed on the
 * instance: it is not what these mutants touch, and stubbing it keeps the test
 * pinned to the dialog + DELETE behavior rather than the token lane.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppService } from '../appService.js'
import { ApiError } from '../httpClient.js'

// ── Hoisted mock refs ─────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  showMessageBox: vi.fn(),
  getFocusedWindow: vi.fn<() => null | { id: number }>(),
  openExternal: vi.fn(),
  deleteMcpOauthGrant: vi.fn(),
  requestMcpOauthAuthorizeUrl: vi.fn(),
  rpcTokenManagerClear: vi.fn(),
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
    getOrIssue = vi.fn()
    clear = mocks.rpcTokenManagerClear
    getMetadata = vi.fn().mockReturnValue({ expiresAtMs: null, scopes: [], hostRefs: [] })
  },
}))

vi.mock('../rpcProxyClient.js', () => ({
  RpcProxyClient: class {
    health = vi.fn().mockResolvedValue({ status: 'ok' })
    deleteMcpOauthGrant = mocks.deleteMcpOauthGrant
    requestMcpOauthAuthorizeUrl = mocks.requestMcpOauthAuthorizeUrl
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
const SERVER = 'shared-drive'
const HOST_REF = 'agent-alpha'
const CTX = 'ctx-team'
const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x'

function makeService(): AppService {
  const svc = new AppService()
  ;(svc as unknown as { sessionToken: string }).sessionToken = 'session-token'
  // Pin the token lane: these tests are about the dialog + DELETE, not minting.
  ;(
    svc as unknown as {
      issueRpcTokenForHostRefs: (...args: unknown[]) => Promise<{ token: string }>
    }
  ).issueRpcTokenForHostRefs = vi.fn().mockResolvedValue({ token: 'rpc-token' })
  return svc
}

// ── Tests ─────────────────────────────────────────────────────────────────────
describe('AppService.disconnectMcpServer (spec 11 U4 — destructive revoke)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getFocusedWindow.mockReturnValue(null)
    mocks.showMessageBox.mockResolvedValue({ response: 1 }) // default: confirm
    mocks.deleteMcpOauthGrant.mockResolvedValue(undefined)
    mocks.requestMcpOauthAuthorizeUrl.mockResolvedValue({ authorizeUrl: AUTHORIZE_URL })
    mocks.openExternal.mockResolvedValue(undefined)
  })

  it('CANCEL (response=0) → returns {confirmed:false} and NEVER calls the revoke (kills M13/M15)', async () => {
    mocks.showMessageBox.mockResolvedValue({ response: 0 })

    const svc = makeService()
    const result = await svc.disconnectMcpServer(SERVER, HOST_REF, CTX, { shared: true })

    expect(result).toEqual({ confirmed: false })
    expect(mocks.showMessageBox).toHaveBeenCalledOnce()
    expect(mocks.deleteMcpOauthGrant).not.toHaveBeenCalled()
  })

  it('CONFIRM (response=1) → calls deleteMcpOauthGrant(token, server, ctx) and returns {confirmed:true} (kills M15)', async () => {
    const svc = makeService()
    const result = await svc.disconnectMcpServer(SERVER, HOST_REF, CTX, { shared: true })

    expect(result).toEqual({ confirmed: true })
    expect(mocks.deleteMcpOauthGrant).toHaveBeenCalledWith('rpc-token', SERVER, CTX)
  })

  it('shared copy names the team-wide blast radius', async () => {
    const svc = makeService()
    await svc.disconnectMcpServer(SERVER, HOST_REF, CTX, { shared: true })

    expect(mocks.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({
        message: `Disconnect "${SERVER}" for the whole team?`,
        detail: expect.stringContaining('every agent in this context'),
        buttons: ['Cancel', 'Disconnect'],
      })
    )
  })

  it('defaults the destructive dialog to Cancel so a stray Enter never revokes (R1-M9)', async () => {
    const svc = makeService()
    await svc.disconnectMcpServer(SERVER, HOST_REF, CTX, { shared: true })

    expect(mocks.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'warning', defaultId: 0, cancelId: 0 })
    )
  })

  it('non-shared copy scopes to the user only', async () => {
    const svc = makeService()
    await svc.disconnectMcpServer(SERVER, HOST_REF, undefined, { shared: false })

    expect(mocks.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({
        message: `Disconnect "${SERVER}"?`,
        detail: expect.stringContaining('removes your authorization'),
      })
    )
    // Non-shared carries no contextId to the revoke.
    expect(mocks.deleteMcpOauthGrant).toHaveBeenCalledWith('rpc-token', SERVER, undefined)
  })

  it('retries the revoke with a fresh token after a 401', async () => {
    mocks.deleteMcpOauthGrant
      .mockRejectedValueOnce(new ApiError('Unauthorized', 401, ''))
      .mockResolvedValueOnce(undefined)

    const svc = makeService()
    const result = await svc.disconnectMcpServer(SERVER, HOST_REF, CTX, { shared: true })

    expect(result).toEqual({ confirmed: true })
    expect(mocks.rpcTokenManagerClear).toHaveBeenCalledOnce()
    expect(mocks.deleteMcpOauthGrant).toHaveBeenCalledTimes(2)
  })
})

describe('AppService.requestMcpOauthAuthorize (spec 11 U3 — proactive connect consent)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getFocusedWindow.mockReturnValue(null)
    mocks.showMessageBox.mockResolvedValue({ response: 1 })
    mocks.requestMcpOauthAuthorizeUrl.mockResolvedValue({ authorizeUrl: AUTHORIZE_URL })
    mocks.openExternal.mockResolvedValue(undefined)
  })

  it('confirmShared + CANCEL → never mints the authorize URL and never opens the browser (kills M14)', async () => {
    mocks.showMessageBox.mockResolvedValue({ response: 0 })

    const svc = makeService()
    await svc.requestMcpOauthAuthorize(SERVER, HOST_REF, CTX, { confirmShared: true })

    expect(mocks.showMessageBox).toHaveBeenCalledOnce()
    expect(mocks.requestMcpOauthAuthorizeUrl).not.toHaveBeenCalled()
    expect(mocks.openExternal).not.toHaveBeenCalled()
  })

  it('confirmShared + CONFIRM → mints the URL and opens the browser', async () => {
    const svc = makeService()
    await svc.requestMcpOauthAuthorize(SERVER, HOST_REF, CTX, { confirmShared: true })

    expect(mocks.requestMcpOauthAuthorizeUrl).toHaveBeenCalledWith('rpc-token', SERVER, CTX)
    expect(mocks.openExternal).toHaveBeenCalledWith(AUTHORIZE_URL)
  })

  it('without confirmShared (reactive U5 path) → NO dialog, proceeds directly', async () => {
    const svc = makeService()
    await svc.requestMcpOauthAuthorize(SERVER, HOST_REF, CTX, { confirmShared: false })

    expect(mocks.showMessageBox).not.toHaveBeenCalled()
    expect(mocks.requestMcpOauthAuthorizeUrl).toHaveBeenCalledWith('rpc-token', SERVER, CTX)
    expect(mocks.openExternal).toHaveBeenCalledWith(AUTHORIZE_URL)
  })
})
