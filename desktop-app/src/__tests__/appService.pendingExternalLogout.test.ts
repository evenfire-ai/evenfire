import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import fsSync from 'node:fs'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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
  tryGetPluginSdkRuntime: () => ({ notifySessionChanged }),
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => userDataDirectory),
    isReady: vi.fn(() => true),
  },
  safeStorage: { isEncryptionAvailable: vi.fn(() => false) },
}))

beforeEach(async () => {
  notifySessionChanged.mockClear()
  userDataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-app-pending-logout-'))
  keychain.clear()
  vi.resetModules()
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
    const clearToken = vi.spyOn(tokenStore, 'clearSessionToken')

    await expect(service.initialize()).resolves.toEqual({ authenticated: false, me: null })

    expect(clearToken).toHaveBeenCalledWith(
      activeEnvKey,
      expect.objectContaining({ throwOnStorageError: true })
    )
    expect(suspendUploads).toHaveBeenCalledOnce()
    expect(notifySessionChanged).toHaveBeenCalledWith(false)
    expect(restore).not.toHaveBeenCalled()
    expect(markerStore.hasPendingExternalLogout(userDataDirectory, activeEnvKey)).toBe(false)
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
    const clearToken = vi.spyOn(tokenStore, 'clearSessionToken')
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

    expect(markerStore.hasPendingExternalLogout(userDataDirectory, activeEnvKey)).toBe(true)
    await expect(tokenStore.getSessionToken(activeEnvKey)).resolves.toBe('persisted-session-token')
  })

  it('applies the marker after quit cancellation reopens both admission gates', async () => {
    const { service, tokenStore } = createService()
    await tokenStore.setSessionToken('persisted-session-token', activeEnvKey)
    markerStore.recordPendingExternalLogout(userDataDirectory, activeEnvKey)
    internals(service).quitPreparationStarted = true
    await tokenStore.prepareForQuit()
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
    expect(keytar.deletePassword).toHaveBeenCalledWith('Evenfire', `session-token::${activeEnvKey}`)
    expect(keytar.deletePassword.mock.invocationCallOrder.at(-1)).toBeLessThan(
      keytar.setPassword.mock.invocationCallOrder.at(-1)!
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

  it('does not replace a credential when a legacy Keytar delete also fails', async () => {
    markerStore.recordPendingExternalLogout(userDataDirectory, activeEnvKey)
    const { service, tokenStore } = createService()
    await tokenStore.setSessionToken('previous-session-token', activeEnvKey)
    const persistToken = vi.spyOn(tokenStore, 'setSessionToken')
    const keytar = await import('keytar')
    const originalDelete = vi.mocked(keytar.deletePassword).getMockImplementation()!
    vi.mocked(keytar.deletePassword).mockImplementation(async () => {
      throw new Error('keychain temporarily locked')
    })

    try {
      await expect(
        internals(service).installAuthenticatedLoginOnce(loginResult)
      ).rejects.toMatchObject({ message: 'Failed to clear session token storage' })

      expect(persistToken).not.toHaveBeenCalled()
      expect(markerStore.hasPendingExternalLogout(userDataDirectory, activeEnvKey)).toBe(true)
      expect(keychain.get(keyOf('Evenfire', `session-token::${activeEnvKey}`))).toBe(
        'previous-session-token'
      )
      expect(internals(service).sessionToken).toBeNull()
      expect(internals(service).me).toBeNull()
    } finally {
      vi.mocked(keytar.deletePassword).mockReset().mockImplementation(originalDelete)
    }
  })

  it('keeps a pending logout marker and stays unauthenticated when fresh persistence fails', async () => {
    markerStore.recordPendingExternalLogout(userDataDirectory, activeEnvKey)
    const reportFailure = vi.fn()
    const { service, tokenStore } = createService(undefined, reportFailure)
    await tokenStore.setSessionToken('previous-session-token', activeEnvKey)
    vi.spyOn(tokenStore, 'setSessionToken').mockRejectedValue(new Error('credential write failed'))

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
