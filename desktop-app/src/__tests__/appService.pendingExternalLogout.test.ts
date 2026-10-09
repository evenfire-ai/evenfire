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
    runCredentialProducer: (operation: () => Promise<unknown>) => Promise<unknown>
    gfsDispatchBlocked: boolean
    quitPreparationStarted: boolean
    sessionToken: string | null
    me: unknown
  }
}

function markerPath(envKey = activeEnvKey): string {
  const environmentId = createHash('sha256').update(envKey).digest('hex')
  return path.join(userDataDirectory, `pending-external-logout-${environmentId}`)
}

const loginResult = {
  token: 'fixture-session-token',
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
    state.sessionToken = 'active-session-token'
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
    state.sessionToken = 'active-session-token'
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
    state.sessionToken = 'active-session-token'
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
    state.sessionToken = 'active-session-token'
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
    const { service } = createService()
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
      JSON.stringify({ token: 'stale-plaintext-session-token' })
    )
    await fs.writeFile(path.join(userDataDirectory, `session-token-${activeEnvKey}.enc`), 'corrupt')

    await expect(service.initialize()).resolves.toEqual({ authenticated: false, me: null })

    expect(markerStore.readPendingExternalLogoutIntent(userDataDirectory, activeEnvKey)).toEqual({
      intent: 'keytar-cleanup-pending',
      credentialSource: 'safe-storage',
    })
    expect(authClient.getMe).not.toHaveBeenCalled()
    await expect(tokenStore.getSessionToken(activeEnvKey)).resolves.toBe(
      'stale-plaintext-session-token'
    )
  })

  it('clears the prior logout intent before persisting an explicit login', async () => {
    markerStore.recordPendingExternalLogout(userDataDirectory, activeEnvKey)
    const { service, tokenStore } = createService()
    await tokenStore.setSessionToken('previous-session-token', activeEnvKey)

    await expect(internals(service).installAuthenticatedLoginOnce(loginResult)).resolves.toEqual({
      authenticated: true,
      me: loginResult.me,
    })

    expect(markerStore.hasPendingExternalLogout(userDataDirectory, activeEnvKey)).toBe(false)
    await expect(tokenStore.getSessionToken(activeEnvKey)).resolves.toBe(loginResult.token)
    const keytar = await import('keytar')
    const account = `session-token::${activeEnvKey}`
    const oldCredentialDeleteIndex = keytar.deletePassword.mock.calls.findIndex(
      ([service, deletedAccount]) => service === 'Evenfire' && deletedAccount === account
    )
    const freshCredentialWriteIndex = keytar.setPassword.mock.calls.findIndex(
      ([service, writtenAccount, token]) =>
        service === 'Evenfire' && writtenAccount === account && token === loginResult.token
    )
    expect(oldCredentialDeleteIndex).toBeGreaterThanOrEqual(0)
    expect(freshCredentialWriteIndex).toBeGreaterThanOrEqual(0)
    expect(keytar.deletePassword.mock.invocationCallOrder[oldCredentialDeleteIndex]).toBeLessThan(
      keytar.setPassword.mock.invocationCallOrder[freshCredentialWriteIndex]
    )
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
    expect(markerStore.hasPendingExternalLogout(userDataDirectory, activeEnvKey)).toBe(false)
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
    vi.mocked(keytar.getPassword).mockRejectedValue(new Error('keychain unavailable'))
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

  it('rejects file fallback when the old active Keytar credential remains readable', async () => {
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
      await expect(internals(service).installAuthenticatedLoginOnce(loginResult)).rejects.toThrow(
        'Fresh session token could not be verified after storage fallback'
      )

      expect(markerStore.hasPendingExternalLogout(userDataDirectory, activeEnvKey)).toBe(true)
      expect(internals(service).sessionToken).toBeNull()
      await expect(tokenStore.getSessionToken(activeEnvKey)).resolves.toBe('previous-session-token')
    } finally {
      vi.mocked(keytar.setPassword).mockReset().mockImplementation(originalSet)
      vi.mocked(keytar.deletePassword).mockReset().mockImplementation(originalDelete)
    }
  })

  it('fails closed when Keytar and fallback-file cleanup both fail', async () => {
    markerStore.recordPendingExternalLogout(userDataDirectory, activeEnvKey)
    const reportFailure = vi.fn()
    const { service, tokenStore } = createService(undefined, reportFailure)
    await tokenStore.setSessionToken('previous-session-token', activeEnvKey)
    const keytar = await import('keytar')
    const account = `session-token::${activeEnvKey}`
    const originalDelete = vi.mocked(keytar.deletePassword).getMockImplementation()!
    vi.mocked(keytar.deletePassword).mockImplementation(async (_service, deletedAccount) => {
      if (deletedAccount === account) throw new Error('keychain temporarily locked')
      return false
    })
    const fallbackPath = path.join(userDataDirectory, `session-token-${activeEnvKey}.json`)
    const originalUnlink = fs.unlink.bind(fs)
    const unlink = vi.spyOn(fs, 'unlink').mockImplementation(async filePath => {
      if (String(filePath) === fallbackPath) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      }
      return originalUnlink(filePath)
    })
    const persistToken = vi.spyOn(tokenStore, 'setSessionToken')

    try {
      await expect(
        internals(service).installAuthenticatedLoginOnce(loginResult)
      ).rejects.toMatchObject({
        message: 'Failed to clear session token storage',
      })

      expect(persistToken).not.toHaveBeenCalled()
      expect(reportFailure).toHaveBeenCalledOnce()
      expect(markerStore.hasPendingExternalLogout(userDataDirectory, activeEnvKey)).toBe(true)
      await expect(tokenStore.getSessionToken(activeEnvKey)).resolves.toBe('previous-session-token')
    } finally {
      unlink.mockRestore()
      vi.mocked(keytar.deletePassword).mockReset().mockImplementation(originalDelete)
    }
  })

  it('reports the fallback write failure once when required Keytar replacement also fails', async () => {
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
      await expect(internals(service).installAuthenticatedLoginOnce(loginResult)).rejects.toThrow(
        'file fallback failed'
      )

      expect(reportFailure).toHaveBeenCalledOnce()
      expect(reportFailure).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'file fallback failed' })
      )
      expect(markerStore.hasPendingExternalLogout(userDataDirectory, activeEnvKey)).toBe(true)
      expect(internals(service).sessionToken).toBeNull()
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

      expect(persistToken).toHaveBeenCalledWith(loginResult.token, activeEnvKey, {
        requireKeytar: true,
      })
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

  it('fails closed without Keytar or safeStorage instead of writing a plaintext fallback', async () => {
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
      await expect(internals(service).installAuthenticatedLoginOnce(loginResult)).rejects.toThrow(
        'Electron safeStorage is unavailable for session-token fallback'
      )

      expect(markerStore.hasPendingExternalLogout(userDataDirectory, activeEnvKey)).toBe(true)
      expect(internals(service).sessionToken).toBeNull()
      expect(internals(service).me).toBeNull()
      expect(await fs.readdir(userDataDirectory)).not.toContain(
        `session-token-${activeEnvKey}.json`
      )
    } finally {
      vi.mocked(keytar.getPassword).mockReset().mockImplementation(originalGet)
      vi.mocked(keytar.setPassword).mockReset().mockImplementation(originalSet)
      vi.mocked(keytar.deletePassword).mockReset().mockImplementation(originalDelete)
    }
  })

  it('keeps a pending logout marker and stays unauthenticated when fresh persistence fails', async () => {
    markerStore.recordPendingExternalLogout(userDataDirectory, activeEnvKey)
    const reportFailure = vi.fn()
    const { service, tokenStore } = createService(undefined, reportFailure)
    await tokenStore.setSessionToken('previous-session-token', activeEnvKey)
    vi.spyOn(tokenStore, 'setSessionToken').mockRejectedValue(new Error('Keytar write failed'))
    vi.spyOn(tokenStore, 'setSafeStorageSessionToken').mockRejectedValue(
      new Error('credential write failed')
    )

    await expect(internals(service).installAuthenticatedLoginOnce(loginResult)).rejects.toThrow(
      'credential write failed'
    )

    expect(markerStore.hasPendingExternalLogout(userDataDirectory, activeEnvKey)).toBe(true)
    expect(internals(service).sessionToken).toBeNull()
    expect(internals(service).me).toBeNull()
    expect(reportFailure).toHaveBeenCalledOnce()
  })

  it('keeps login unauthenticated and the marker when marker retirement fails', async () => {
    markerStore.recordPendingExternalLogout(userDataDirectory, activeEnvKey)
    const reportFailure = vi.fn()
    const { service, tokenStore } = createService(undefined, reportFailure)
    await tokenStore.setSessionToken('previous-session-token', activeEnvKey)
    const originalUnlink = fsSync.unlinkSync.bind(fsSync)
    const unlink = vi.spyOn(fsSync, 'unlinkSync').mockImplementation(filePath => {
      if (String(filePath) === markerPath()) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      }
      return originalUnlink(filePath)
    })

    try {
      await expect(internals(service).installAuthenticatedLoginOnce(loginResult)).rejects.toThrow(
        'permission denied'
      )

      expect(reportFailure).toHaveBeenCalledOnce()
      expect(internals(service).gfsDispatchBlocked).toBe(true)
      expect(internals(service).sessionToken).toBeNull()
      expect(internals(service).me).toBeNull()
      expect(markerStore.hasPendingExternalLogout(userDataDirectory, activeEnvKey)).toBe(true)
      await expect(tokenStore.getSessionToken(activeEnvKey)).resolves.toBeNull()
    } finally {
      unlink.mockRestore()
    }
  })

  it('rewrites logout intent when marker unlink succeeds but directory sync fails', async () => {
    markerStore.recordPendingExternalLogout(userDataDirectory, activeEnvKey)
    const { service, tokenStore } = createService()
    const originalFsync = fsSync.fsyncSync.bind(fsSync)
    let failedDirectorySync = false
    const fsync = vi.spyOn(fsSync, 'fsyncSync').mockImplementation(descriptor => {
      if (!failedDirectorySync && fsSync.fstatSync(descriptor).isDirectory()) {
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
      expect(markerStore.readPendingExternalLogoutIntent(userDataDirectory, activeEnvKey)).toEqual({
        intent: 'logout-pending',
      })
      expect(internals(service).sessionToken).toBeNull()
      await expect(tokenStore.getSessionToken(activeEnvKey)).resolves.toBeNull()
    } finally {
      fsync.mockRestore()
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
    state.sessionToken = 'active-session-token'
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

      expect(state.sessionToken).toBe('active-session-token')
      expect(state.me).toEqual(loginResult.me)
      expect(clearToken).not.toHaveBeenCalled()
      expect(notifySessionChanged).not.toHaveBeenCalledWith(false)
      expect(markerStore.hasPendingExternalLogout(userDataDirectory, activeEnvKey)).toBe(false)
    } finally {
      open.mockRestore()
    }
  })

  it('does not record a marker for an unrelated shutdown-shaped producer error', async () => {
    const { service } = createService()
    const state = service as unknown as {
      sessionToken: string | null
      me: unknown
      suspendDesktopGfsUploadsForAuthBoundary: () => Promise<void>
    }
    state.sessionToken = 'active-session-token'
    state.me = loginResult.me
    vi.spyOn(state, 'suspendDesktopGfsUploadsForAuthBoundary').mockRejectedValue(
      new Error('Application is shutting down')
    )

    await expect(service.logout()).rejects.toThrow('Application is shutting down')

    expect(markerStore.hasPendingExternalLogout(userDataDirectory, activeEnvKey)).toBe(false)
    expect(state.sessionToken).toBe('active-session-token')
    expect(state.me).toEqual(loginResult.me)
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
