import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import fsSync from 'node:fs'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Same real AppService/TokenStore harness as pendingExternalLogout.test.ts.
const runtime = vi.hoisted(() => ({ directory: '', keychain: new Map<string, string>() }))
const { notifySessionChanged } = vi.hoisted(() => ({ notifySessionChanged: vi.fn() }))
const keyOf = (service: string, account: string) => `${service}::${account}`
vi.mock('keytar', () => ({
  getPassword: vi.fn(
    async (service: string, account: string) =>
      runtime.keychain.get(`${service}::${account}`) ?? null
  ),
  setPassword: vi.fn(async (service: string, account: string, token: string) => {
    runtime.keychain.set(`${service}::${account}`, token)
  }),
  deletePassword: vi.fn(async (service: string, account: string) =>
    runtime.keychain.delete(`${service}::${account}`)
  ),
}))
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => runtime.directory), isReady: vi.fn(() => true) },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(value)),
    decryptString: vi.fn((value: Buffer) => value.toString()),
  },
}))
vi.mock('../chatStoreBinding.js', () => ({
  bindChatStoreForUser: vi.fn(),
  unbindChatStore: vi.fn(),
  __setChatStoreBaseDirForTests: vi.fn(),
}))
vi.mock('../pluginSdkRuntime.js', () => ({
  tryGetPluginSdkRuntime: () => ({ notifySessionChanged, unpinAllSandboxUiSurfaces: vi.fn() }),
}))

let AppServiceClass: typeof import('../appService.js').AppService
let TokenStoreClass: typeof import('../tokenStore.js').TokenStore
let markerStore: typeof import('../pendingExternalLogout.js')
let activeEnvKey = ''
const loginResult = {
  token: 'fixture-fresh-verified-session',
  me: {
    id: 'user-1',
    email: 'user@example.com',
    name: null,
    picture: null,
    teamId: 'team-1',
    teamName: 'Team 1',
    role: 'member' as const,
  },
}

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  runtime.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-marker-coverage-'))
  runtime.keychain.clear()
  const keytar = await import('keytar')
  vi.mocked(keytar.getPassword)
    .mockReset()
    .mockImplementation(
      async (service, account) => runtime.keychain.get(keyOf(service, account)) ?? null
    )
  vi.mocked(keytar.setPassword)
    .mockReset()
    .mockImplementation(async (service, account, token) => {
      runtime.keychain.set(keyOf(service, account), token)
    })
  vi.mocked(keytar.deletePassword)
    .mockReset()
    .mockImplementation(async (service, account) =>
      runtime.keychain.delete(keyOf(service, account))
    )
  const [app, tokens, markers, config] = await Promise.all([
    import('../appService.js'),
    import('../tokenStore.js'),
    import('../pendingExternalLogout.js'),
    import('../config.js'),
  ])
  AppServiceClass = app.AppService
  TokenStoreClass = tokens.TokenStore
  markerStore = markers
  activeEnvKey = config.getActiveEnvKey()
  const { safeStorage } = await import('electron')
  vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
})

afterEach(async () => {
  vi.restoreAllMocks()
  if (runtime.directory) await fs.rm(runtime.directory, { recursive: true, force: true })
  runtime.directory = ''
  runtime.keychain.clear()
  vi.resetModules()
})

function createService(tokenStore = new TokenStoreClass()) {
  const reportFailure = vi.fn()
  const service = new AppServiceClass({
    tokenStore,
    getUserDataDirectory: () => runtime.directory,
    reportDeferredLogoutFailure: reportFailure,
  })
  const state = service as unknown as {
    sessionToken: string | null
    me: typeof loginResult.me | null
    installAuthenticatedLogin: (result: typeof loginResult) => Promise<unknown>
    installAuthenticatedLoginOnce: (result: typeof loginResult) => Promise<unknown>
    authClient: { getMe: (token: string) => Promise<typeof loginResult.me> }
  }
  return { service, tokenStore, state, reportFailure }
}

