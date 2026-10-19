import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import fsSync from 'node:fs'
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const testRuntime = vi.hoisted(() => ({
  userDataDirectory: '',
  safeStorageBackend: 'gnome_libsecret',
}))
const { notifySessionChanged } = vi.hoisted(() => ({ notifySessionChanged: vi.fn() }))

vi.mock('keytar', () => ({}))
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => testRuntime.userDataDirectory),
    isReady: vi.fn(() => true),
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    getSelectedStorageBackend: () => testRuntime.safeStorageBackend,
    encryptString: vi.fn((value: string) => Buffer.from(value, 'utf8')),
    decryptString: vi.fn((value: Buffer) => value.toString('utf8')),
  },
}))
vi.mock('../chatStoreBinding.js', async () => {
  const { createChatStoreBindingMock } = await import('../../testSupport/chatStoreBindingMock.js')
  return createChatStoreBindingMock()
})
vi.mock('../pluginSdkRuntime.js', () => ({
  tryGetPluginSdkRuntime: () => ({ notifySessionChanged, unpinAllSandboxUiSurfaces: vi.fn() }),
}))

let userDataDirectory = ''
let AppServiceClass: typeof import('../appService.js').AppService
let QuitAdmissionClosedErrorClass: typeof import('../appService.js').QuitAdmissionClosedError
let TokenStoreClass: typeof import('../tokenStore.js').TokenStore
let activeEnvKey = ''
let markerStore: typeof import('../pendingExternalLogout.js')

const user = {
  id: 'user-1',
  email: 'user@example.com',
  name: null,
  picture: null,
  teamId: 'team-1',
  teamName: 'Team 1',
  role: 'member' as const,
}

function validSessionToken(expSeconds = Math.floor(Date.now() / 1000) + 3600): string {
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url')
  return `header.${payload}.signature`
}

beforeEach(async () => {
  userDataDirectory = await mkdtemp(path.join(os.tmpdir(), 'evenfire-no-keytar-logout-'))
  testRuntime.userDataDirectory = userDataDirectory
  testRuntime.safeStorageBackend = 'gnome_libsecret'
  vi.clearAllMocks()
  vi.resetModules()
  const [appService, tokenStore, marker, config] = await Promise.all([
    import('../appService.js'),
    import('../tokenStore.js'),
    import('../pendingExternalLogout.js'),
    import('../config.js'),
  ])
  AppServiceClass = appService.AppService
  QuitAdmissionClosedErrorClass = appService.QuitAdmissionClosedError
  TokenStoreClass = tokenStore.TokenStore
  markerStore = marker
  activeEnvKey = config.getActiveEnvKey()
  const { safeStorage } = await import('electron')
  vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
})

afterEach(async () => {
  if (userDataDirectory) await rm(userDataDirectory, { recursive: true, force: true })
  userDataDirectory = ''
  testRuntime.userDataDirectory = ''
  vi.resetModules()
})

