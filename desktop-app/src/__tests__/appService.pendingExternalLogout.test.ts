import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import fsSync from 'node:fs'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bindChatStoreForUser } from '../chatStoreBinding.js'

let userDataDirectory = ''
let activeEnvKey = ''
let AppServiceClass: typeof import('../appService.js').AppService
let QuitAdmissionClosedErrorClass: typeof import('../appService.js').QuitAdmissionClosedError
let TokenStoreClass: typeof import('../tokenStore.js').TokenStore
let markerStore: typeof import('../pendingExternalLogout.js')
let quitLifecycle: typeof import('../mainWindowCoordinator.js')

const { notifySessionChanged } = vi.hoisted(() => ({ notifySessionChanged: vi.fn() }))

const keychain = new Map<string, string>()
const keyOf = (service: string, account: string) => `${service}::${account}`

vi.mock('keytar', () => ({
  getPassword: vi.fn(async (service: string, account: string) =>
    keychain.has(keyOf(service, account)) ? keychain.get(keyOf(service, account))! : null
  ),
  setPassword: vi.fn(async (service: string, account: string, password: string) => {
    keychain.set(keyOf(service, account), password)
  }),
  deletePassword: vi.fn(async (service: string, account: string) =>
    keychain.delete(keyOf(service, account))
  ),
}))

vi.mock('../chatStoreBinding.js', () => ({
  bindChatStoreForUser: vi.fn(),
  unbindChatStore: vi.fn(),
  __setChatStoreBaseDirForTests: vi.fn(),
}))

vi.mock('../pluginSdkRuntime.js', () => ({
  tryGetPluginSdkRuntime: () => ({ notifySessionChanged, unpinAllSandboxUiSurfaces: vi.fn() }),
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => userDataDirectory),
    isReady: vi.fn(() => true),
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: vi.fn((value: string) => Buffer.from(value, 'utf8')),
    decryptString: vi.fn((value: Buffer) => value.toString('utf8')),
  },
}))

beforeEach(async () => {
  vi.clearAllMocks()
  userDataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-app-pending-logout-'))
  keychain.clear()
  vi.resetModules()
  const keytar = await import('keytar')
  vi.mocked(keytar.getPassword)
    .mockReset()
    .mockImplementation(async (service, account) =>
      keychain.has(keyOf(service, account)) ? keychain.get(keyOf(service, account))! : null
    )
  vi.mocked(keytar.setPassword)
    .mockReset()
    .mockImplementation(async (service, account, password) => {
      keychain.set(keyOf(service, account), password)
    })
  vi.mocked(keytar.deletePassword)
    .mockReset()
    .mockImplementation(async (service, account) => keychain.delete(keyOf(service, account)))
  const [{ AppService, QuitAdmissionClosedError }, tokenStore, pendingLogout, config, lifecycle] =
    await Promise.all([
      import('../appService.js'),
      import('../tokenStore.js'),
      import('../pendingExternalLogout.js'),
      import('../config.js'),
      import('../mainWindowCoordinator.js'),
    ])
  AppServiceClass = AppService
  QuitAdmissionClosedErrorClass = QuitAdmissionClosedError
  TokenStoreClass = tokenStore.TokenStore
  markerStore = pendingLogout
  quitLifecycle = lifecycle
  activeEnvKey = config.getActiveEnvKey()
  const { safeStorage } = await import('electron')
  vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
})

afterEach(async () => {
  vi.restoreAllMocks()
  if (userDataDirectory) await fs.rm(userDataDirectory, { recursive: true, force: true })
  userDataDirectory = ''
  keychain.clear()
  vi.resetModules()
})

function createService(tokenStore = new TokenStoreClass(), reportFailure = vi.fn()) {
  const service = new AppServiceClass({
    tokenStore,
    getUserDataDirectory: () => userDataDirectory,
    reportDeferredLogoutFailure: reportFailure,
  })
  return { reportFailure, service, tokenStore }
}

function internals(service: InstanceType<typeof AppServiceClass>) {
  return service as unknown as {
    restoreSavedSessionOnce: (...args: unknown[]) => Promise<unknown>
    installAuthenticatedLoginOnce: (result: typeof loginResult) => Promise<unknown>
    installAuthenticatedLogin: (result: typeof loginResult) => Promise<unknown>
    commitSessionToken: (token: string, options?: { refreshMe?: boolean }) => Promise<void>
    runCredentialProducer: (operation: () => Promise<unknown>) => Promise<unknown>
    gfsDispatchBlocked: boolean
    quitPreparationStarted: boolean
    sessionToken: string | null
    me: unknown
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(innerResolve => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

function markerPath(envKey = activeEnvKey): string {
  const environmentId = createHash('sha256').update(envKey).digest('hex')
  return path.join(userDataDirectory, `pending-external-logout-${environmentId}`)
}

function sessionToken(label: string): string {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, fixture: label })
  ).toString('base64url')
  return `header.${payload}.signature`
}

const loginResult = {
  token: sessionToken('fixture-session-token'),
  me: {
    id: 'user-1',
    email: 'user@example.com',
    name: null,
    picture: null,
    teamId: 'team-1',
    teamName: 'Team 1',
    role: 'member',
  },
}