function markerPath() {
  const digest = createHash('sha256').update(activeEnvKey).digest('hex')
  return path.join(runtime.directory, `pending-external-logout-${digest}`)
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

// These characterize current accepted marker cells and kill targeted guard mutants.
describe('pending logout accepted lifecycle coverage', () => {
  it('removes stale active Keytar on canceled-quit retry before safeStorage restart', async () => {
    const { service, tokenStore, state } = createService()
    const freshToken = 'fixture-fresh-safe-storage'
    await tokenStore.setSessionToken('fixture-stale-logged-out', activeEnvKey)
    await tokenStore.setSafeStorageSessionToken(freshToken, activeEnvKey)
    markerStore.recordPendingKeytarCleanup(runtime.directory, activeEnvKey, 'safe-storage')
    state.sessionToken = freshToken
    state.me = loginResult.me
    await service.prepareForQuit()
    service.cancelQuitPreparation()

    await expect(service.applyPendingExternalLogoutIntent()).resolves.toBe(false)
    expect(state.sessionToken).toBe(freshToken)
    expect(state.me).toEqual(loginResult.me)
    expect(notifySessionChanged).not.toHaveBeenCalledWith(false)
    expect(markerStore.readPendingExternalLogoutMarker(runtime.directory, activeEnvKey)).toBeNull()

    const restarted = createService()
    vi.spyOn(restarted.state.authClient, 'getMe').mockResolvedValue(loginResult.me)
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: loginResult.me,
    })
    expect(restarted.state.sessionToken).toBe(freshToken)
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(freshToken)
  })

  it.each(['retire', 'convert'] as const)(
    'rejects a login racing a newer same-intent logout during %s',
    async mode => {
      markerStore.recordPendingExternalLogout(runtime.directory, activeEnvKey)
      const { service, tokenStore, state } = createService()
      const observed = markerStore.readPendingExternalLogoutMarker(runtime.directory, activeEnvKey)!
      if (mode === 'convert') {
        const keytar = await import('keytar')
        vi.mocked(keytar.getPassword).mockRejectedValue(new Error('keychain locked'))
        vi.mocked(keytar.setPassword).mockRejectedValue(new Error('keychain locked'))
        vi.mocked(keytar.deletePassword).mockRejectedValue(new Error('keychain locked'))
      }
      const started = deferred()
      const release = deferred()
      const write = mode === 'retire' ? 'setSessionToken' : 'setSafeStorageSessionToken'
      const persist = tokenStore[write].bind(tokenStore)
      vi.spyOn(tokenStore, write).mockImplementation(async (...args) => {
        started.resolve()
        await release.promise
        return persist(...args)
      })
      const login = state.installAuthenticatedLogin(loginResult)
      await started.promise
      const draining = service.prepareForQuit()
      await expect(service.logout()).rejects.toThrow('shutting down')
      const newer = markerStore.readPendingExternalLogoutMarker(runtime.directory, activeEnvKey)!
      expect(newer.intent).toEqual(observed.intent)
      expect(newer.revision).not.toBe(observed.revision)
      release.resolve()

      await expect(login).rejects.toThrow(/Pending logout intent changed|superseded/)
      await draining
      expect(state.sessionToken).toBeNull()
      expect(state.me).toBeNull()
      expect(markerStore.readPendingExternalLogoutIntent(runtime.directory, activeEnvKey)).toEqual({
        intent: 'logout-pending',
      })
      const restarted = createService()
      const authenticate = vi.spyOn(restarted.state.authClient, 'getMe')
      await expect(restarted.service.initialize()).resolves.toEqual({
        authenticated: false,
        me: null,
      })
      expect(authenticate).not.toHaveBeenCalled()
      expect(restarted.state.sessionToken).toBeNull()
    }
  )

  it('rewrites source-bound cleanup after restore retirement unlinks then fails directory sync', async () => {
    const { service, tokenStore, state, reportFailure } = createService()
    await tokenStore.setSafeStorageSessionToken(loginResult.token, activeEnvKey)
    markerStore.recordPendingKeytarCleanup(runtime.directory, activeEnvKey, 'safe-storage')
    vi.spyOn(state.authClient, 'getMe').mockResolvedValue(loginResult.me)
    const sync = fsSync.fsyncSync.bind(fsSync)
    let failed = false
    vi.spyOn(fsSync, 'fsyncSync').mockImplementation(descriptor => {
      if (
        !failed &&
        fsSync.fstatSync(descriptor).isDirectory() &&
        !fsSync.existsSync(markerPath())
      ) {
        failed = true
        throw new Error('retirement directory sync failed')
      }
      return sync(descriptor)
    })

    await expect(service.initialize()).resolves.toEqual({ authenticated: true, me: loginResult.me })
    expect(failed).toBe(true)
    expect(state.sessionToken).toBe(loginResult.token)
    expect(markerStore.readPendingExternalLogoutIntent(runtime.directory, activeEnvKey)).toEqual({
      intent: 'keytar-cleanup-pending',
      credentialSource: 'safe-storage',
    })
    expect(reportFailure).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'retirement directory sync failed' })
    )
    await expect(tokenStore.getSafeStorageSessionToken(activeEnvKey)).resolves.toBe(
      loginResult.token
    )
  })

  it('uses verified safeStorage after an active-Keytar cleanup login cannot write Keytar', async () => {
    const { tokenStore, state } = createService()
    await tokenStore.setSessionToken('fixture-stale-keytar', activeEnvKey)
    markerStore.recordPendingKeytarCleanup(runtime.directory, activeEnvKey, 'active-keytar')
    const keytar = await import('keytar')
    vi.mocked(keytar.setPassword).mockRejectedValue(new Error('keychain write denied'))

    await expect(state.installAuthenticatedLoginOnce(loginResult)).resolves.toEqual({
      authenticated: true,
      me: loginResult.me,
    })
    expect(markerStore.readPendingExternalLogoutIntent(runtime.directory, activeEnvKey)).toEqual({
      intent: 'keytar-cleanup-pending',
      credentialSource: 'safe-storage',
    })
    const restarted = createService()
    vi.spyOn(restarted.state.authClient, 'getMe').mockResolvedValue(loginResult.me)
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: loginResult.me,
    })
    expect(restarted.state.sessionToken).toBe(loginResult.token)
  })

  it('replaces an unavailable cleanup credential with a verified encrypted login and retains cleanup', async () => {
    const { state, tokenStore } = createService()
    markerStore.recordPendingKeytarCleanup(runtime.directory, activeEnvKey, 'safe-storage')
    const keytar = await import('keytar')
    vi.mocked(keytar.getPassword).mockRejectedValue(new Error('keychain unavailable'))
    vi.mocked(keytar.setPassword).mockRejectedValue(new Error('keychain unavailable'))
    vi.mocked(keytar.deletePassword).mockRejectedValue(new Error('keychain unavailable'))

    await expect(state.installAuthenticatedLoginOnce(loginResult)).resolves.toEqual({
      authenticated: true,
      me: loginResult.me,
    })
    expect(markerStore.readPendingExternalLogoutIntent(runtime.directory, activeEnvKey)).toEqual({
      intent: 'keytar-cleanup-pending',
      credentialSource: 'safe-storage',
    })
    await expect(tokenStore.getSafeStorageSessionToken(activeEnvKey)).resolves.toBe(
      loginResult.token
    )
    const restarted = createService()
    vi.spyOn(restarted.state.authClient, 'getMe').mockResolvedValue(loginResult.me)
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: loginResult.me,
    })
    expect(restarted.state.sessionToken).toBe(loginResult.token)
  })

  it('rejects isolated default-store recovery when its fresh persisted token cannot be read back', async () => {
    const tokenStore = new TokenStoreClass({ isolatedUserDataPath: runtime.directory })
    const { state } = createService(tokenStore)
    markerStore.recordPendingExternalLogout(runtime.directory, activeEnvKey)
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    const originalWrite = tokenStore.setSessionToken.bind(tokenStore)
    vi.spyOn(tokenStore, 'setSessionToken').mockImplementation(async (...args) => {
      await originalWrite(...args)
      await fs.writeFile(
        path.join(runtime.directory, `session-token-${activeEnvKey}.json`),
        '{not-json'
      )
    })

    const failure = await state.installAuthenticatedLoginOnce(loginResult).catch(error => error)
    expect(state.sessionToken).toBeNull()
    expect(state.me).toBeNull()
    expect(markerStore.readPendingExternalLogoutIntent(runtime.directory, activeEnvKey)).toEqual({
      intent: 'logout-pending',
    })
    expect(failure).toBeInstanceOf(Error)
  })

  it('rejects ordinary logout when strict deletion and durable marker persistence both fail', async () => {
    const { service, tokenStore, state, reportFailure } = createService()
    await tokenStore.setSessionToken('fixture-stale-logged-out', activeEnvKey)
    state.sessionToken = 'fixture-stale-logged-out'
    state.me = loginResult.me
    const keytar = await import('keytar')
    vi.mocked(keytar.deletePassword).mockRejectedValue(new Error('keychain delete denied'))
    const open = fsSync.openSync.bind(fsSync)
    vi.spyOn(fsSync, 'openSync').mockImplementation((...args) => {
      if (String(args[0]).startsWith(`${markerPath()}.`)) throw new Error('marker write denied')
      return open(...args)
    })

    await expect(service.logout()).rejects.toThrow('marker write denied')
    expect(state.sessionToken).toBeNull()
    expect(state.me).toBeNull()
    expect(notifySessionChanged).toHaveBeenCalledWith(false)
    expect(reportFailure).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'marker write denied' })
    )
    expect(markerStore.readPendingExternalLogoutMarker(runtime.directory, activeEnvKey)).toBeNull()
  })

  it('does not retire an observed cleanup marker after upgrading its logout intent failed', async () => {
    const { service, tokenStore, state } = createService()
    await tokenStore.setSafeStorageSessionToken(loginResult.token, activeEnvKey)
    state.sessionToken = loginResult.token
    state.me = loginResult.me
    markerStore.recordPendingKeytarCleanup(runtime.directory, activeEnvKey, 'safe-storage')
    const observed = markerStore.readPendingExternalLogoutMarker(runtime.directory, activeEnvKey)
    const open = fsSync.openSync.bind(fsSync)
    vi.spyOn(fsSync, 'openSync').mockImplementation((...args) => {
      if (String(args[0]).startsWith(`${markerPath()}.`)) throw new Error('marker rewrite denied')
      return open(...args)
    })

    await expect(service.logout()).resolves.toBeUndefined()
    expect(state.sessionToken).toBeNull()
    expect(state.me).toBeNull()
    await expect(tokenStore.getSafeStorageSessionToken(activeEnvKey)).resolves.toBeNull()
    expect(markerStore.readPendingExternalLogoutMarker(runtime.directory, activeEnvKey)).toEqual(
      observed
    )
  })
})