describe('AppService pending logout when Keytar is unavailable', () => {
  it('keeps a cleanup marker and restores verified safeStorage login while Keytar is unavailable', async () => {
    const tokenStore = new TokenStoreClass()
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
    const service = new AppServiceClass({
      tokenStore,
      getUserDataDirectory: () => userDataDirectory,
    })
    const authClient = (
      service as unknown as {
        authClient: { getMe: (token: string) => Promise<typeof user> }
      }
    ).authClient
    vi.spyOn(authClient, 'getMe').mockResolvedValue(user)
    const internals = service as unknown as {
      sessionToken: string | null
      me: typeof user | null
      quitPreparationStarted: boolean
      installAuthenticatedLogin: (result: { token: string; me: typeof user }) => Promise<unknown>
    }

    await tokenStore.setSessionToken('test-token-old-keychain-session', activeEnvKey)
    internals.sessionToken = 'test-token-old-keychain-session'
    internals.me = user
    internals.quitPreparationStarted = true

    await expect(service.logout()).rejects.toBeInstanceOf(QuitAdmissionClosedErrorClass)
    expect(markerStore.hasPendingExternalLogout(userDataDirectory, activeEnvKey)).toBe(true)

    service.cancelQuitPreparation()
    await expect(service.initialize()).resolves.toEqual({ authenticated: false, me: null })
    expect(markerStore.hasPendingExternalLogout(userDataDirectory, activeEnvKey)).toBe(true)
    await expect(tokenStore.getSessionToken(activeEnvKey)).resolves.toBeNull()

    await expect(
      internals.installAuthenticatedLogin({ token: 'test-token-new-file-backed-session', me: user })
    ).resolves.toEqual({ authenticated: true, me: user })
    expect(markerStore.hasPendingExternalLogout(userDataDirectory, activeEnvKey)).toBe(true)
    await expect(tokenStore.getSessionToken(activeEnvKey)).resolves.toBe(
      'test-token-new-file-backed-session'
    )
    const files = await readdir(userDataDirectory)
    expect(files).toContain(`session-token-${activeEnvKey}.enc`)
    expect(files).not.toContain(`session-token-${activeEnvKey}.json`)
    await expect(service.initialize()).resolves.toEqual({ authenticated: true, me: user })
    expect(markerStore.hasPendingExternalLogout(userDataDirectory, activeEnvKey)).toBe(true)
    await expect(tokenStore.getSessionToken(activeEnvKey)).resolves.toBe(
      'test-token-new-file-backed-session'
    )

    const environmentId = createHash('sha256').update(activeEnvKey).digest('hex')
    const marker = await readFile(
      path.join(userDataDirectory, `pending-external-logout-${environmentId}`),
      'utf8'
    )
    expect(marker).toContain('"intent":"keytar-cleanup-pending"')
    expect(notifySessionChanged).toHaveBeenCalledWith(false)
  })

  it('does not restore a safeStorage token for an active-Keytar cleanup marker', async () => {
    const tokenStore = new TokenStoreClass()
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
    await tokenStore.setSafeStorageSessionToken('stale-safe-storage-token', activeEnvKey)
    markerStore.recordPendingKeytarCleanup(userDataDirectory, activeEnvKey, 'active-keytar')
    const service = new AppServiceClass({
      tokenStore,
      getUserDataDirectory: () => userDataDirectory,
    })
    const authClient = (
      service as unknown as {
        authClient: { getMe: (token: string) => Promise<typeof user> }
      }
    ).authClient
    const getMe = vi.spyOn(authClient, 'getMe')

    await expect(service.initialize()).resolves.toEqual({ authenticated: false, me: null })

    expect(getMe).not.toHaveBeenCalled()
    expect(markerStore.readPendingExternalLogoutIntent(userDataDirectory, activeEnvKey)).toEqual({
      intent: 'keytar-cleanup-pending',
      credentialSource: 'active-keytar',
    })
  })

  it('retains a cleanup marker when canceled-quit retry cannot access Keytar', async () => {
    markerStore.recordPendingKeytarCleanup(userDataDirectory, activeEnvKey, 'safe-storage')
    const service = new AppServiceClass({
      tokenStore: new TokenStoreClass(),
      getUserDataDirectory: () => userDataDirectory,
    })

    await expect(service.applyPendingExternalLogoutIntent()).resolves.toBe(false)

    expect(markerStore.readPendingExternalLogoutIntent(userDataDirectory, activeEnvKey)).toEqual({
      intent: 'keytar-cleanup-pending',
      credentialSource: 'safe-storage',
    })
  })

  it.each(['password', 'oauth'] as const)(
    'admits a %s-authenticated temporary session without Keytar or safeStorage',
    async loginKind => {
      const config = await import('../config.js')
      await config.saveDesktopRuntimeConfig({
        externalRestApiBaseUrl: 'https://auth.example.test/api',
        rpcProxyBaseUrl: '',
      })
      activeEnvKey = config.getActiveEnvKey()
      const token = validSessionToken()
      const tokenStore = new TokenStoreClass()
      const service = new AppServiceClass({
        tokenStore,
        getUserDataDirectory: () => userDataDirectory,
      })
      const authClient = (
        service as unknown as {
          authClient: {
            passwordLogin: (email: string, password: string) => Promise<unknown>
            googleLogin: (idToken: string) => Promise<unknown>
          }
        }
      ).authClient
      const result = { token, me: user }
      const state = service as unknown as {
        sessionToken: string | null
        me: typeof user | null
      }
      if (loginKind === 'password') {
        vi.spyOn(authClient, 'passwordLogin').mockResolvedValue(result)
      } else {
        vi.spyOn(authClient, 'googleLogin').mockResolvedValue(result)
      }

      const sessionState =
        loginKind === 'password'
          ? await service.passwordLogin('user@example.com', 'not-used-in-this-test')
          : await service.googleLogin('oauth-id-token')

      expect(sessionState).toMatchObject({
        authenticated: true,
        me: user,
        sessionMode: 'temporary',
        expiresAt: expect.any(Number),
      })
      expect(state.sessionToken).toBe(token)
      expect(state.me).toEqual(user)
      expect(markerStore.readPendingExternalLogoutIntent(userDataDirectory, activeEnvKey)).toEqual(
        expect.objectContaining({ intent: 'memory-only-session' })
      )
      const entries = await readdir(userDataDirectory, { withFileTypes: true })
      const files = entries.map(entry => entry.name)
      expect(files).not.toContain(`session-token-${activeEnvKey}.enc`)
      expect(files).not.toContain(`session-token-${activeEnvKey}.json`)
      for (const entry of entries) {
        if (!entry.isFile()) continue
        const contents = await readFile(path.join(userDataDirectory, entry.name))
        expect(contents.includes(Buffer.from(token))).toBe(false)
      }
    }
  )

  it('uses memory-only mode when Linux safeStorage selects the basic_text backend', async () => {
    const hostPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    const sync = fsSync.fsyncSync.bind(fsSync)
    let directorySyncCompleted = false
    const syncSpy = vi.spyOn(fsSync, 'fsyncSync').mockImplementation(descriptor => {
      const isDirectory = fsSync.fstatSync(descriptor).isDirectory()
      // Only emulate Linux's unsupported directory fsync when the actual host is Windows.
      // POSIX hosts must execute the real sync while this test spoofs Linux platform detection.
      if (hostPlatform === 'win32' && isDirectory) return
      const result = sync(descriptor)
      if (isDirectory) directorySyncCompleted = true
      return result
    })
    try {
      testRuntime.safeStorageBackend = 'basic_text'
      const { safeStorage } = await import('electron')
      vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
      const token = validSessionToken()
      const tokenStore = new TokenStoreClass()
      const service = new AppServiceClass({
        tokenStore,
        getUserDataDirectory: () => userDataDirectory,
      })
      const state = service as unknown as {
        installAuthenticatedLogin: (result: { token: string; me: typeof user }) => Promise<unknown>
        sessionToken: string | null
      }

      await expect(state.installAuthenticatedLogin({ token, me: user })).resolves.toMatchObject({
        authenticated: true,
        sessionMode: 'temporary',
      })

      expect(state.sessionToken).toBe(token)
      expect(
        markerStore.readPendingExternalLogoutIntent(userDataDirectory, activeEnvKey)
      ).toMatchObject({ intent: 'memory-only-session' })
      await expect(tokenStore.getSafeStorageSessionToken(activeEnvKey)).resolves.toBeNull()
      for (const file of await readdir(userDataDirectory)) {
        expect(
          (await readFile(path.join(userDataDirectory, file))).includes(Buffer.from(token))
        ).toBe(false)
      }
      if (hostPlatform !== 'win32') expect(directorySyncCompleted).toBe(true)
    } finally {
      syncSpy.mockRestore()
      Object.defineProperty(process, 'platform', { value: hostPlatform, configurable: true })
    }
  })

  it('rejects temporary admission when the durable credential-source snapshot is unreadable', async () => {
    const token = validSessionToken()
    const fallbackPath = path.join(userDataDirectory, `session-token-${activeEnvKey}.enc`)
    const targetPath = path.join(userDataDirectory, 'stale-fallback-target')
    await writeFile(targetPath, 'stale-fallback-value')
    await symlink(targetPath, fallbackPath)
    const service = new AppServiceClass({
      tokenStore: new TokenStoreClass(),
      getUserDataDirectory: () => userDataDirectory,
    })
    const state = service as unknown as {
      installAuthenticatedLogin: (result: { token: string; me: typeof user }) => Promise<unknown>
      sessionToken: string | null
      me: typeof user | null
    }

    await expect(state.installAuthenticatedLogin({ token, me: user })).rejects.toThrow(
      'Session-token fallback is not a regular file'
    )

    expect(state.sessionToken).toBeNull()
    expect(state.me).toBeNull()
    expect(
      markerStore.readPendingExternalLogoutIntent(userDataDirectory, activeEnvKey)?.intent
    ).not.toBe('memory-only-session')
  })

  it('converts a durable logout intent to a temporary-session fence after fresh authentication', async () => {
    markerStore.recordPendingExternalLogout(userDataDirectory, activeEnvKey)
    const token = validSessionToken()
    const service = new AppServiceClass({
      tokenStore: new TokenStoreClass(),
      getUserDataDirectory: () => userDataDirectory,
    })
    const state = service as unknown as {
      installAuthenticatedLogin: (result: { token: string; me: typeof user }) => Promise<unknown>
      sessionToken: string | null
      me: typeof user | null
    }

    await expect(state.installAuthenticatedLogin({ token, me: user })).resolves.toMatchObject({
      authenticated: true,
      sessionMode: 'temporary',
    })

    expect(state.sessionToken).toBe(token)
    expect(state.me).toEqual(user)
    expect(
      markerStore.readPendingExternalLogoutIntent(userDataDirectory, activeEnvKey)
    ).toMatchObject({ intent: 'memory-only-session' })
    expect(await readdir(userDataDirectory)).not.toContain(`session-token-${activeEnvKey}.json`)
    await service.logout()
    expect(state.sessionToken).toBeNull()
    expect(
      markerStore.readPendingExternalLogoutIntent(userDataDirectory, activeEnvKey)
    ).toMatchObject({ intent: 'memory-only-session' })
  })

  it('does not extend the temporary absolute deadline during an in-memory team-token replacement', async () => {
    const tokenStore = new TokenStoreClass()
    const service = new AppServiceClass({
      tokenStore,
      getUserDataDirectory: () => userDataDirectory,
    })
    const internals = service as unknown as {
      installAuthenticatedLogin: (result: { token: string; me: typeof user }) => Promise<unknown>
      commitSessionToken: (token: string) => Promise<void>
      sessionToken: string | null
      memoryOnlySession: { expiresAt: number } | undefined
    }
    await internals.installAuthenticatedLogin({ token: validSessionToken(), me: user })
    const originalDeadline = internals.memoryOnlySession!.expiresAt

    await internals.commitSessionToken(
      validSessionToken(Math.floor(Date.now() / 1000) + 20 * 60 * 60)
    )

    expect(internals.memoryOnlySession?.expiresAt).toBe(originalDeadline)
    expect(internals.sessionToken).not.toBeNull()
    await service.logout()
  })

  it('does not use an RPC token returned after the temporary session expires', async () => {
    const service = new AppServiceClass({
      tokenStore: new TokenStoreClass(),
      getUserDataDirectory: () => userDataDirectory,
    })
    const internals = service as unknown as {
      installAuthenticatedLogin: (result: { token: string; me: typeof user }) => Promise<unknown>
      authClient: { issueRpcToken: (...args: never[]) => Promise<unknown> }
      rpcClient: { listSandboxUiApps: (token: string) => Promise<unknown> }
      memoryOnlySession: { expiresAt: number } | undefined
      memoryOnlySessionTermination: Promise<void> | null
    }
    await internals.installAuthenticatedLogin({ token: validSessionToken(), me: user })

    let releaseIssue!: () => void
    let markIssueEntered!: () => void
    const issueEntered = new Promise<void>(resolve => {
      markIssueEntered = resolve
    })
    const issueBlocked = new Promise<void>(resolve => {
      releaseIssue = resolve
    })
    const authClient = internals.authClient as unknown as {
      issueRpcToken: (...args: unknown[]) => Promise<{
        token: string
        accessScope: 'user'
        teamId: null
        scopes: []
        hostRefs: string[]
        expiresInSeconds: number
      }>
    }
    vi.spyOn(authClient, 'issueRpcToken').mockImplementation(async () => {
      markIssueEntered()
      await issueBlocked
      return {
        token: 'fixture-short-lived-rpc-token',
        accessScope: 'user',
        teamId: null,
        scopes: [],
        hostRefs: [],
        expiresInSeconds: 300,
      }
    })
    const listSandboxApps = vi
      .spyOn(internals.rpcClient, 'listSandboxUiApps')
      .mockResolvedValue({ apps: [] })
    const pending = service.listSandboxUiApps()
    await issueEntered
    internals.memoryOnlySession!.expiresAt = Date.now() - 1
    releaseIssue()

    await expect(pending).rejects.toThrow('Temporary session expired')
    expect(listSandboxApps).not.toHaveBeenCalled()
    await internals.memoryOnlySessionTermination
  })

  it('anchors the temporary deadline to server authentication, before persistence work', async () => {
    const service = new AppServiceClass({
      tokenStore: new TokenStoreClass(),
      getUserDataDirectory: () => userDataDirectory,
    })
    const authenticatedAt = Date.now() - 30 * 60 * 1000
    const token = validSessionToken(Math.floor((authenticatedAt + 48 * 60 * 60 * 1000) / 1000))
    const internals = service as unknown as {
      installAuthenticatedLoginOnce: (
        result: { token: string; me: typeof user },
        authenticatedAt: number
      ) => Promise<unknown>
      memoryOnlySession: { expiresAt: number } | undefined
    }

    await internals.installAuthenticatedLoginOnce({ token, me: user }, authenticatedAt)

    expect(internals.memoryOnlySession?.expiresAt).toBe(authenticatedAt + 24 * 60 * 60 * 1000)
    await service.logout()
  })

  it('ends an expired temporary lease and leaves the durable restart fence in place', async () => {
    const notifySessionExpired = vi.fn()
    const service = new AppServiceClass({
      tokenStore: new TokenStoreClass(),
      getUserDataDirectory: () => userDataDirectory,
      notifySessionExpired,
    })
    const internals = service as unknown as {
      installAuthenticatedLogin: (result: { token: string; me: typeof user }) => Promise<unknown>
      sessionToken: string | null
      me: typeof user | null
      memoryOnlySession: { expiresAt: number } | undefined
      memoryOnlySessionTermination: Promise<void> | null
      closeSandboxUi: () => Promise<void>
    }
    await internals.installAuthenticatedLogin({ token: validSessionToken(), me: user })
    internals.memoryOnlySession!.expiresAt = Date.now() - 1

    expect(service.checkTemporarySessionExpiry()).toBe(true)
    await internals.memoryOnlySessionTermination
    await internals.closeSandboxUi()
    expect(internals.sessionToken).toBeNull()
    expect(internals.me).toBeNull()
    expect(notifySessionExpired).toHaveBeenCalledOnce()
    expect(
      markerStore.readPendingExternalLogoutIntent(userDataDirectory, activeEnvKey)
    ).toMatchObject({ intent: 'memory-only-session' })
  })

  it('shares the auth-boundary drain when logout overlaps temporary-session expiry', async () => {
    const service = new AppServiceClass({
      tokenStore: new TokenStoreClass(),
      getUserDataDirectory: () => userDataDirectory,
    })
    const internals = service as unknown as {
      installAuthenticatedLogin: (result: { token: string; me: typeof user }) => Promise<unknown>
      memoryOnlySession: { expiresAt: number } | undefined
      suspendDesktopGfsUploadsForAuthBoundary: () => Promise<void>
    }
    await internals.installAuthenticatedLogin({ token: validSessionToken(), me: user })

    let releaseDrain!: () => void
    let markDrainEntered!: () => void
    const drainEntered = new Promise<void>(resolve => {
      markDrainEntered = resolve
    })
    const drainBlocked = new Promise<void>(resolve => {
      releaseDrain = resolve
    })
    const suspend = internals.suspendDesktopGfsUploadsForAuthBoundary.bind(service)
    const suspension = vi
      .spyOn(internals, 'suspendDesktopGfsUploadsForAuthBoundary')
      .mockImplementation(async () => {
        markDrainEntered()
        await drainBlocked
        await suspend()
      })

    const logout = service.logout()
    await drainEntered
    internals.memoryOnlySession!.expiresAt = Date.now() - 1
    expect(service.checkTemporarySessionExpiry()).toBe(true)
    releaseDrain()

    await expect(logout).resolves.toBeTypeOf('number')
    expect(suspension).toHaveBeenCalledOnce()
    expect(
      markerStore.readPendingExternalLogoutIntent(userDataDirectory, activeEnvKey)
    ).toMatchObject({ intent: 'memory-only-session' })
  })

  it('rejects a token-bearing request before dispatch when the temporary lease has expired', async () => {
    const notifySessionExpired = vi.fn()
    const service = new AppServiceClass({
      tokenStore: new TokenStoreClass(),
      getUserDataDirectory: () => userDataDirectory,
      notifySessionExpired,
    })
    const internals = service as unknown as {
      installAuthenticatedLogin: (result: { token: string; me: typeof user }) => Promise<unknown>
      sessionToken: string | null
      memoryOnlySession: { expiresAt: number } | undefined
      memoryOnlySessionTermination: Promise<void> | null
    }
    const token = validSessionToken()
    await internals.installAuthenticatedLogin({ token, me: user })
    internals.memoryOnlySession!.expiresAt = Date.now() - 1
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { requestJson } = await import('../httpClient.js')

    await expect(
      requestJson('GET', 'https://api.example.test/protected', { token })
    ).rejects.toThrow('Temporary session expired')

    expect(fetchMock).not.toHaveBeenCalled()
    expect(internals.sessionToken).toBeNull()
    expect(notifySessionExpired).toHaveBeenCalledOnce()
    expect(
      markerStore.readPendingExternalLogoutIntent(userDataDirectory, activeEnvKey)
    ).toMatchObject({ intent: 'memory-only-session' })
    await internals.memoryOnlySessionTermination
    vi.unstubAllGlobals()
  })

  it('requires fresh login after restart without reading a previously saved credential', async () => {
    const staleToken = validSessionToken()
    await writeFile(
      path.join(userDataDirectory, `session-token-${activeEnvKey}.json`),
      JSON.stringify({ token: staleToken }),
      { mode: 0o600 }
    )
    markerStore.recordMemoryOnlySessionIfMissing(userDataDirectory, activeEnvKey)
    const tokenStore = new TokenStoreClass()
    const readSavedCredential = vi.spyOn(tokenStore, 'getSessionToken')
    const restarted = new AppServiceClass({
      tokenStore,
      getUserDataDirectory: () => userDataDirectory,
    })
    const getMe = vi.spyOn(
      (restarted as unknown as { authClient: { getMe: (token: string) => Promise<typeof user> } })
        .authClient,
      'getMe'
    )

    await expect(restarted.initialize()).resolves.toEqual({ authenticated: false, me: null })
    expect(readSavedCredential).not.toHaveBeenCalled()
    expect(getMe).not.toHaveBeenCalled()
  })
})
