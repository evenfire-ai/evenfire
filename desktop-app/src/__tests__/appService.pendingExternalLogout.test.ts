import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import fsSync from 'node:fs'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { prepareChatStoreBindingForUser, requireChatStore } from '../chatStoreBinding.js'

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

vi.mock('../chatStoreBinding.js', async () => {
  const { createChatStoreBindingMock } = await import('../../testSupport/chatStoreBindingMock.js')
  return createChatStoreBindingMock()
})

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
  const authClient = (
    service as unknown as {
      authClient: {
        getMe: (token: string) => Promise<typeof loginResult.me>
        passwordLogin: (email: string, password: string) => Promise<typeof loginResult>
      }
    }
  ).authClient
  vi.spyOn(authClient, 'getMe').mockImplementation(async token => {
    if (token !== loginResult.token)
      throw new Error('The pending-logout fixture has no identity for this token')
    return loginResult.me
  })
  vi.spyOn(authClient, 'passwordLogin').mockResolvedValue(loginResult)
  return { reportFailure, service, tokenStore }
}

async function acceptPersistentSession(service: InstanceType<typeof AppServiceClass>) {
  const config = await import('../config.js')
  if (!config.isDesktopRuntimeConfigured()) {
    await config.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: 'https://auth.example.test/api',
      rpcProxyBaseUrl: 'https://rpc.example.test',
      appName: 'Evenfire Test',
    })
  }
  activeEnvKey = config.getActiveEnvKey()
  return service.passwordLogin(loginResult.me.email, 'synthetic-password')
}