describe('AppService pending external logout', () => {
  it('clears the matching environment before restore and removes the marker on success', async () => {
    markerStore.recordPendingExternalLogout(userDataDirectory, activeEnvKey)
    const { service, tokenStore } = createService()
    const state = service as unknown as {
      sessionToken: string | null
      me: unknown
      suspendDesktopGfsUploadsForAuthBoundary: () => Promise<void>
    }
    state.sessionToken = 'fixture-active-session-token'
    state.me = loginResult.me
    const suspendUploads = vi
      .spyOn(state, 'suspendDesktopGfsUploadsForAuthBoundary')
      .mockResolvedValue()
    const restore = vi.spyOn(internals(service), 'restoreSavedSessionOnce')
    const clearToken = vi.spyOn(tokenStore, 'clearSessionTokenStrictly')

    await expect(service.initialize()).resolves.toEqual({ authenticated: false, me: null })

    expect(clearToken).toHaveBeenCalledWith(activeEnvKey, expect.any(Object))
    expect(suspendUploads).toHaveBeenCalledOnce()
    expect(notifySessionChanged).toHaveBeenCalledWith(false)
    expect(restore).not.toHaveBeenCalled()
    expect(markerStore.hasPendingExternalLogout(userDataDirectory, activeEnvKey)).toBe(false)
  })

  it('keeps startup unauthenticated when strict marker cleanup fails', async () => {
    markerStore.recordPendingExternalLogout(userDataDirectory, activeEnvKey)
    const reportFailure = vi.fn()
    const { service, tokenStore } = createService(undefined, reportFailure)
    await tokenStore.setSessionToken('persisted-session-token', activeEnvKey)
    const keytar = await import('keytar')
    vi.mocked(keytar.deletePassword).mockImplementation(async (_service, account) => {
      if (account === `session-token::${activeEnvKey}`) {
        throw new Error('keychain unavailable')
      }
      return false
    })
    const restore = vi.spyOn(internals(service), 'restoreSavedSessionOnce')

    await expect(service.initialize()).resolves.toEqual({ authenticated: false, me: null })

    expect(restore).not.toHaveBeenCalled()
    expect(reportFailure).toHaveBeenCalledOnce()
    expect(notifySessionChanged).toHaveBeenCalledWith(false)
    expect(markerStore.hasPendingExternalLogout(userDataDirectory, activeEnvKey)).toBe(true)
    await expect(tokenStore.getSessionToken(activeEnvKey)).resolves.toBe('persisted-session-token')
  })

  it('keeps startup recoverable and skips restore when the marker cannot be inspected', async () => {
    await fs.mkdir(markerPath())
    const reportFailure = vi.fn()
    const { service } = createService(undefined, reportFailure)
    const state = service as unknown as {
      sessionToken: string | null
      me: unknown
      suspendDesktopGfsUploadsForAuthBoundary: () => Promise<void>
    }
    state.sessionToken = 'fixture-active-session-token'
    state.me = loginResult.me
    const suspendUploads = vi
      .spyOn(state, 'suspendDesktopGfsUploadsForAuthBoundary')
      .mockResolvedValue()
    const restore = vi.spyOn(internals(service), 'restoreSavedSessionOnce')

    await expect(service.initialize()).resolves.toEqual({ authenticated: false, me: null })

    expect(restore).not.toHaveBeenCalled()
    expect(reportFailure).toHaveBeenCalledOnce()
    expect(suspendUploads).toHaveBeenCalledOnce()
    expect(state.sessionToken).toBeNull()
    expect(state.me).toBeNull()
    expect((await fs.stat(markerPath())).isDirectory()).toBe(true)
  })

  it('fails closed when canceled-quit retry cannot inspect the marker', async () => {
    await fs.mkdir(markerPath())
    const reportFailure = vi.fn()
    const { service } = createService(undefined, reportFailure)
    const state = service as unknown as {
      sessionToken: string | null
      me: unknown
      suspendDesktopGfsUploadsForAuthBoundary: () => Promise<void>
    }
    state.sessionToken = 'fixture-active-session-token'
    state.me = loginResult.me
    const suspendUploads = vi
      .spyOn(state, 'suspendDesktopGfsUploadsForAuthBoundary')
      .mockResolvedValue()

    await expect(service.applyPendingExternalLogoutIntent()).rejects.toThrow(
      'Pending logout marker is not a regular file'
    )

    expect(state.sessionToken).toBeNull()
    expect(state.me).toBeNull()
    expect(suspendUploads).toHaveBeenCalledOnce()
    expect(reportFailure).toHaveBeenCalledOnce()
    expect(notifySessionChanged).toHaveBeenCalledWith(false)
  })

  it('fails closed on login when the pending marker cannot be inspected', async () => {
    await fs.mkdir(markerPath())
    const reportFailure = vi.fn()
    const { service, tokenStore } = createService(undefined, reportFailure)
    const state = service as unknown as {
      sessionToken: string | null
      me: unknown
      suspendDesktopGfsUploadsForAuthBoundary: () => Promise<void>
    }
    state.sessionToken = 'fixture-active-session-token'
    state.me = loginResult.me
    const suspendUploads = vi
      .spyOn(state, 'suspendDesktopGfsUploadsForAuthBoundary')
      .mockResolvedValue()
    const persistToken = vi.spyOn(tokenStore, 'setSessionToken')

    await expect(internals(service).installAuthenticatedLoginOnce(loginResult)).rejects.toThrow(
      'Pending logout marker is not a regular file'
    )

    expect(state.sessionToken).toBeNull()
    expect(state.me).toBeNull()
    expect(suspendUploads).toHaveBeenCalledOnce()
    expect(persistToken).not.toHaveBeenCalled()
    expect(reportFailure).toHaveBeenCalledOnce()
  })

  it('guards both marker credential producers after quit admission closes', async () => {
    markerStore.recordPendingExternalLogout(userDataDirectory, activeEnvKey)
    const { service, tokenStore } = createService()
    internals(service).quitPreparationStarted = true
    const clearToken = vi.spyOn(tokenStore, 'clearSessionTokenStrictly')
    const restore = vi.spyOn(internals(service), 'restoreSavedSessionOnce')

    await expect(service.initialize()).resolves.toEqual({ authenticated: false, me: null })
    await expect(service.applyPendingExternalLogoutIntent()).rejects.toBeInstanceOf(
      QuitAdmissionClosedErrorClass
    )

    expect(clearToken).not.toHaveBeenCalled()
    expect(restore).not.toHaveBeenCalled()
    expect(markerStore.hasPendingExternalLogout(userDataDirectory, activeEnvKey)).toBe(true)
  })

  it('keeps the marker and stored token when canceled-quit retry cannot clear storage', async () => {
    const { service, tokenStore } = createService()
    await tokenStore.setSessionToken('persisted-session-token', activeEnvKey)
    markerStore.recordPendingExternalLogout(userDataDirectory, activeEnvKey)
    const keytar = await import('keytar')
    vi.mocked(keytar.deletePassword).mockRejectedValueOnce(new Error('keychain unavailable'))

    await expect(service.applyPendingExternalLogoutIntent()).rejects.toMatchObject({
      message: 'Failed to clear session token storage',
    })

    expect(notifySessionChanged).toHaveBeenCalledWith(false)
    expect(markerStore.hasPendingExternalLogout(userDataDirectory, activeEnvKey)).toBe(true)
    await expect(tokenStore.getSessionToken(activeEnvKey)).resolves.toBe('persisted-session-token')
  })

  it('applies the marker after quit cancellation reopens both admission gates', async () => {
    const { service, tokenStore } = createService()
    await tokenStore.setSessionToken('persisted-session-token', activeEnvKey)
    markerStore.recordPendingExternalLogout(userDataDirectory, activeEnvKey)
    await service.prepareForQuit()
    const callbackOrder: string[] = []
    const applied = vi.fn(() => callbackOrder.push('notified'))
    const failed = vi.fn()

    quitLifecycle.retryPendingExternalLogoutAfterQuitCancellation(
      () => {
        callbackOrder.push('cancel')
        service.cancelQuitPreparation()
      },
      () => {
        callbackOrder.push('apply')
        return service.applyPendingExternalLogoutIntent()
      },
      applied,
      failed
    )
    await vi.waitFor(() => expect(applied).toHaveBeenCalledOnce())

    expect(callbackOrder).toEqual(['cancel', 'apply', 'notified'])
    expect(failed).not.toHaveBeenCalled()
    expect(markerStore.hasPendingExternalLogout(userDataDirectory, activeEnvKey)).toBe(false)
    await expect(tokenStore.getSessionToken(activeEnvKey)).resolves.toBeNull()
  })

  it('keeps an authenticated session when canceled-quit retry only has Keytar cleanup pending', async () => {
    const { service, tokenStore } = createService()
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
    await tokenStore.setSafeStorageSessionToken(loginResult.token, activeEnvKey)
    const state = internals(service)
    state.sessionToken = loginResult.token
    state.me = loginResult.me
    markerStore.recordPendingExternalLogout(userDataDirectory, activeEnvKey)
    markerStore.recordPendingKeytarCleanup(userDataDirectory, activeEnvKey, 'safe-storage')

    await expect(service.applyPendingExternalLogoutIntent()).resolves.toBe(false)

    expect(state.sessionToken).toBe(loginResult.token)
    expect(state.me).toEqual(loginResult.me)
    expect(notifySessionChanged).not.toHaveBeenCalledWith(false)
    expect(markerStore.hasPendingExternalLogout(userDataDirectory, activeEnvKey)).toBe(false)
    expect(await tokenStore.getSafeStorageSessionToken(activeEnvKey)).toBe(loginResult.token)
  })

  it('retires startup cleanup intent only after the recorded credential restores', async () => {
    markerStore.recordPendingKeytarCleanup(userDataDirectory, activeEnvKey, 'active-keytar')
    const { service, tokenStore } = createService()
    await tokenStore.setSessionToken('verified-active-keytar-token', activeEnvKey)
    const authClient = (
      service as unknown as {
        authClient: { getMe: (token: string) => Promise<typeof loginResult.me> }
      }
    ).authClient
    const getMe = vi
      .spyOn(authClient, 'getMe')
      .mockRejectedValueOnce(new Error('temporary network failure'))
      .mockResolvedValueOnce(loginResult.me)

    await expect(service.initialize()).resolves.toEqual({ authenticated: false, me: null })
    expect(markerStore.readPendingExternalLogoutIntent(userDataDirectory, activeEnvKey)).toEqual({
      intent: 'keytar-cleanup-pending',
      credentialSource: 'active-keytar',
    })

    await expect(service.initialize()).resolves.toEqual({
      authenticated: true,
      me: loginResult.me,
    })
    expect(getMe).toHaveBeenCalledTimes(2)
    expect(markerStore.hasPendingExternalLogout(userDataDirectory, activeEnvKey)).toBe(false)
  })

  it('rewrites cleanup intent if canceled-quit marker unlink cannot be synced', async () => {
    const reportFailure = vi.fn()
    const { service, tokenStore } = createService(undefined, reportFailure)
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
    await tokenStore.setSafeStorageSessionToken(loginResult.token, activeEnvKey)
    const state = internals(service)
    state.sessionToken = loginResult.token
    state.me = loginResult.me
    markerStore.recordPendingExternalLogout(userDataDirectory, activeEnvKey)
    markerStore.recordPendingKeytarCleanup(userDataDirectory, activeEnvKey, 'safe-storage')
    const originalFsync = fsSync.fsyncSync.bind(fsSync)
    let failedDirectorySync = false
    const fsync = vi.spyOn(fsSync, 'fsyncSync').mockImplementation(descriptor => {
      if (
        !failedDirectorySync &&
        !fsSync.existsSync(markerPath()) &&
        fsSync.fstatSync(descriptor).isDirectory()
      ) {
        failedDirectorySync = true
        throw Object.assign(new Error('directory sync failed'), { code: 'EIO' })
      }
      return originalFsync(descriptor)
    })

    try {
      await expect(service.applyPendingExternalLogoutIntent()).resolves.toBe(false)

      expect(failedDirectorySync).toBe(true)
      expect(JSON.parse(await fs.readFile(markerPath(), 'utf8'))).toMatchObject({
        version: 1,
        intent: 'keytar-cleanup-pending',
        credentialSource: 'safe-storage',
      })
      expect(state.sessionToken).toBe(loginResult.token)
      expect(state.me).toEqual(loginResult.me)
      expect(reportFailure).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'directory sync failed' })
      )
    } finally {
      fsync.mockRestore()
    }
  })

  it('does not restore a plaintext token after safeStorage cleanup succeeds', async () => {
    markerStore.recordPendingExternalLogout(userDataDirectory, activeEnvKey)
    markerStore.recordPendingKeytarCleanup(userDataDirectory, activeEnvKey, 'safe-storage')
    const { service, tokenStore } = createService()
    const authClient = (
      service as unknown as {
        authClient: { getMe: (token: string) => Promise<typeof loginResult.me> }
      }
    ).authClient
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
    vi.mocked(safeStorage.decryptString).mockImplementation(value => {
      if (value.toString() === 'corrupt') throw new Error('encrypted credential is corrupt')
      return value.toString('utf8')
    })
    vi.spyOn(authClient, 'getMe').mockResolvedValue(loginResult.me)
    await fs.writeFile(
      path.join(userDataDirectory, `session-token-${activeEnvKey}.json`),
      JSON.stringify({ token: 'fixture-stale-plaintext-session-token' })
    )
    await fs.writeFile(path.join(userDataDirectory, `session-token-${activeEnvKey}.enc`), 'corrupt')

    await expect(service.initialize()).resolves.toEqual({ authenticated: false, me: null })

    expect(markerStore.readPendingExternalLogoutIntent(userDataDirectory, activeEnvKey)).toEqual({
      intent: 'keytar-cleanup-pending',
      credentialSource: 'safe-storage',
    })
    expect(authClient.getMe).not.toHaveBeenCalled()
    await expect(tokenStore.getSessionToken(activeEnvKey)).resolves.toBe(
      'fixture-stale-plaintext-session-token'
    )
  })

  it('removes stale active and legacy Keytar tokens before retiring a safeStorage marker', async () => {
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
    markerStore.recordPendingKeytarCleanup(userDataDirectory, activeEnvKey, 'safe-storage')
    const { service, tokenStore } = createService()
    await tokenStore.setSessionToken('fixture-stale-active-keytar-token', activeEnvKey)
    keychain.set(keyOf('Evenfire', 'session-token'), 'fixture-stale-legacy-keytar-token')
    await tokenStore.setSafeStorageSessionToken('fixture-safe-storage-session-token', activeEnvKey)
    const authClient = (
      service as unknown as {
        authClient: { getMe: (token: string) => Promise<typeof loginResult.me> }
      }
    ).authClient
    vi.spyOn(authClient, 'getMe').mockResolvedValue(loginResult.me)

    await expect(service.initialize()).resolves.toEqual({
      authenticated: true,
      me: loginResult.me,
    })

    expect(keychain.has(keyOf('Evenfire', `session-token::${activeEnvKey}`))).toBe(false)
    expect(keychain.has(keyOf('Evenfire', 'session-token'))).toBe(false)
    expect(markerStore.hasPendingExternalLogout(userDataDirectory, activeEnvKey)).toBe(false)

    const { service: restarted } = createService()
    const restartedAuthClient = (
      restarted as unknown as {
        authClient: { getMe: (token: string) => Promise<typeof loginResult.me> }
      }
    ).authClient
    vi.spyOn(restartedAuthClient, 'getMe').mockResolvedValue(loginResult.me)
    await expect(restarted.initialize()).resolves.toEqual({
      authenticated: true,
      me: loginResult.me,
    })
    expect(internals(restarted).sessionToken).toBe('fixture-safe-storage-session-token')
  })

  it('recovers an explicit login from a malformed marker after secure persistence', async () => {
    await fs.writeFile(markerPath(), '{not-json')
    const { service } = createService()
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)

    await expect(internals(service).installAuthenticatedLoginOnce(loginResult)).resolves.toEqual({
      authenticated: true,
      me: loginResult.me,
    })

    expect(
      markerStore.readPendingExternalLogoutIntent(userDataDirectory, activeEnvKey)
    ).toMatchObject({
      intent: 'keytar-cleanup-pending',
    })
    expect(internals(service).sessionToken).toBe(loginResult.token)
    expect(await fs.readdir(userDataDirectory)).not.toContain(`session-token-${activeEnvKey}.json`)
  })

  it('does not read plaintext when the safeStorage-only source is absent', async () => {
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
    const { tokenStore } = createService()
    await fs.writeFile(
      path.join(userDataDirectory, `session-token-${activeEnvKey}.json`),
      JSON.stringify({ token: 'fixture-plaintext-token' })
    )

    await expect(tokenStore.getSafeStorageSessionToken(activeEnvKey)).resolves.toBeNull()
  })

  it('allows the first isolated-development login after a strict marker cleanup', async () => {
    markerStore.recordPendingExternalLogout(userDataDirectory, activeEnvKey)
    const isolatedStore = new TokenStoreClass({ isolatedUserDataPath: userDataDirectory })
    const { service } = createService(isolatedStore)

    await expect(
      internals(service).installAuthenticatedLoginOnce(loginResult)
    ).resolves.toMatchObject({
      authenticated: true,
      me: loginResult.me,
    })

    expect(markerStore.readPendingExternalLogoutMarker(userDataDirectory, activeEnvKey)).toBeNull()
    expect(internals(service).sessionToken).toBe(loginResult.token)
  })

  it('keeps a logout marker and clears the runtime session when strict logout cleanup fails', async () => {
    const reportFailure = vi.fn()
    markerStore.recordPendingKeytarCleanup(userDataDirectory, activeEnvKey, 'safe-storage')
    const { service, tokenStore } = createService(undefined, reportFailure)
    await tokenStore.setSessionToken('fixture-stale-keytar-token', activeEnvKey)
    const state = internals(service)
    state.sessionToken = 'fixture-stale-keytar-token'
    state.me = loginResult.me
    const keytar = await import('keytar')
    const originalDelete = vi.mocked(keytar.deletePassword).getMockImplementation()!
    vi.mocked(keytar.deletePassword).mockImplementation(async (_service, account) => {
      if (account === `session-token::${activeEnvKey}`) {
        throw new Error('keychain temporarily locked')
      }
      return originalDelete(_service, account)
    })

    try {
      await expect(service.logout()).resolves.toBeTypeOf('number')

      expect(state.sessionToken).toBeNull()
      expect(state.me).toBeNull()
      expect(markerStore.readPendingExternalLogoutIntent(userDataDirectory, activeEnvKey)).toEqual({
        intent: 'logout-pending',
      })
      expect(reportFailure).toHaveBeenCalledOnce()
    } finally {
      vi.mocked(keytar.deletePassword).mockReset().mockImplementation(originalDelete)
    }
  })

  it('keeps normal UI logout durable when regular token cleanup fails', async () => {
    const reportFailure = vi.fn()
    const { service, tokenStore } = createService(undefined, reportFailure)
    const state = internals(service)
    const staleToken = 'fixture-stale-regular-logout-token'
    await tokenStore.setSessionToken(staleToken, activeEnvKey)
    state.sessionToken = staleToken
    state.me = loginResult.me
    const keytar = await import('keytar')
    const originalDelete = vi.mocked(keytar.deletePassword).getMockImplementation()!
    let failActiveDelete = true
    vi.mocked(keytar.deletePassword).mockImplementation(async (keychainService, account) => {
      if (account === `session-token::${activeEnvKey}` && failActiveDelete) {
        failActiveDelete = false
        throw new Error('keychain temporarily locked')
      }
      return originalDelete(keychainService, account)
    })

    try {
      await expect(service.logout()).resolves.toBeTypeOf('number')

      expect(state.sessionToken).toBeNull()
      expect(state.me).toBeNull()
      expect(notifySessionChanged).toHaveBeenCalledWith(false)
      expect(reportFailure).toHaveBeenCalledWith(expect.any(Error))
      expect(markerStore.readPendingExternalLogoutIntent(userDataDirectory, activeEnvKey)).toEqual({
        intent: 'logout-pending',
      })

      const { service: restarted } = createService(new TokenStoreClass())
      const restartedAuthClient = (
        restarted as unknown as { authClient: { getMe: ReturnType<typeof vi.fn> } }
      ).authClient
      const getMe = vi.spyOn(restartedAuthClient, 'getMe')
      await expect(restarted.initialize()).resolves.toEqual({ authenticated: false, me: null })

      expect(getMe).not.toHaveBeenCalled()
      expect(markerStore.hasPendingExternalLogout(userDataDirectory, activeEnvKey)).toBe(false)
      await expect(tokenStore.getSessionToken(activeEnvKey)).resolves.toBeNull()
    } finally {
      vi.mocked(keytar.deletePassword).mockReset().mockImplementation(originalDelete)
    }
  })

  it('does not let an admitted login retire a newer quit-time logout marker', async () => {
    markerStore.recordPendingKeytarCleanup(userDataDirectory, activeEnvKey, 'active-keytar')
    const { service, tokenStore } = createService()
    const storageWriteStarted = deferred<void>()
    const releaseStorageWrite = deferred<void>()
    const setSessionToken = tokenStore.setSessionToken.bind(tokenStore)
    vi.spyOn(tokenStore, 'setSessionToken').mockImplementation(async (...args) => {
      storageWriteStarted.resolve()
      await releaseStorageWrite.promise
      return setSessionToken(...args)
    })

    const login = internals(service).installAuthenticatedLogin(loginResult)
    await storageWriteStarted.promise
    const draining = service.prepareForQuit()

    await expect(service.logout()).rejects.toBeInstanceOf(QuitAdmissionClosedErrorClass)
    expect(markerStore.readPendingExternalLogoutIntent(userDataDirectory, activeEnvKey)).toEqual({
      intent: 'logout-pending',
    })

    releaseStorageWrite.resolve()
    await expect(login).rejects.toThrow(/Pending logout intent changed|superseded/)
    await draining

    expect(markerStore.readPendingExternalLogoutIntent(userDataDirectory, activeEnvKey)).toEqual({
      intent: 'logout-pending',
    })
    expect(internals(service).sessionToken).toBeNull()
  })

  it('keeps safeStorage authoritative when a team switch persists a new session token', async () => {
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
    markerStore.recordPendingKeytarCleanup(userDataDirectory, activeEnvKey, 'safe-storage')
    const { service, tokenStore } = createService()
    const state = internals(service)
    state.sessionToken = 'fixture-old-safe-storage-token'
    state.me = loginResult.me
    await tokenStore.setSafeStorageSessionToken('fixture-old-safe-storage-token', activeEnvKey)

    await state.commitSessionToken('fixture-switched-safe-storage-token')

    await expect(tokenStore.getSafeStorageSessionToken(activeEnvKey)).resolves.toBe(
      'fixture-switched-safe-storage-token'
    )
    expect(keychain.has(keyOf('Evenfire', `session-token::${activeEnvKey}`))).toBe(false)
    expect(markerStore.readPendingExternalLogoutIntent(userDataDirectory, activeEnvKey)).toEqual({
      intent: 'keytar-cleanup-pending',
      credentialSource: 'safe-storage',
    })
  })

  it('retains a source-cleanup revision after a fresh secure login replaces logout intent', async () => {
    markerStore.recordPendingExternalLogout(userDataDirectory, activeEnvKey)
    const { service, tokenStore } = createService()
    await tokenStore.setSessionToken('previous-session-token', activeEnvKey)
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)

    await expect(internals(service).installAuthenticatedLoginOnce(loginResult)).resolves.toEqual({
      authenticated: true,
      me: loginResult.me,
    })

    expect(markerStore.readPendingExternalLogoutIntent(userDataDirectory, activeEnvKey)).toEqual({
      intent: 'keytar-cleanup-pending',
      credentialSource: 'active-keytar',
    })
    await expect(tokenStore.getSessionToken(activeEnvKey)).resolves.toBe(loginResult.token)
  })

  it('lets a fresh Keytar write replace a pending logout credential after delete fails', async () => {
    markerStore.recordPendingExternalLogout(userDataDirectory, activeEnvKey)
    const { service, tokenStore } = createService()
    await tokenStore.setSessionToken('previous-session-token', activeEnvKey)
    const keytar = await import('keytar')
    vi.mocked(keytar.deletePassword).mockRejectedValueOnce(new Error('keychain temporarily locked'))

    await expect(internals(service).installAuthenticatedLoginOnce(loginResult)).resolves.toEqual({
      authenticated: true,
      me: loginResult.me,
    })

    expect(keychain.get(keyOf('Evenfire', `session-token::${activeEnvKey}`))).toBe(
      loginResult.token
    )
    expect(
      markerStore.readPendingExternalLogoutIntent(userDataDirectory, activeEnvKey)
    ).toMatchObject({
      intent: 'keytar-cleanup-pending',
    })
    expect(internals(service).sessionToken).toBe(loginResult.token)
  })

  it('falls back to a verified file when required Keytar replacement also fails', async () => {
    markerStore.recordPendingExternalLogout(userDataDirectory, activeEnvKey)
    const reportFailure = vi.fn()
    const { service, tokenStore } = createService(undefined, reportFailure)
    await tokenStore.setSessionToken('previous-session-token', activeEnvKey)
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
    const keytar = await import('keytar')
    const account = `session-token::${activeEnvKey}`
    const originalGet = vi.mocked(keytar.getPassword).getMockImplementation()!
    const originalSet = vi.mocked(keytar.setPassword).getMockImplementation()!
    const originalDelete = vi.mocked(keytar.deletePassword).getMockImplementation()!
    vi.mocked(keytar.getPassword).mockImplementation(async (service, readAccount) => {
      if (readAccount === account) throw new Error('keychain unavailable')
      return originalGet(service, readAccount)
    })
    vi.mocked(keytar.setPassword).mockRejectedValue(new Error('keychain unavailable'))
    vi.mocked(keytar.deletePassword).mockImplementation(async (_service, deletedAccount) => {
      if (deletedAccount === account) throw new Error('keychain unavailable')
      return false
    })

    try {
      await expect(internals(service).installAuthenticatedLoginOnce(loginResult)).resolves.toEqual({
        authenticated: true,
        me: loginResult.me,
      })

      expect(markerStore.hasPendingExternalLogout(userDataDirectory, activeEnvKey)).toBe(true)
      expect(keytar.setPassword).toHaveBeenCalledWith('Evenfire', account, loginResult.token)
      await expect(tokenStore.getSessionToken(activeEnvKey)).resolves.toBe(loginResult.token)
      expect(reportFailure).toHaveBeenCalledOnce()
    } finally {
      vi.mocked(keytar.getPassword).mockReset().mockImplementation(originalGet)
      vi.mocked(keytar.setPassword).mockReset().mockImplementation(originalSet)
      vi.mocked(keytar.deletePassword).mockReset().mockImplementation(originalDelete)
    }
  })

  it('admits a temporary session when Keytar replacement and safeStorage are unavailable', async () => {
    markerStore.recordPendingExternalLogout(userDataDirectory, activeEnvKey)
    const { service, tokenStore } = createService()
    await tokenStore.setSessionToken('previous-session-token', activeEnvKey)
    const keytar = await import('keytar')
    const account = `session-token::${activeEnvKey}`
    const originalSet = vi.mocked(keytar.setPassword).getMockImplementation()!
    const originalDelete = vi.mocked(keytar.deletePassword).getMockImplementation()!
    vi.mocked(keytar.deletePassword).mockImplementation(async (_service, deletedAccount) => {
      if (deletedAccount === account) throw new Error('keychain temporarily locked')
      return false
    })
    vi.mocked(keytar.setPassword).mockRejectedValue(new Error('keychain temporarily locked'))

    try {
      await expect(
        internals(service).installAuthenticatedLoginOnce(loginResult)
      ).resolves.toMatchObject({
        authenticated: true,
        me: loginResult.me,
        sessionMode: 'temporary',
      })

      expect(
        markerStore.readPendingExternalLogoutIntent(userDataDirectory, activeEnvKey)
      ).toMatchObject({ intent: 'memory-only-session' })
      expect(internals(service).sessionToken).toBe(loginResult.token)
      await expect(tokenStore.getSessionToken(activeEnvKey)).resolves.toBe('previous-session-token')
      expect(await fs.readdir(userDataDirectory)).not.toContain(
        `session-token-${activeEnvKey}.json`
      )
      const restarted = createService()
      const getMe = vi.spyOn(internals(restarted.service).authClient, 'getMe')
      await expect(restarted.service.initialize()).resolves.toEqual({
        authenticated: false,
        me: null,
      })
      expect(getMe).not.toHaveBeenCalled()
    } finally {
      vi.mocked(keytar.setPassword).mockReset().mockImplementation(originalSet)
      vi.mocked(keytar.deletePassword).mockReset().mockImplementation(originalDelete)
    }
  })

  it('uses a durable temporary-session fence after a native write rejects post-publication', async () => {
    markerStore.recordPendingExternalLogout(userDataDirectory, activeEnvKey)
    const reportFailure = vi.fn()
    const { service, tokenStore } = createService(undefined, reportFailure)
    await tokenStore.setSessionToken('previous-session-token', activeEnvKey)
    const keytar = await import('keytar')
    const account = `session-token::${activeEnvKey}`
    const originalDelete = vi.mocked(keytar.deletePassword).getMockImplementation()!
    const originalSet = vi.mocked(keytar.setPassword).getMockImplementation()!
    vi.mocked(keytar.deletePassword).mockImplementation(async (_service, deletedAccount) => {
      if (deletedAccount === account) throw new Error('keychain temporarily locked')
      return false
    })
    vi.mocked(keytar.setPassword).mockImplementation(async (service, writtenAccount, token) => {
      if (writtenAccount === account) {
        keychain.set(keyOf(service, writtenAccount), token)
        throw new Error('keychain rejected after publishing candidate')
      }
      return originalSet(service, writtenAccount, token)
    })
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    const stalePlaintextPath = path.join(userDataDirectory, `session-token-${activeEnvKey}.json`)
    await fs.writeFile(stalePlaintextPath, JSON.stringify({ token: 'fixture-stale-legacy-token' }))

    try {
      await expect(
        internals(service).installAuthenticatedLoginOnce(loginResult)
      ).resolves.toMatchObject({
        authenticated: true,
        me: loginResult.me,
        sessionMode: 'temporary',
      })
      expect(
        markerStore.readPendingExternalLogoutIntent(userDataDirectory, activeEnvKey)
      ).toMatchObject({
        intent: 'memory-only-session',
      })
      expect(await fs.readFile(stalePlaintextPath, 'utf8')).toContain('fixture-stale-legacy-token')
      expect(keychain.get(keyOf('Evenfire', account))).toBe(loginResult.token)
      const restarted = createService()
      const getMe = vi.spyOn(internals(restarted.service).authClient, 'getMe')
      await expect(restarted.service.initialize()).resolves.toEqual({
        authenticated: false,
        me: null,
      })
      expect(getMe).not.toHaveBeenCalled()
    } finally {
      vi.mocked(keytar.deletePassword).mockReset().mockImplementation(originalDelete)
      vi.mocked(keytar.setPassword).mockReset().mockImplementation(originalSet)
    }
  })

  it('reports failed secure writes once and admits the authenticated session in memory', async () => {
    markerStore.recordPendingExternalLogout(userDataDirectory, activeEnvKey)
    const reportFailure = vi.fn()
    const { service, tokenStore } = createService(undefined, reportFailure)
    const keytar = await import('keytar')
    const activeAccount = `session-token::${activeEnvKey}`
    const originalDelete = vi.mocked(keytar.deletePassword).getMockImplementation()!
    vi.mocked(keytar.deletePassword).mockImplementation(async (service, account) => {
      if (account === activeAccount) throw new Error('keychain temporarily locked')
      return originalDelete(service, account)
    })
    vi.spyOn(tokenStore, 'setSessionToken').mockImplementation(async (_token, _envKey, options) => {
      throw new Error(options?.requireKeytar ? 'Keytar replacement failed' : 'file fallback failed')
    })
    vi.spyOn(tokenStore, 'setSafeStorageSessionToken').mockRejectedValue(
      new Error('file fallback failed')
    )

    try {
      await expect(
        internals(service).installAuthenticatedLoginOnce(loginResult)
      ).resolves.toMatchObject({
        authenticated: true,
        me: loginResult.me,
        sessionMode: 'temporary',
      })

      expect(
        reportFailure.mock.calls.map(([error]) =>
          error instanceof Error ? error.message : typeof error
        )
      ).toEqual(['Secure session persistence unavailable; admitted temporary session'])
      expect(
        markerStore.readPendingExternalLogoutIntent(userDataDirectory, activeEnvKey)
      ).toMatchObject({ intent: 'memory-only-session' })
      expect(internals(service).sessionToken).toBe(loginResult.token)
    } finally {
      vi.mocked(keytar.deletePassword).mockReset().mockImplementation(originalDelete)
    }
  })

  it('does not require active-slot replacement when only a legacy env account fails', async () => {
    const { getActiveLegacyEnvKeys } = await import('../config.js')
    const [legacyEnvKey] = getActiveLegacyEnvKeys()
    expect(legacyEnvKey).toBeTruthy()
    markerStore.recordPendingExternalLogout(userDataDirectory, activeEnvKey)
    const { service, tokenStore } = createService()
    await tokenStore.setSessionToken('legacy-session-token', legacyEnvKey!)
    const keytar = await import('keytar')
    const legacyAccount = `session-token::${legacyEnvKey}`
    expect(keychain.has(keyOf('Evenfire', legacyAccount))).toBe(true)
    const originalDelete = vi.mocked(keytar.deletePassword).getMockImplementation()!
    vi.mocked(keytar.deletePassword).mockImplementation(async (service, account) => {
      if (account === legacyAccount) throw new Error('legacy keychain slot locked')
      return originalDelete(service, account)
    })
    const persistToken = vi.spyOn(tokenStore, 'setSessionToken')

    try {
      await expect(internals(service).installAuthenticatedLoginOnce(loginResult)).resolves.toEqual({
        authenticated: true,
        me: loginResult.me,
      })

      expect(persistToken).toHaveBeenCalledWith(
        loginResult.token,
        activeEnvKey,
        expect.objectContaining({
          requireKeytar: true,
          mayWrite: expect.any(Function),
        })
      )
      expect(markerStore.hasPendingExternalLogout(userDataDirectory, activeEnvKey)).toBe(true)
      expect(keychain.get(keyOf('Evenfire', legacyAccount))).toBe('legacy-session-token')
    } finally {
      vi.mocked(keytar.deletePassword).mockReset().mockImplementation(originalDelete)
    }
  })

  it('allows encrypted file-backed login when the whole Keytar store fails and retains the marker', async () => {
    markerStore.recordPendingExternalLogout(userDataDirectory, activeEnvKey)
    const { service, tokenStore } = createService()
    const authClient = (
      service as unknown as {
        authClient: { getMe: (token: string) => Promise<typeof loginResult.me> }
      }
    ).authClient
    vi.spyOn(authClient, 'getMe').mockResolvedValue(loginResult.me)
    await tokenStore.setSessionToken('previous-session-token', activeEnvKey)
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
    const keytar = await import('keytar')
    const originalGet = vi.mocked(keytar.getPassword).getMockImplementation()!
    const originalSet = vi.mocked(keytar.setPassword).getMockImplementation()!
    const originalDelete = vi.mocked(keytar.deletePassword).getMockImplementation()!
    const unavailable = async () => {
      throw new Error('keychain temporarily locked')
    }
    vi.mocked(keytar.getPassword).mockImplementation(unavailable)
    vi.mocked(keytar.setPassword).mockImplementation(unavailable)
    vi.mocked(keytar.deletePassword).mockImplementation(unavailable)

    try {
      await expect(internals(service).installAuthenticatedLoginOnce(loginResult)).resolves.toEqual({
        authenticated: true,
        me: loginResult.me,
      })

      expect(markerStore.hasPendingExternalLogout(userDataDirectory, activeEnvKey)).toBe(true)
      expect(keychain.get(keyOf('Evenfire', `session-token::${activeEnvKey}`))).toBe(
        'previous-session-token'
      )
      expect(internals(service).sessionToken).toBe(loginResult.token)
      await expect(tokenStore.getSessionToken(activeEnvKey)).resolves.toBe(loginResult.token)
      expect(await fs.readdir(userDataDirectory)).toContain(`session-token-${activeEnvKey}.enc`)
      expect(await fs.readdir(userDataDirectory)).not.toContain(
        `session-token-${activeEnvKey}.json`
      )
      await expect(service.initialize()).resolves.toEqual({
        authenticated: true,
        me: loginResult.me,
      })
      expect(markerStore.hasPendingExternalLogout(userDataDirectory, activeEnvKey)).toBe(true)
    } finally {
      vi.mocked(keytar.getPassword).mockReset().mockImplementation(originalGet)
      vi.mocked(keytar.setPassword).mockReset().mockImplementation(originalSet)
      vi.mocked(keytar.deletePassword).mockReset().mockImplementation(originalDelete)
    }
  })

  it('uses a temporary session without Keytar or safeStorage and writes no plaintext fallback', async () => {
    markerStore.recordPendingExternalLogout(userDataDirectory, activeEnvKey)
    const { service } = createService()
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    const keytar = await import('keytar')
    const originalGet = vi.mocked(keytar.getPassword).getMockImplementation()!
    const originalSet = vi.mocked(keytar.setPassword).getMockImplementation()!
    const originalDelete = vi.mocked(keytar.deletePassword).getMockImplementation()!
    const unavailable = async () => {
      throw new Error('keychain temporarily locked')
    }
    vi.mocked(keytar.getPassword).mockImplementation(unavailable)
    vi.mocked(keytar.setPassword).mockImplementation(unavailable)
    vi.mocked(keytar.deletePassword).mockImplementation(unavailable)

    try {
      await expect(
        internals(service).installAuthenticatedLoginOnce(loginResult)
      ).resolves.toMatchObject({
        authenticated: true,
        me: loginResult.me,
        sessionMode: 'temporary',
      })

      expect(
        markerStore.readPendingExternalLogoutIntent(userDataDirectory, activeEnvKey)
      ).toMatchObject({ intent: 'memory-only-session' })
      expect(internals(service).sessionToken).toBe(loginResult.token)
      expect(internals(service).me).toEqual(loginResult.me)
      expect(await fs.readdir(userDataDirectory)).not.toContain(
        `session-token-${activeEnvKey}.json`
      )
    } finally {
      vi.mocked(keytar.getPassword).mockReset().mockImplementation(originalGet)
      vi.mocked(keytar.setPassword).mockReset().mockImplementation(originalSet)
      vi.mocked(keytar.deletePassword).mockReset().mockImplementation(originalDelete)
    }
  })

  it('keeps the pending logout fence and admits memory auth after secure write failures', async () => {
    markerStore.recordPendingExternalLogout(userDataDirectory, activeEnvKey)
    const reportFailure = vi.fn()
    const { service, tokenStore } = createService(undefined, reportFailure)
    await tokenStore.setSessionToken('previous-session-token', activeEnvKey)
    vi.spyOn(tokenStore, 'setSessionToken').mockRejectedValue(new Error('Keytar write failed'))
    vi.spyOn(tokenStore, 'setSafeStorageSessionToken').mockRejectedValue(
      new Error('credential write failed')
    )

    await expect(
      internals(service).installAuthenticatedLoginOnce(loginResult)
    ).resolves.toMatchObject({
      authenticated: true,
      me: loginResult.me,
      sessionMode: 'temporary',
    })

    expect(
      markerStore.readPendingExternalLogoutIntent(userDataDirectory, activeEnvKey)
    ).toMatchObject({ intent: 'memory-only-session' })
    expect(internals(service).sessionToken).toBe(loginResult.token)
    expect(internals(service).me).toEqual(loginResult.me)
    expect(
      reportFailure.mock.calls.map(([error]) =>
        error instanceof Error ? error.message : typeof error
      )
    ).toEqual(['Secure session persistence unavailable; admitted temporary session'])
  })

  it('rejects temporary admission when the durable authority marker cannot be replaced', async () => {
    markerStore.recordPendingExternalLogout(userDataDirectory, activeEnvKey)
    const { service, tokenStore } = createService()
    await tokenStore.setSessionToken('previous-session-token', activeEnvKey)
    const keytar = await import('keytar')
    const originalSet = vi.mocked(keytar.setPassword).getMockImplementation()!
    vi.mocked(keytar.setPassword).mockRejectedValue(new Error('keychain unavailable'))
    const originalRename = fsSync.renameSync.bind(fsSync)
    const rename = vi.spyOn(fsSync, 'renameSync').mockImplementation((source, destination) => {
      if (String(destination) === markerPath()) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      }
      return originalRename(source, destination)
    })

    try {
      await expect(internals(service).installAuthenticatedLoginOnce(loginResult)).rejects.toThrow(
        'permission denied'
      )

      expect(internals(service).gfsDispatchBlocked).toBe(true)
      expect(internals(service).sessionToken).toBeNull()
      expect(internals(service).me).toBeNull()
      expect(markerStore.readPendingExternalLogoutIntent(userDataDirectory, activeEnvKey)).toEqual({
        intent: 'logout-pending',
      })
      expect(await fs.readdir(userDataDirectory)).not.toContain(
        `session-token-${activeEnvKey}.json`
      )
    } finally {
      rename.mockRestore()
      vi.mocked(keytar.setPassword).mockReset().mockImplementation(originalSet)
    }
  })

  it('does not authenticate when the memory-only marker directory sync fails', async () => {
    markerStore.recordPendingExternalLogout(userDataDirectory, activeEnvKey)
    const { service, tokenStore } = createService()
    await tokenStore.setSessionToken('previous-session-token', activeEnvKey)
    const keytar = await import('keytar')
    const originalSet = vi.mocked(keytar.setPassword).getMockImplementation()!
    vi.mocked(keytar.setPassword).mockRejectedValue(new Error('keychain unavailable'))
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    const originalFsync = fsSync.fsyncSync.bind(fsSync)
    let failedDirectorySync = false
    let memoryMarkerRenamed = false
    const originalRename = fsSync.renameSync.bind(fsSync)
    const rename = vi.spyOn(fsSync, 'renameSync').mockImplementation((source, destination) => {
      const result = originalRename(source, destination)
      if (String(destination) === markerPath()) memoryMarkerRenamed = true
      return result
    })
    const fsync = vi.spyOn(fsSync, 'fsyncSync').mockImplementation(descriptor => {
      if (
        memoryMarkerRenamed &&
        !failedDirectorySync &&
        fsSync.fstatSync(descriptor).isDirectory()
      ) {
        failedDirectorySync = true
        throw Object.assign(new Error('directory sync failed'), { code: 'EIO' })
      }
      return originalFsync(descriptor)
    })

    try {
      await expect(internals(service).installAuthenticatedLoginOnce(loginResult)).rejects.toThrow(
        'directory sync failed'
      )

      expect(failedDirectorySync).toBe(true)
      expect(internals(service).sessionToken).toBeNull()
      expect(internals(service).me).toBeNull()
      expect(
        markerStore.readPendingExternalLogoutIntent(userDataDirectory, activeEnvKey)
      ).not.toBeNull()
    } finally {
      fsync.mockRestore()
      rename.mockRestore()
      vi.mocked(keytar.setPassword).mockReset().mockImplementation(originalSet)
    }
  })

  it('keeps the marker and removes the fresh credential when chat binding fails', async () => {
    markerStore.recordPendingExternalLogout(userDataDirectory, activeEnvKey)
    const { service, tokenStore } = createService()
    await tokenStore.setSessionToken('previous-session-token', activeEnvKey)
    vi.mocked(bindChatStoreForUser).mockRejectedValueOnce(new Error('chat binding failed'))

    await expect(internals(service).installAuthenticatedLoginOnce(loginResult)).rejects.toThrow(
      'chat binding failed'
    )

    expect(markerStore.hasPendingExternalLogout(userDataDirectory, activeEnvKey)).toBe(true)
    expect(internals(service).sessionToken).toBeNull()
    expect(internals(service).me).toBeNull()
    await expect(tokenStore.getSessionToken(activeEnvKey)).resolves.toBeNull()
  })

  it('records a UI logout rejected by quit admission through the shared AppService path', async () => {
    const { service, tokenStore } = createService()
    internals(service).quitPreparationStarted = true
    const clearToken = vi.spyOn(tokenStore, 'clearSessionToken')
    const logoutError = await service.logout().catch(error => error)

    expect(logoutError).toBeInstanceOf(QuitAdmissionClosedErrorClass)
    expect(quitLifecycle.isQuitAdmissionClosedError(logoutError)).toBe(true)
    expect(markerStore.hasPendingExternalLogout(userDataDirectory, activeEnvKey)).toBe(true)
    expect(clearToken).not.toHaveBeenCalled()
  })

  it('surfaces marker-write failure without claiming a quit-time logout succeeded', async () => {
    const { service, tokenStore } = createService()
    const state = internals(service)
    state.sessionToken = 'fixture-active-session-token'
    state.me = loginResult.me
    state.quitPreparationStarted = true
    const originalOpen = fsSync.openSync.bind(fsSync)
    const open = vi.spyOn(fsSync, 'openSync').mockImplementation((...args) => {
      if (String(args[0]).startsWith(`${markerPath()}.`)) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      }
      return originalOpen(...args)
    })
    const clearToken = vi.spyOn(tokenStore, 'clearSessionTokenStrictly')

    try {
      await expect(service.logout()).rejects.toMatchObject({ code: 'EACCES' })

      expect(state.sessionToken).toBe('fixture-active-session-token')
      expect(state.me).toEqual(loginResult.me)
      expect(clearToken).not.toHaveBeenCalled()
      expect(notifySessionChanged).not.toHaveBeenCalledWith(false)
      expect(markerStore.hasPendingExternalLogout(userDataDirectory, activeEnvKey)).toBe(false)
    } finally {
      open.mockRestore()
    }
  })

  it('keeps logout durable when GFS fencing fails before token cleanup', async () => {
    const reportFailure = vi.fn()
    const { service, tokenStore } = createService(undefined, reportFailure)
    const state = service as unknown as {
      sessionToken: string | null
      me: unknown
      suspendDesktopGfsUploadsForAuthBoundary: () => Promise<void>
    }
    const staleToken = 'fixture-stale-gfs-fence-token'
    await tokenStore.setSessionToken(staleToken, activeEnvKey)
    state.sessionToken = staleToken
    state.me = loginResult.me
    const clearToken = vi.spyOn(tokenStore, 'clearSessionToken')
    vi.spyOn(state, 'suspendDesktopGfsUploadsForAuthBoundary').mockRejectedValue(
      new Error('Application is shutting down')
    )

    await expect(service.logout()).resolves.toBeTypeOf('number')

    expect(clearToken).not.toHaveBeenCalled()
    expect(state.sessionToken).toBeNull()
    expect(state.me).toBeNull()
    expect(notifySessionChanged).toHaveBeenCalledWith(false)
    expect(reportFailure).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Application is shutting down' })
    )
    expect(markerStore.readPendingExternalLogoutIntent(userDataDirectory, activeEnvKey)).toEqual({
      intent: 'logout-pending',
    })

    const { service: restarted } = createService(new TokenStoreClass())
    const restartedAuthClient = (
      restarted as unknown as { authClient: { getMe: ReturnType<typeof vi.fn> } }
    ).authClient
    const getMe = vi.spyOn(restartedAuthClient, 'getMe')
    await expect(restarted.initialize()).resolves.toEqual({ authenticated: false, me: null })

    expect(getMe).not.toHaveBeenCalled()
    expect(markerStore.hasPendingExternalLogout(userDataDirectory, activeEnvKey)).toBe(false)
    await expect(tokenStore.getSessionToken(activeEnvKey)).resolves.toBeNull()
  })

  it('does not let environment B consume environment A logout intent', async () => {
    const envA = activeEnvKey === 'env_a-000000000000' ? 'env_b-111111111111' : 'env_a-000000000000'
    markerStore.recordPendingExternalLogout(userDataDirectory, envA)
    const { service, tokenStore } = createService()
    await tokenStore.setSessionToken('environment-b-token', activeEnvKey)
    const authClient = service as unknown as {
      authClient: { getMe: (token: string) => Promise<typeof loginResult.me> }
    }
    vi.spyOn(authClient.authClient, 'getMe').mockResolvedValue(loginResult.me)

    await expect(service.initialize()).resolves.toEqual({
      authenticated: true,
      me: loginResult.me,
    })

    expect(markerStore.hasPendingExternalLogout(userDataDirectory, envA)).toBe(true)
    expect(markerStore.hasPendingExternalLogout(userDataDirectory, activeEnvKey)).toBe(false)
    await expect(tokenStore.getSessionToken(activeEnvKey)).resolves.toBe('environment-b-token')
    expect(internals(service).sessionToken).toBe('environment-b-token')
  })
})