async function makeKeytarCapabilityUnavailable(code = 'EACCES'): Promise<() => void> {
  const keytar = await import('keytar')
  const getPassword = vi.mocked(keytar.getPassword)
  const original = getPassword.getMockImplementation()
  if (!original) throw new Error('Expected the Keytar fixture to expose its read producer')
  getPassword.mockImplementation(async (service, account) => {
    if (account.startsWith('session-v1-capability-probe:')) {
      throw Object.assign(new Error('fixture secure credential provider is unavailable'), { code })
    }
    return original(service, account)
  })
  return () => getPassword.mockReset().mockImplementation(original)
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
    tokenStore: InstanceType<typeof TokenStoreClass>
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

async function expectAcceptedProjection(
  tokenStore: InstanceType<typeof TokenStoreClass>,
  expectedMode?: 'persistent' | 'memory-only'
): Promise<void> {
  const { SessionAuthorityRecordRepository } = await import('../sessionAuthorityRecord.js')
  const scope = await tokenStore.createSessionAuthorityStorageScope()
  const observed = new SessionAuthorityRecordRepository(scope, activeEnvKey, tokenStore).observe()
  expect(observed.status).toBe('observed')
  if (observed.status !== 'observed') throw new Error('Expected durable authority after acceptance')
  if (expectedMode) expect(observed.record.frame.mode).toBe(expectedMode)
  const receipt = observed.record.projectionReceipt
  expect(receipt).not.toBeNull()
  if (!receipt) throw new Error('Accepted candidate has no projection receipt')
  const marker = markerStore.observePendingExternalLogoutRaw(userDataDirectory, activeEnvKey)
  expect(marker.marker?.intent.intent).toBe('acceptance-pending')
  expect(marker.rawContents).toBe(JSON.stringify(receipt.marker))
  expect(marker.rawDigest).toBe(
    createHash('sha256').update(JSON.stringify(receipt.marker)).digest('hex')
  )
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
  it('fences the matching environment before restore without reading its saved source', async () => {
    markerStore.recordPendingExternalLogout(userDataDirectory, activeEnvKey)
    const { service, tokenStore } = createService()
    await tokenStore.setSessionToken('persisted-session-token', activeEnvKey)
    const authClient = (service as unknown as { authClient: { getMe: ReturnType<typeof vi.fn> } })
      .authClient
    const getMe = vi.spyOn(authClient, 'getMe')
    const restore = vi.spyOn(internals(service), 'restoreSavedSessionOnce')
    const clearToken = vi.spyOn(tokenStore, 'clearSessionTokenStrictly')

    await expect(service.initialize()).resolves.toEqual({ authenticated: false, me: null })

    expect(clearToken).not.toHaveBeenCalled()
    expect(getMe).not.toHaveBeenCalled()
    expect(restore).not.toHaveBeenCalled()
    expect(markerStore.readPendingExternalLogoutIntent(userDataDirectory, activeEnvKey)).toEqual({
      intent: 'logout-pending',
    })
    const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
    expect(await readSessionAuthoritySourceSelection({ tokenStore, envKey: activeEnvKey })).toEqual(
      { status: 'denied', frameMode: 'logged-out' }
    )
    expect(keychain.get(keyOf('Evenfire', `session-token::${activeEnvKey}`))).toBe(
      'persisted-session-token'
    )
  })

  it('keeps startup unauthenticated when strict marker cleanup fails', async () => {
    markerStore.recordPendingExternalLogout(userDataDirectory, activeEnvKey)
    const reportFailure = vi.fn()
    const { service, tokenStore } = createService(undefined, reportFailure)
    await tokenStore.setSessionToken('persisted-session-token', activeEnvKey)
    const keytar = await import('keytar')
    const deletePassword = vi.mocked(keytar.deletePassword)
    const restore = vi.spyOn(internals(service), 'restoreSavedSessionOnce')

    await expect(service.initialize()).resolves.toEqual({ authenticated: false, me: null })

    expect(restore).not.toHaveBeenCalled()
    expect(notifySessionChanged).not.toHaveBeenCalledWith(true)
    expect(markerStore.readPendingExternalLogoutIntent(userDataDirectory, activeEnvKey)).toEqual({
      intent: 'logout-pending',
    })
    expect(reportFailure).not.toHaveBeenCalled()
    expect(deletePassword).not.toHaveBeenCalled()
    expect(keychain.get(keyOf('Evenfire', `session-token::${activeEnvKey}`))).toBe(
      'persisted-session-token'
    )
    const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
    expect(await readSessionAuthoritySourceSelection({ tokenStore, envKey: activeEnvKey })).toEqual(
      { status: 'denied', frameMode: 'logged-out' }
    )
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

  it('revokes an authenticated owner when logout cannot inspect its authority marker', async () => {
    const config = await import('../config.js')
    await config.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: 'https://auth.example.test/api',
      rpcProxyBaseUrl: 'https://rpc.example.test',
      appName: 'Evenfire Test',
    })
    activeEnvKey = config.getActiveEnvKey()
    const { service } = createService()
    const authClient = (
      service as unknown as {
        authClient: {
          passwordLogin: (email: string, password: string) => Promise<typeof loginResult>
          getMe: (token: string) => Promise<typeof loginResult.me>
        }
      }
    ).authClient
    vi.spyOn(authClient, 'passwordLogin').mockResolvedValue(loginResult)

    await expect(
      service.passwordLogin(loginResult.me.email, 'fixture-password')
    ).resolves.toMatchObject({
      authenticated: true,
      me: loginResult.me,
    })

    await fs.rm(markerPath())
    await fs.mkdir(markerPath())
    await expect(service.logout()).resolves.toMatchObject({
      kind: 'not-committed',
      reason: 'failed',
    })

    const state = internals(service)
    expect(state.sessionToken).toBeNull()
    expect(state.me).toBeNull()
    expect(notifySessionChanged).toHaveBeenCalledWith(false)

    const { service: restarted } = createService(new TokenStoreClass())
    const restartedAuthClient = (
      restarted as unknown as { authClient: { getMe: (token: string) => Promise<unknown> } }
    ).authClient
    const getMe = vi.spyOn(restartedAuthClient, 'getMe')
    await expect(restarted.initialize()).resolves.toEqual({ authenticated: false, me: null })
    expect(getMe).not.toHaveBeenCalled()
    expect((await fs.stat(markerPath())).isDirectory()).toBe(true)
  })

  it('refreshes the renderer after a canceled-quit retry fails closed', async () => {
    const config = await import('../config.js')
    await config.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: 'https://auth.example.test/api',
      rpcProxyBaseUrl: 'https://rpc.example.test',
      appName: 'Evenfire Test',
    })
    activeEnvKey = config.getActiveEnvKey()
    const { service } = createService()
    const authClient = (
      service as unknown as {
        authClient: {
          passwordLogin: (email: string, password: string) => Promise<typeof loginResult>
        }
      }
    ).authClient
    vi.spyOn(authClient, 'passwordLogin').mockResolvedValue(loginResult)

    await expect(
      service.passwordLogin(loginResult.me.email, 'fixture-password')
    ).resolves.toMatchObject({ authenticated: true, me: loginResult.me })

    await fs.rm(markerPath())
    await fs.mkdir(markerPath())
    await service.prepareForQuit()

    const webContents = { send: vi.fn() }
    const mainWindow = { isDestroyed: () => false, webContents }
    const reportFailure = vi.fn()
    const failureHandler = quitLifecycle.createDeferredExternalLogoutFailureHandler({
      getCachedUserId: () => service.getCachedUserId(),
      getWindow: () => mainWindow,
      reportFailure,
    })
    const applied = vi.fn()

    quitLifecycle.retryPendingExternalLogoutAfterQuitCancellation(
      () => service.cancelQuitPreparation(),
      () => service.applyPendingExternalLogoutIntent(),
      applied,
      failureHandler
    )

    await vi.waitFor(() => expect(reportFailure).toHaveBeenCalledOnce())
    expect(service.getCachedUserId()).toBeNull()
    expect(applied).not.toHaveBeenCalled()
    expect(reportFailure.mock.calls[0]?.[0]).toMatchObject({
      name: 'SessionAuthorityProjectionIntegrityError',
      source: 'marker',
      cause: { message: 'Pending logout marker is not a regular file' },
    })
    expect(webContents.send.mock.calls).toEqual([['auth:sessionStateChanged']])
    expect(webContents.send).not.toHaveBeenCalledWith('auth:externalLogout')
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

    await expect(service.initialize()).rejects.toBeInstanceOf(QuitAdmissionClosedErrorClass)
    await expect(service.applyPendingExternalLogoutIntent()).resolves.toBe(false)

    expect(clearToken).not.toHaveBeenCalled()
    expect(restore).not.toHaveBeenCalled()
    expect(markerStore.hasPendingExternalLogout(userDataDirectory, activeEnvKey)).toBe(true)
  })

  it('does not restore plaintext after safeStorage cleanup succeeds', async () => {
    markerStore.recordPendingExternalLogout(userDataDirectory, activeEnvKey)
    markerStore.recordPendingKeytarCleanup(userDataDirectory, activeEnvKey, 'safe-storage')
    const { service } = createService()
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
    const historicalPlaintextPath = path.join(
      userDataDirectory,
      `session-token-${activeEnvKey}.json`
    )
    await expect(fs.readFile(historicalPlaintextPath, 'utf8')).resolves.toBe(
      JSON.stringify({ token: 'fixture-stale-plaintext-session-token' })
    )
  })

  it('recovers an explicit login from a malformed marker after secure persistence', async () => {
    await fs.writeFile(markerPath(), '{not-json')
    const { service, tokenStore } = createService()
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)

    await expect(acceptPersistentSession(service)).resolves.toMatchObject({
      authenticated: true,
      me: loginResult.me,
    })

    await expectAcceptedProjection(tokenStore, 'persistent')
    expect(internals(service).sessionToken).toBe(loginResult.token)
    expect(await fs.readdir(userDataDirectory)).not.toContain(`session-token-${activeEnvKey}.json`)
    const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
    const selected = await readSessionAuthoritySourceSelection({
      tokenStore,
      envKey: activeEnvKey,
    })
    expect(selected.status).toBe('accepted')
    if (selected.status !== 'accepted') throw new Error('Expected accepted fresh-login source')
    expect(selected.session.token).toBe(loginResult.token)
    expect(selected.session.accepted.record.frame.source).toMatchObject({
      format: 'v1',
      kind: 'keytar',
      envKey: activeEnvKey,
    })
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

  it('retains the isolated-development memory-only authority after strict marker cleanup', async () => {
    markerStore.recordPendingExternalLogout(userDataDirectory, activeEnvKey)
    const isolatedStore = new TokenStoreClass({ isolatedUserDataPath: userDataDirectory })
    const { service } = createService(isolatedStore)

    await expect(
      internals(service).installAuthenticatedLoginOnce(loginResult)
    ).resolves.toMatchObject({
      authenticated: true,
      me: loginResult.me,
    })

    await expectAcceptedProjection(isolatedStore, 'memory-only')
    expect(internals(service).sessionToken).toBe(loginResult.token)
    expect(await fs.readdir(userDataDirectory)).not.toContain(`session-token-${activeEnvKey}.json`)
  })

  it('keeps a logout marker and clears the runtime session when strict logout cleanup fails', async () => {
    const reportFailure = vi.fn()
    markerStore.recordPendingKeytarCleanup(userDataDirectory, activeEnvKey, 'safe-storage')
    const { service, tokenStore } = createService(undefined, reportFailure)
    await acceptPersistentSession(service)
    const state = internals(service)
    const activeAccount = [...keychain.keys()]
      .map(key => key.slice(key.indexOf('::') + 2))
      .find(account => account.startsWith('session-v1:'))
    expect(activeAccount).toBeTruthy()
    const keytar = await import('keytar')
    const originalDelete = vi.mocked(keytar.deletePassword).getMockImplementation()!
    vi.mocked(keytar.deletePassword).mockImplementation(async (_service, account) => {
      if (account === activeAccount) {
        throw new Error('keychain temporarily locked')
      }
      return originalDelete(_service, account)
    })

    try {
      await expect(service.logout()).resolves.toMatchObject({ kind: 'committed' })

      expect(state.sessionToken).toBeNull()
      expect(state.me).toBeNull()
      expect(markerStore.readPendingExternalLogoutIntent(userDataDirectory, activeEnvKey)).toEqual({
        intent: 'logout-pending',
      })
      const { SessionAuthorityRecordRepository } = await import('../sessionAuthorityRecord.js')
      const scope = await tokenStore.createSessionAuthorityStorageScope()
      const authority = new SessionAuthorityRecordRepository(
        scope,
        activeEnvKey,
        tokenStore
      ).observe()
      expect(authority.status).toBe('observed')
      if (authority.status !== 'observed') throw new Error('Expected durable logout authority')
      expect(authority.record.frame.mode).toBe('logged-out')
      expect(authority.record.cleanupDebts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: expect.objectContaining({ kind: 'keytar' }) }),
        ])
      )
      await vi.waitFor(() => expect(reportFailure).toHaveBeenCalledOnce())
    } finally {
      vi.mocked(keytar.deletePassword).mockReset().mockImplementation(originalDelete)
    }
  })

  it('does not let an admitted login retire a newer quit-time logout marker', async () => {
    const config = await import('../config.js')
    await config.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: 'https://auth.example.test/api',
      rpcProxyBaseUrl: 'https://rpc.example.test',
      appName: 'Evenfire Test',
    })
    activeEnvKey = config.getActiveEnvKey()
    markerStore.recordPendingKeytarCleanup(userDataDirectory, activeEnvKey, 'active-keytar')
    const { service, tokenStore } = createService()
    const authClient = (
      service as unknown as {
        authClient: {
          passwordLogin: (email: string, password: string) => Promise<typeof loginResult>
        }
      }
    ).authClient
    const passwordLogin = vi.spyOn(authClient, 'passwordLogin').mockResolvedValue(loginResult)
    const storageWriteStarted = deferred<void>()
    const releaseStorageWrite = deferred<void>()
    const writeCandidate = tokenStore.writeSessionTokenCandidate.bind(tokenStore)
    vi.spyOn(tokenStore, 'writeSessionTokenCandidate').mockImplementation(async (...args) => {
      const receipt = await writeCandidate(...args)
      storageWriteStarted.resolve()
      await releaseStorageWrite.promise
      return receipt
    })

    const login = service.passwordLogin(loginResult.me.email, 'fixture-password')
    await storageWriteStarted.promise
    expect(passwordLogin).toHaveBeenCalledWith(loginResult.me.email, 'fixture-password')
    const draining = service.prepareForQuit()

    await expect(service.logout()).resolves.toMatchObject({
      kind: 'not-committed',
      reason: 'deferred',
    })
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

    const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
    const restartedTokenStore = new TokenStoreClass()
    expect(
      await readSessionAuthoritySourceSelection({
        tokenStore: restartedTokenStore,
        envKey: activeEnvKey,
      })
    ).toMatchObject({ status: 'denied', frameMode: 'logged-out' })

    const restarted = createService(restartedTokenStore)
    const restartedAuthClient = (
      restarted.service as unknown as { authClient: { getMe: ReturnType<typeof vi.fn> } }
    ).authClient
    const getMe = vi.spyOn(restartedAuthClient, 'getMe')
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(getMe).not.toHaveBeenCalled()
  })

  it('accepts a fresh source after completed V1 logout cleanup and restores it after restart', async () => {
    const { service, tokenStore } = createService()
    const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
    await expect(internals(service).installAuthenticatedLoginOnce(loginResult)).resolves.toEqual({
      authenticated: true,
      me: loginResult.me,
    })
    await expect(service.logout()).resolves.toMatchObject({ kind: 'committed' })
    await vi.waitFor(async () => {
      const scope = await tokenStore.createSessionAuthorityStorageScope()
      const { SessionAuthorityRecordRepository } = await import('../sessionAuthorityRecord.js')
      const record = new SessionAuthorityRecordRepository(scope, activeEnvKey, tokenStore).observe()
      expect(record.status).toBe('observed')
      if (record.status === 'observed') {
        expect(record.record.frame.mode).toBe('logged-out')
        expect(record.record.cleanupDebts).toHaveLength(0)
      }
    })

    await expect(internals(service).installAuthenticatedLoginOnce(loginResult)).resolves.toEqual({
      authenticated: true,
      me: loginResult.me,
    })

    await expectAcceptedProjection(tokenStore, 'persistent')
    const selected = await readSessionAuthoritySourceSelection({ tokenStore, envKey: activeEnvKey })
    expect(selected.status).toBe('accepted')
    if (selected.status !== 'accepted') throw new Error('Expected the fresh login source to win')
    expect(selected.session.token).toBe(loginResult.token)
    expect(selected.session.accepted.record.frame.source).toMatchObject({
      format: 'v1',
      kind: 'keytar',
      accountId: loginResult.me.id,
    })
    const restarted = createService(tokenStore)
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: loginResult.me,
    })
    expect(internals(restarted.service).sessionToken).toBe(loginResult.token)
  })

  it('accepts fresh authentication without restoring the previous legacy source', async () => {
    markerStore.recordPendingExternalLogout(userDataDirectory, activeEnvKey)
    const { service, tokenStore } = createService()
    await tokenStore.setSessionToken('previous-session-token', activeEnvKey)
    const keytar = await import('keytar')
    vi.mocked(keytar.deletePassword).mockRejectedValueOnce(new Error('keychain temporarily locked'))

    await expect(internals(service).installAuthenticatedLoginOnce(loginResult)).resolves.toEqual({
      authenticated: true,
      me: loginResult.me,
    })

    // Failed historical cleanup leaves the exact slot in place, but the new authority must select
    // the freshly authenticated source and never restore the legacy value.
    expect(keychain.get(keyOf('Evenfire', `session-token::${activeEnvKey}`))).toBe(
      'previous-session-token'
    )
    const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
    const selected = await readSessionAuthoritySourceSelection({ tokenStore, envKey: activeEnvKey })
    expect(selected).toMatchObject({ status: 'accepted', session: { token: loginResult.token } })
    expect(internals(service).sessionToken).toBe(loginResult.token)
    expect(keytar.setPassword).toHaveBeenCalledWith(
      'Evenfire',
      expect.stringContaining('session-v1:'),
      expect.anything()
    )
    const restarted = createService(new TokenStoreClass())
    const restartedAuthClient = (
      restarted.service as unknown as { authClient: { getMe: ReturnType<typeof vi.fn> } }
    ).authClient
    const getMe = vi.spyOn(restartedAuthClient, 'getMe')
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: loginResult.me,
    })
    expect(getMe).toHaveBeenCalledWith(loginResult.token)
    expect(getMe).not.toHaveBeenCalledWith('previous-session-token')
  })

  it('uses the new safeStorage namespace when legacy Keytar bytes are inaccessible', async () => {
    markerStore.recordPendingExternalLogout(userDataDirectory, activeEnvKey)
    const { service, tokenStore } = createService()
    await tokenStore.setSessionToken('previous-session-token', activeEnvKey)
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
    const keytar = await import('keytar')
    const account = `session-token::${activeEnvKey}`
    const originalGet = vi.mocked(keytar.getPassword).getMockImplementation()!
    const originalSet = vi.mocked(keytar.setPassword).getMockImplementation()!
    const originalDelete = vi.mocked(keytar.deletePassword).getMockImplementation()!
    vi.mocked(keytar.setPassword).mockClear()
    vi.mocked(keytar.getPassword).mockImplementation(async (service, readAccount) => {
      if (readAccount === account || readAccount.startsWith('session-v1-capability-probe:'))
        throw Object.assign(new Error('keychain state is transiently unavailable'), {
          code: 'EAGAIN',
        })
      return originalGet(service, readAccount)
    })
    vi.mocked(keytar.setPassword).mockRejectedValue(new Error('keychain unavailable'))
    vi.mocked(keytar.deletePassword).mockImplementation(async (_service, deletedAccount) => {
      if (deletedAccount === account)
        throw Object.assign(new Error('keychain state is transiently unavailable'), {
          code: 'EAGAIN',
        })
      return false
    })

    try {
      await expect(
        internals(service).installAuthenticatedLoginOnce(loginResult)
      ).resolves.toMatchObject({
        authenticated: true,
        me: loginResult.me,
      })
      expect(internals(service).sessionToken).toBe(loginResult.token)
      expect(keychain.get(keyOf('Evenfire', account))).toBe('previous-session-token')
      const { readSessionAuthoritySourceSelection } =
        await import('../sessionAuthorityAcceptance.js')
      const accepted = await readSessionAuthoritySourceSelection({
        tokenStore,
        envKey: activeEnvKey,
      })
      expect(accepted.status).toBe('accepted')
      if (accepted.status !== 'accepted') throw new Error('Expected a fresh accepted session')
      expect(accepted.session.accepted.record.frame.source).toMatchObject({
        format: 'v1',
        kind: 'safe-storage',
      })
    } finally {
      vi.mocked(keytar.getPassword).mockReset().mockImplementation(originalGet)
      vi.mocked(keytar.setPassword).mockReset().mockImplementation(originalSet)
      vi.mocked(keytar.deletePassword).mockReset().mockImplementation(originalDelete)
    }
  })

  it('admits memory-only auth after durable logout cleanup and verified provider unavailability', async () => {
    markerStore.recordPendingExternalLogout(userDataDirectory, activeEnvKey)
    const { service, tokenStore } = createService()
    const restoreProbe = await makeKeytarCapabilityUnavailable()
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)

    try {
      await expect(
        internals(service).installAuthenticatedLoginOnce(loginResult)
      ).resolves.toMatchObject({
        authenticated: true,
        me: loginResult.me,
        sessionMode: 'temporary',
      })

      await expectAcceptedProjection(tokenStore, 'memory-only')
      expect(internals(service).sessionToken).toBe(loginResult.token)
      expect(await fs.readdir(userDataDirectory)).not.toContain(
        `session-token-${activeEnvKey}.json`
      )
      expect(await fs.readdir(userDataDirectory)).not.toContain(`session-token-${activeEnvKey}.enc`)
      const restarted = createService()
      const getMe = vi.spyOn(internals(restarted.service).authClient, 'getMe')
      await expect(restarted.service.initialize()).resolves.toEqual({
        authenticated: false,
        me: null,
      })
      expect(getMe).not.toHaveBeenCalled()
    } finally {
      restoreProbe()
    }
  })

  it('rejects a candidate after uncertain native publication without accepting or restoring it', async () => {
    markerStore.recordPendingExternalLogout(userDataDirectory, activeEnvKey)
    const { service, tokenStore } = createService()
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    const keytar = await import('keytar')
    const writeCandidate = tokenStore.writeSessionTokenCandidate.bind(tokenStore)
    let receipt: Awaited<ReturnType<typeof writeCandidate>> | undefined
    const candidateWriter = vi
      .spyOn(tokenStore, 'writeSessionTokenCandidate')
      .mockImplementation(async input => {
        receipt = await writeCandidate(input)
        throw new Error('native candidate write rejected after publication')
      })
    try {
      await expect(internals(service).installAuthenticatedLoginOnce(loginResult)).rejects.toThrow(
        'native candidate write rejected after publication'
      )
      expect(receipt).toBeDefined()
      expect(internals(service).sessionToken).toBeNull()
      expect(internals(service).me).toBeNull()
      expect(markerStore.readPendingExternalLogoutIntent(userDataDirectory, activeEnvKey)).toEqual({
        intent: 'logout-pending',
      })
      expect(keytar.setPassword).not.toHaveBeenCalledWith(
        'Evenfire',
        expect.stringContaining('session-v1-'),
        expect.anything()
      )
      const { readSessionAuthoritySourceSelection } =
        await import('../sessionAuthorityAcceptance.js')
      const selection = await readSessionAuthoritySourceSelection({
        tokenStore,
        envKey: activeEnvKey,
      })
      expect(selection.status).toBe('denied')
      const restarted = createService()
      const getMe = vi.spyOn(internals(restarted.service).authClient, 'getMe')
      await expect(restarted.service.initialize()).resolves.toEqual({
        authenticated: false,
        me: null,
      })
      expect(getMe).not.toHaveBeenCalled()
    } finally {
      candidateWriter.mockRestore()
    }
  })

  it('keeps transient-only authentication memory-only when persistent providers are unavailable', async () => {
    const { service, tokenStore } = createService()
    const keytar = await import('keytar')
    const originalGet = vi.mocked(keytar.getPassword).getMockImplementation()!
    vi.mocked(keytar.getPassword).mockImplementation(async (service, account) => {
      if (account.startsWith('session-v1-capability-probe:'))
        throw Object.assign(new Error('fixture transient provider inspection failure'), {
          code: 'EAGAIN',
        })
      return originalGet(service, account)
    })
    const writeCandidate = vi.spyOn(tokenStore, 'writeSessionTokenCandidate')

    try {
      await expect(
        internals(service).installAuthenticatedLoginOnce(loginResult)
      ).resolves.toMatchObject({
        authenticated: true,
        me: loginResult.me,
        sessionMode: 'temporary',
      })
      expect(writeCandidate).not.toHaveBeenCalled()
      await expectAcceptedProjection(tokenStore, 'memory-only')
      expect(internals(service).sessionToken).toBe(loginResult.token)
      expect(internals(service).me).toEqual(loginResult.me)
      expect(
        markerStore.readPendingExternalLogoutIntent(userDataDirectory, activeEnvKey)
      ).toMatchObject({ intent: 'acceptance-pending' })
      expect(internals(service).authClient.getMe).toHaveBeenCalledWith(loginResult.token)
      const restarted = createService(new TokenStoreClass())
      await expect(restarted.service.initialize()).resolves.toEqual({
        authenticated: false,
        me: null,
      })
      expect(internals(restarted.service).authClient.getMe).not.toHaveBeenCalled()
    } finally {
      vi.mocked(keytar.getPassword).mockReset().mockImplementation(originalGet)
    }
  })

  it('accepts the selected environment without changing another environment credential', async () => {
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
    const writeCandidate = vi.spyOn(tokenStore, 'writeSessionTokenCandidate')

    try {
      await expect(internals(service).installAuthenticatedLoginOnce(loginResult)).resolves.toEqual({
        authenticated: true,
        me: loginResult.me,
      })

      expect(writeCandidate).toHaveBeenCalledOnce()
      expect(keychain.get(keyOf('Evenfire', legacyAccount))).toBe('legacy-session-token')
      const { readSessionAuthoritySourceSelection } =
        await import('../sessionAuthorityAcceptance.js')
      const selected = await readSessionAuthoritySourceSelection({
        tokenStore,
        envKey: activeEnvKey,
      })
      expect(selected).toMatchObject({ status: 'accepted', session: { token: loginResult.token } })
      expect(internals(service).sessionToken).toBe(loginResult.token)
    } finally {
      vi.mocked(keytar.deletePassword).mockReset().mockImplementation(originalDelete)
    }
  })

  it('accepts fresh login in the new namespace without reading an unreadable legacy Keytar source', async () => {
    markerStore.recordPendingExternalLogout(userDataDirectory, activeEnvKey)
    const { service, tokenStore } = createService()
    await tokenStore.setSessionToken('previous-session-token', activeEnvKey)
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
    const keytar = await import('keytar')
    const originalGet = vi.mocked(keytar.getPassword).getMockImplementation()!
    const originalSet = vi.mocked(keytar.setPassword).getMockImplementation()!
    const originalDelete = vi.mocked(keytar.deletePassword).getMockImplementation()!
    const unavailable = async () => {
      throw Object.assign(new Error('keychain state is unknown'), { code: 'EAGAIN' })
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
      })
      expect(internals(service).sessionToken).toBe(loginResult.token)
      expect(internals(service).authClient.getMe).toHaveBeenCalledWith(loginResult.token)
      expect(keychain.get(keyOf('Evenfire', `session-token::${activeEnvKey}`))).toBe(
        'previous-session-token'
      )
      const { readSessionAuthoritySourceSelection } =
        await import('../sessionAuthorityAcceptance.js')
      const selected = await readSessionAuthoritySourceSelection({
        tokenStore,
        envKey: activeEnvKey,
      })
      expect(selected.status).toBe('accepted')
      if (selected.status !== 'accepted') throw new Error('Expected fresh source acceptance')
      expect(selected.session.accepted.record.frame.source?.format).toBe('v1')
    } finally {
      vi.mocked(keytar.getPassword).mockReset().mockImplementation(originalGet)
      vi.mocked(keytar.setPassword).mockReset().mockImplementation(originalSet)
      vi.mocked(keytar.deletePassword).mockReset().mockImplementation(originalDelete)
    }
  })

  it('uses a temporary session without Keytar or safeStorage and writes no plaintext fallback', async () => {
    const { service } = createService()
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    const restoreProbe = await makeKeytarCapabilityUnavailable()

    try {
      await expect(
        internals(service).installAuthenticatedLoginOnce(loginResult)
      ).resolves.toMatchObject({
        authenticated: true,
        me: loginResult.me,
        sessionMode: 'temporary',
      })

      await expectAcceptedProjection(internals(service).tokenStore, 'memory-only')
      expect(internals(service).sessionToken).toBe(loginResult.token)
      expect(internals(service).me).toEqual(loginResult.me)
      expect(await fs.readdir(userDataDirectory)).not.toContain(
        `session-token-${activeEnvKey}.json`
      )
      expect(await fs.readdir(userDataDirectory)).not.toContain(`session-token-${activeEnvKey}.enc`)
      const restarted = createService()
      await expect(restarted.service.initialize()).resolves.toEqual({
        authenticated: false,
        me: null,
      })
      expect(internals(restarted.service).authClient.getMe).not.toHaveBeenCalled()
    } finally {
      restoreProbe()
    }
  })

  it('does not fall back to safeStorage or memory after uncertain Keytar candidate publication', async () => {
    markerStore.recordPendingExternalLogout(userDataDirectory, activeEnvKey)
    const { service, tokenStore } = createService()
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
    const originalWrite = tokenStore.writeSessionTokenCandidate.bind(tokenStore)
    const writeCandidate = vi
      .spyOn(tokenStore, 'writeSessionTokenCandidate')
      .mockImplementation(async input => {
        await originalWrite(input)
        throw new Error('Keytar candidate publication outcome is uncertain')
      })
    const encrypt = vi.mocked(safeStorage.encryptString)

    await expect(internals(service).installAuthenticatedLoginOnce(loginResult)).rejects.toThrow(
      'Keytar candidate publication outcome is uncertain'
    )

    expect(writeCandidate).toHaveBeenCalledOnce()
    expect(internals(service).sessionToken).toBeNull()
    expect(internals(service).me).toBeNull()
    expect(
      markerStore.readPendingExternalLogoutMarker(userDataDirectory, activeEnvKey)
    ).not.toMatchObject({
      intent: { intent: 'memory-only-session' },
    })
    expect(encrypt).not.toHaveBeenCalled()
    const restarted = createService(tokenStore)
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(internals(restarted.service).authClient.getMe).not.toHaveBeenCalled()
  })

  it('rejects temporary admission when the durable authority marker cannot be replaced', async () => {
    markerStore.recordPendingExternalLogout(userDataDirectory, activeEnvKey)
    const { service } = createService()
    const restoreProbe = await makeKeytarCapabilityUnavailable()
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    const originalRename = fsSync.renameSync.bind(fsSync)
    const markerName = path.basename(markerPath())
    let markerRenameAttempted = false
    const rename = vi.spyOn(fsSync, 'renameSync').mockImplementation((source, destination) => {
      if (path.basename(String(destination)) === markerName) {
        markerRenameAttempted = true
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      }
      return originalRename(source, destination)
    })

    try {
      const outcome = await internals(service)
        .installAuthenticatedLoginOnce(loginResult)
        .then(
          value => ({ value, error: null }),
          error => ({ value: null, error })
        )

      expect(markerRenameAttempted).toBe(true)
      expect(outcome.error).toBeInstanceOf(Error)
      expect(outcome.error?.message).toBe('permission denied')
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
      restoreProbe()
    }
  })

  it('does not authenticate when the memory-only marker directory sync fails', async () => {
    markerStore.recordPendingExternalLogout(userDataDirectory, activeEnvKey)
    const { service } = createService()
    const restoreProbe = await makeKeytarCapabilityUnavailable()
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    const originalFsync = fsSync.fsyncSync.bind(fsSync)
    let failedDirectorySync = false
    let memoryMarkerRenamed = false
    const markerName = path.basename(markerPath())
    const originalRename = fsSync.renameSync.bind(fsSync)
    const rename = vi.spyOn(fsSync, 'renameSync').mockImplementation((source, destination) => {
      const result = originalRename(source, destination)
      if (path.basename(String(destination)) === markerName) memoryMarkerRenamed = true
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
      const outcome = await internals(service)
        .installAuthenticatedLoginOnce(loginResult)
        .then(
          value => ({ value, error: null }),
          error => ({ value: null, error })
        )

      expect(memoryMarkerRenamed).toBe(true)
      expect(failedDirectorySync).toBe(true)
      expect(outcome.error).toBeInstanceOf(Error)
      expect(outcome.error?.message).toBe('directory sync failed')
      expect(internals(service).sessionToken).toBeNull()
      expect(internals(service).me).toBeNull()
      expect(
        markerStore.readPendingExternalLogoutIntent(userDataDirectory, activeEnvKey)
      ).not.toBeNull()
    } finally {
      fsync.mockRestore()
      rename.mockRestore()
      restoreProbe()
    }
  })

  it('keeps chat IPC unauthenticated and removes the candidate when consumer preparation fails', async () => {
    markerStore.recordPendingExternalLogout(userDataDirectory, activeEnvKey)
    const { service, tokenStore } = createService()
    vi.mocked(prepareChatStoreBindingForUser).mockRejectedValueOnce(
      new Error('chat binding failed')
    )

    await expect(internals(service).installAuthenticatedLoginOnce(loginResult)).rejects.toThrow(
      'chat binding failed'
    )

    expect(internals(service).sessionToken).toBeNull()
    expect(internals(service).me).toBeNull()
    expect(() => requireChatStore()).toThrow('Not authenticated')
    const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
    const selected = await readSessionAuthoritySourceSelection({ tokenStore, envKey: activeEnvKey })
    expect(selected.status).toBe('denied')
    const restarted = createService(tokenStore)
    const getMe = vi.spyOn(internals(restarted.service).authClient, 'getMe')
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(getMe).not.toHaveBeenCalled()
  })

  it('records a UI logout rejected by quit admission through the shared AppService path', async () => {
    const { service, tokenStore } = createService()
    internals(service).quitPreparationStarted = true
    const clearToken = vi.spyOn(tokenStore, 'clearSessionToken')
    const logoutOutcome = await service.logout()

    expect(logoutOutcome).toMatchObject({ kind: 'not-committed', reason: 'deferred' })
    expect(markerStore.hasPendingExternalLogout(userDataDirectory, activeEnvKey)).toBe(true)
    expect(clearToken).not.toHaveBeenCalled()
  })

  it('keeps local logout truthful when marker persistence fails during quit', async () => {
    const reportFailure = vi.fn()
    const { service, tokenStore } = createService(undefined, reportFailure)
    const state = internals(service)
    await expect(acceptPersistentSession(service)).resolves.toMatchObject({
      authenticated: true,
      me: loginResult.me,
    })
    const { SessionAuthorityRecordRepository } = await import('../sessionAuthorityRecord.js')
    const storageScope = await tokenStore.createSessionAuthorityStorageScope()
    const before = new SessionAuthorityRecordRepository(
      storageScope,
      activeEnvKey,
      tokenStore
    ).observe()
    expect(before.status).toBe('observed')
    if (before.status !== 'observed')
      throw new Error('Expected accepted V2 authority before logout')
    const acceptedSource = before.record.frame.source
    expect(acceptedSource).not.toBeNull()
    expect(
      markerStore.readPendingExternalLogoutIntent(userDataDirectory, activeEnvKey)
    ).toMatchObject({ intent: 'acceptance-pending' })
    state.quitPreparationStarted = true
    const keytar = await import('keytar')
    const cleanupStarted = deferred<void>()
    const releaseCleanup = deferred<void>()
    vi.mocked(keytar.deletePassword).mockImplementation(async () => {
      cleanupStarted.resolve()
      await releaseCleanup.promise
      throw new Error('credential store locked')
    })
    const originalOpen = fsSync.openSync.bind(fsSync)
    let markerWriteFailures = 0
    const open = vi.spyOn(fsSync, 'openSync').mockImplementation((...args) => {
      if (path.basename(String(args[0])).startsWith(`${path.basename(markerPath())}.`)) {
        markerWriteFailures += 1
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      }
      return originalOpen(...args)
    })
    const clearToken = vi.spyOn(tokenStore, 'clearSessionTokenStrictly')

    try {
      await expect(service.logout()).resolves.toMatchObject({
        kind: 'committed',
        cleanup: 'pending',
      })
      await cleanupStarted.promise

      expect(markerWriteFailures).toBeGreaterThan(0)
      expect(state.sessionToken).toBeNull()
      expect(state.me).toBeNull()
      expect(clearToken).not.toHaveBeenCalled()
      expect(notifySessionChanged).toHaveBeenCalledWith(false)
      // The legacy LP sidecar failed, but the independently durable V2 CAS owns logout and debt.
      expect(
        markerStore.readPendingExternalLogoutIntent(userDataDirectory, activeEnvKey)
      ).toMatchObject({
        intent: 'acceptance-pending',
      })
      const authority = new SessionAuthorityRecordRepository(
        storageScope,
        activeEnvKey,
        tokenStore
      ).observe()
      expect(authority.status).toBe('observed')
      if (authority.status !== 'observed') throw new Error('Expected durable V2 logout record')
      expect(authority.record.frame.mode).toBe('logged-out')
      expect(authority.record.logoutReceipt?.projectionKind).toBe('record-only')
      expect(authority.record.cleanupDebts).toHaveLength(1)
      expect(authority.record.cleanupDebts[0]?.source).toEqual(acceptedSource)
      const { PROFILE_SESSION_AUTHORITY_ENV_KEY } = await import('../sessionAuthorityRecord.js')
      const profileAuthority = new SessionAuthorityRecordRepository(
        storageScope,
        PROFILE_SESSION_AUTHORITY_ENV_KEY,
        tokenStore
      ).observeProfileSelection()
      expect(profileAuthority.status).toBe('observed')
      if (profileAuthority.status !== 'observed')
        throw new Error('Expected global profile authority after durable logout')
      expect(profileAuthority.selection).toMatchObject({
        state: 'signed-out',
        mode: 'signed-out',
        envKey: null,
      })

      // The public logout outcome has settled while the exact source deletion is still blocked.
      releaseCleanup.resolve()
      await vi.waitFor(() => expect(reportFailure).toHaveBeenCalled())

      // The marker provider recovers before restart. The V2 record must deny restore first, then
      // startup may project LP and retain the exact source debt for retry.
      open.mockRestore()
      const restarted = createService(new TokenStoreClass())
      const restartedAuthClient = (
        restarted.service as unknown as { authClient: { getMe: ReturnType<typeof vi.fn> } }
      ).authClient
      const getMe = vi.spyOn(restartedAuthClient, 'getMe')
      await expect(restarted.service.initialize()).resolves.toEqual({
        authenticated: false,
        me: null,
      })
      expect(getMe).not.toHaveBeenCalled()
      expect(markerStore.readPendingExternalLogoutIntent(userDataDirectory, activeEnvKey)).toEqual({
        intent: 'logout-pending',
      })
    } finally {
      open.mockRestore()
    }
  })

  it('reports local-only sign-out when both durable logout witnesses fail', async () => {
    const { service, tokenStore } = createService()
    await acceptPersistentSession(service)
    const state = internals(service)
    const scope = await tokenStore.createSessionAuthorityStorageScope()
    const authorityDirectory = tokenStore.resolveSessionAuthorityStorageDirectory(scope)
    const authorityPrefix = `session-authority-${createHash('sha256').update(activeEnvKey).digest('hex')}.`
    const markerPrefix = `${path.basename(markerPath())}.`
    const originalOpen = fsSync.openSync.bind(fsSync)
    let authorityWriteFailures = 0
    let markerWriteFailures = 0
    const open = vi.spyOn(fsSync, 'openSync').mockImplementation((...args) => {
      const filePath = String(args[0])
      const basename = path.basename(filePath)
      if (path.dirname(filePath) === authorityDirectory && basename.startsWith(authorityPrefix)) {
        authorityWriteFailures += 1
        throw Object.assign(new Error('authority storage unavailable'), { code: 'EACCES' })
      }
      if (basename.startsWith(markerPrefix)) {
        markerWriteFailures += 1
        throw Object.assign(new Error('logout marker storage unavailable'), { code: 'EACCES' })
      }
      return originalOpen(...args)
    })

    try {
      await expect(service.logout()).resolves.toMatchObject({ kind: 'not-committed' })
      expect(state.sessionToken).toBeNull()
      expect(state.me).toBeNull()
      expect(notifySessionChanged).toHaveBeenCalledWith(false)
      expect(authorityWriteFailures).toBeGreaterThan(0)
      expect(markerWriteFailures).toBeGreaterThan(0)
    } finally {
      open.mockRestore()
    }

    const restarted = createService(new TokenStoreClass())
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: loginResult.me,
    })
    expect(internals(restarted.service).sessionToken).toBe(loginResult.token)
  })

  it('commits local logout when asynchronous GFS cleanup fails', async () => {
    const reportFailure = vi.fn()
    const { service, tokenStore } = createService(undefined, reportFailure)
    const state = service as unknown as {
      sessionToken: string | null
      me: unknown
      suspendDesktopGfsUploadsForAuthBoundary: () => Promise<void>
    }
    await acceptPersistentSession(service)
    const clearToken = vi.spyOn(tokenStore, 'clearSessionToken')
    vi.spyOn(state, 'suspendDesktopGfsUploadsForAuthBoundary').mockRejectedValue(
      new Error('Application is shutting down')
    )

    await expect(service.logout()).resolves.toMatchObject({ kind: 'committed' })

    expect(clearToken).not.toHaveBeenCalled()
    expect(state.sessionToken).toBeNull()
    expect(state.me).toBeNull()
    expect(notifySessionChanged).toHaveBeenCalledWith(false)
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
    expect(markerStore.readPendingExternalLogoutIntent(userDataDirectory, activeEnvKey)).toEqual({
      intent: 'logout-pending',
    })
    await expect(tokenStore.getSessionToken(activeEnvKey)).resolves.toBeNull()
    expect(reportFailure).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Application is shutting down' })
    )
  })

  it('ignores a legacy Environment B credential without consuming Environment A logout intent', async () => {
    const envA = activeEnvKey === 'env_a-000000000000' ? 'env_b-111111111111' : 'env_a-000000000000'
    markerStore.recordPendingExternalLogout(userDataDirectory, envA)
    const { service, tokenStore } = createService()
    await tokenStore.setSessionToken('environment-b-token', activeEnvKey)
    const setKeytarSource = vi.spyOn(tokenStore, 'setSessionToken')
    const setSafeStorageSource = vi.spyOn(tokenStore, 'setSafeStorageSessionToken')
    const authClient = service as unknown as {
      authClient: { getMe: (token: string) => Promise<typeof loginResult.me> }
    }
    const getMe = vi.spyOn(authClient.authClient, 'getMe')
    await expect(service.initialize()).resolves.toEqual({ authenticated: false, me: null })

    expect(markerStore.hasPendingExternalLogout(userDataDirectory, envA)).toBe(true)
    expect(markerStore.hasPendingExternalLogout(userDataDirectory, activeEnvKey)).toBe(false)
    const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
    const selected = await readSessionAuthoritySourceSelection({ tokenStore, envKey: activeEnvKey })
    expect(selected).toEqual({ status: 'denied', frameMode: 'logged-out' })
    expect(getMe).not.toHaveBeenCalled()
    expect(keychain.get(keyOf('Evenfire', `session-token::${activeEnvKey}`))).toBe(
      'environment-b-token'
    )
    await expect(tokenStore.getSafeStorageSessionToken(activeEnvKey)).resolves.toBeNull()
    expect(setKeytarSource).not.toHaveBeenCalled()
    expect(setSafeStorageSource).not.toHaveBeenCalled()
    expect(internals(service).sessionToken).toBeNull()
  })
})
