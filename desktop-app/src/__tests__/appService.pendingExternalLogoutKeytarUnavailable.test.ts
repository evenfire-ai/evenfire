import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const testRuntime = vi.hoisted(() => ({
  userDataDirectory: '',
  safeStorageBackend: 'gnome_libsecret',
}))
const { notifySessionChanged } = vi.hoisted(() => ({ notifySessionChanged: vi.fn() }))

vi.mock('keytar', () => ({}))
vi.mock('../windowsSessionAuthorityAcl.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../windowsSessionAuthorityAcl.js')>()
  const { createWindowsSessionAuthorityAclUnitFixture } =
    await import('../../testSupport/windowsSessionAuthorityAclUnitFixture.js')
  return createWindowsSessionAuthorityAclUnitFixture(actual)
})
vi.mock('../windowsSessionAuthorityFileOps.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../windowsSessionAuthorityFileOps.js')>()
  const { createWindowsSessionAuthorityFileOpsUnitFixture } =
    await import('../../testSupport/windowsSessionAuthorityFileOpsUnitFixture.js')
  return createWindowsSessionAuthorityFileOpsUnitFixture(actual)
})
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
let TokenStoreClass: typeof import('../tokenStore.js').TokenStore
let activeEnvKey = ''
let markerStore: typeof import('../pendingExternalLogout.js')
let serviceForCleanup: InstanceType<typeof AppServiceClass> | null = null

const user = {
  id: 'user-1',
  email: 'user@example.com',
  name: null,
  picture: null,
  teamId: 'team-1',
  teamName: 'Team 1',
  role: 'member' as const,
}

const linuxBasicTextTest = process.platform === 'win32' ? it.skip : it

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
  TokenStoreClass = tokenStore.TokenStore
  markerStore = marker
  activeEnvKey = config.getActiveEnvKey()
  const { safeStorage } = await import('electron')
  vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/v1/me'))
        return new Response(JSON.stringify(user), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      throw new Error(`unexpected HTTP request in isolated fixture: ${url}`)
    })
  )
})

afterEach(async () => {
  if (serviceForCleanup) await serviceForCleanup.prepareForQuit()
  serviceForCleanup = null
  if (userDataDirectory)
    await rm(userDataDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
  userDataDirectory = ''
  testRuntime.userDataDirectory = ''
  vi.resetModules()
})

function createIsolatedTokenStore(): InstanceType<typeof TokenStoreClass> {
  // These tests model an unavailable OS credential provider. Keep the profile
  // isolated instead of mocking an invalid Keytar module shape, which correctly
  // classifies as unknown and fails closed.
  return new TokenStoreClass({ isolatedUserDataPath: userDataDirectory })
}

async function expectMemoryOnlyRestartFence(): Promise<void> {
  const [{ getActiveEnvKey }, { readSessionAuthoritySourceSelection }] = await Promise.all([
    import('../config.js'),
    import('../sessionAuthorityAcceptance.js'),
  ])
  const selection = await readSessionAuthoritySourceSelection({
    tokenStore: createIsolatedTokenStore(),
    envKey: getActiveEnvKey(),
  })
  expect(selection).toMatchObject({ status: 'denied', frameMode: 'memory-only' })

  const restarted = new AppServiceClass({
    tokenStore: createIsolatedTokenStore(),
    getUserDataDirectory: () => userDataDirectory,
  })
  const getMe = vi.spyOn(
    (restarted as unknown as { authClient: { getMe: (token: string) => Promise<typeof user> } })
      .authClient,
    'getMe'
  )
  await expect(restarted.initialize()).resolves.toEqual({ authenticated: false, me: null })
  expect(getMe).not.toHaveBeenCalled()
}

describe('AppService logout when Keytar is unavailable', () => {
  it('keeps a durably signed-out V1 session denied when exact cleanup fails', async () => {
    const config = await import('../config.js')
    await config.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: 'https://auth.example.test/api',
      rpcProxyBaseUrl: '',
    })
    activeEnvKey = config.getActiveEnvKey()
    const tokenStore = createIsolatedTokenStore()
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
    const service = new AppServiceClass({
      tokenStore,
      getUserDataDirectory: () => userDataDirectory,
    })
    serviceForCleanup = service
    const loginToken = 'test-token-new-file-backed-session'
    const authClient = (
      service as unknown as {
        authClient: {
          getMe: (token: string) => Promise<typeof user>
          passwordLogin: (email: string, password: string) => Promise<unknown>
        }
      }
    ).authClient
    vi.spyOn(authClient, 'getMe').mockResolvedValue(user)
    vi.spyOn(authClient, 'passwordLogin').mockResolvedValue({ token: loginToken, me: user })
    await expect(service.passwordLogin(user.email, 'synthetic-password')).resolves.toMatchObject({
      authenticated: true,
      me: user,
    })
    const [{ getActiveEnvKey }, { readSessionAuthoritySourceSelection }] = await Promise.all([
      import('../config.js'),
      import('../sessionAuthorityAcceptance.js'),
    ])
    const accepted = await readSessionAuthoritySourceSelection({
      tokenStore,
      envKey: getActiveEnvKey(),
    })
    expect(accepted.status).toBe('accepted')
    if (accepted.status !== 'accepted') throw new Error('Fresh login was not accepted')
    expect(accepted.session.token).toBe(loginToken)
    expect(accepted.session.accepted.record.frame.source).toMatchObject({
      format: 'v1',
      kind: 'safe-storage',
    })
    const deleteSource = vi
      .spyOn(tokenStore, 'deleteSessionCredentialSourceIfUnselectedWithProof')
      .mockRejectedValue(new Error('synthetic secure-store deletion failure'))
    await expect(service.logout()).resolves.toMatchObject({ kind: 'committed' })
    expect(deleteSource).toHaveBeenCalledOnce()
    expect(notifySessionChanged).toHaveBeenCalledWith(false)

    const restarted = new AppServiceClass({
      tokenStore: createIsolatedTokenStore(),
      getUserDataDirectory: () => userDataDirectory,
    })
    const restartedAuthClient = (
      restarted as unknown as {
        authClient: { getMe: (token: string) => Promise<typeof user> }
      }
    ).authClient
    const getMe = vi.spyOn(restartedAuthClient, 'getMe')
    await expect(restarted.initialize()).resolves.toEqual({ authenticated: false, me: null })
    expect(getMe).not.toHaveBeenCalled()
    await expect(tokenStore.getSafeStorageSessionToken(activeEnvKey)).resolves.toBeNull()
  })

  it('does not restore a safeStorage token for an active-Keytar cleanup marker', async () => {
    const tokenStore = createIsolatedTokenStore()
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
      tokenStore: createIsolatedTokenStore(),
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
      const tokenStore = createIsolatedTokenStore()
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
        expect.objectContaining({ intent: 'acceptance-pending' })
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
      await expectMemoryOnlyRestartFence()
    }
  )

  it('denies GFS session metadata reads after a memory-only lease expires', async () => {
    const config = await import('../config.js')
    await config.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: 'https://auth.example.test/api',
      rpcProxyBaseUrl: '',
    })
    activeEnvKey = config.getActiveEnvKey()
    const tokenStore = createIsolatedTokenStore()
    const service = new AppServiceClass({
      tokenStore,
      getUserDataDirectory: () => userDataDirectory,
    })
    const authClient = (
      service as unknown as {
        authClient: { passwordLogin: (email: string, password: string) => Promise<unknown> }
      }
    ).authClient
    vi.spyOn(authClient, 'passwordLogin').mockResolvedValue({
      token: validSessionToken(),
      me: user,
    })
    await service.passwordLogin('user@example.com', 'synthetic-password')

    const runtime = service as unknown as { memoryOnlySession: { expiresAt: number } | undefined }
    expect(runtime.memoryOnlySession).toBeDefined()
    runtime.memoryOnlySession!.expiresAt = Date.now() - 1

    await expect(service.listGfsUploadSessions()).rejects.toThrow('Temporary session expired')
    await expect(service.getGfsUploadSnapshot('synthetic-upload')).rejects.toThrow(
      'GFS upload dispatch is unavailable without an active authenticated scope'
    )
  })

  linuxBasicTextTest(
    'uses memory-only mode when Linux safeStorage selects the basic_text backend',
    async () => {
      const hostPlatform = process.platform
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
      try {
        testRuntime.safeStorageBackend = 'basic_text'
        const { safeStorage } = await import('electron')
        vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
        const token = validSessionToken()
        const tokenStore = createIsolatedTokenStore()
        const service = new AppServiceClass({
          tokenStore,
          getUserDataDirectory: () => userDataDirectory,
        })
        const state = service as unknown as {
          installAuthenticatedLogin: (result: {
            token: string
            me: typeof user
          }) => Promise<unknown>
          sessionToken: string | null
        }

        await expect(state.installAuthenticatedLogin({ token, me: user })).resolves.toMatchObject({
          authenticated: true,
          sessionMode: 'temporary',
        })

        expect(state.sessionToken).toBe(token)
        expect(
          markerStore.readPendingExternalLogoutIntent(userDataDirectory, activeEnvKey)
        ).toMatchObject({ intent: 'acceptance-pending' })
        await expect(tokenStore.getSafeStorageSessionToken(activeEnvKey)).resolves.toBeNull()
        for (const entry of await readdir(userDataDirectory, { withFileTypes: true })) {
          if (!entry.isFile()) continue
          expect(
            (await readFile(path.join(userDataDirectory, entry.name))).includes(Buffer.from(token))
          ).toBe(false)
        }
        await expectMemoryOnlyRestartFence()
      } finally {
        Object.defineProperty(process, 'platform', { value: hostPlatform, configurable: true })
      }
    }
  )

  it('ignores an unreadable legacy V0 fallback during fresh memory-only authentication', async () => {
    const config = await import('../config.js')
    await config.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: 'https://auth.example.test/api',
      rpcProxyBaseUrl: '',
    })
    activeEnvKey = config.getActiveEnvKey()
    const token = validSessionToken()
    const fallbackPath = path.join(userDataDirectory, `session-token-${activeEnvKey}.enc`)
    const targetPath = path.join(userDataDirectory, 'stale-fallback-target')
    await writeFile(targetPath, 'stale-fallback-value')
    await symlink(targetPath, fallbackPath)
    const service = new AppServiceClass({
      tokenStore: createIsolatedTokenStore(),
      getUserDataDirectory: () => userDataDirectory,
    })
    const state = service as unknown as { sessionToken: string | null; me: typeof user | null }
    const authClient = (
      service as unknown as {
        authClient: { passwordLogin: (email: string, password: string) => Promise<unknown> }
      }
    ).authClient
    vi.spyOn(authClient, 'passwordLogin').mockResolvedValue({ token, me: user })
    const getMe = vi.spyOn(
      (
        service as unknown as {
          authClient: { getMe: (sessionToken: string) => Promise<typeof user> }
        }
      ).authClient,
      'getMe'
    )

    await expect(service.passwordLogin(user.email, 'synthetic-password')).resolves.toMatchObject({
      authenticated: true,
      sessionMode: 'temporary',
      me: user,
    })

    expect(state.sessionToken).toBe(token)
    expect(state.me).toEqual(user)
    expect(getMe).not.toHaveBeenCalledWith('stale-fallback-value')
    expect(await readFile(targetPath, 'utf8')).toBe('stale-fallback-value')
    expect(
      markerStore.readPendingExternalLogoutIntent(userDataDirectory, activeEnvKey)
    ).toMatchObject({ intent: 'acceptance-pending' })
    await expectMemoryOnlyRestartFence()
  })

  it('allows fresh memory-only authentication after LP and keeps restart denied after logout', async () => {
    markerStore.recordPendingExternalLogout(userDataDirectory, activeEnvKey)
    const token = validSessionToken()
    const service = new AppServiceClass({
      tokenStore: createIsolatedTokenStore(),
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
    ).toMatchObject({ intent: 'acceptance-pending' })
    expect(await readdir(userDataDirectory)).not.toContain(`session-token-${activeEnvKey}.json`)
    await expect(service.logout()).resolves.toMatchObject({ kind: 'committed' })
    expect(state.sessionToken).toBeNull()
    expect(
      markerStore.readPendingExternalLogoutIntent(userDataDirectory, activeEnvKey)
    ).toMatchObject({ intent: 'logout-pending' })
    const restarted = new AppServiceClass({
      tokenStore: createIsolatedTokenStore(),
      getUserDataDirectory: () => userDataDirectory,
    })
    await expect(restarted.initialize()).resolves.toEqual({ authenticated: false, me: null })
  })

  it('does not extend the temporary deadline during a public memory-only team transition', async () => {
    const config = await import('../config.js')
    await config.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: 'https://auth.example.test/api',
      rpcProxyBaseUrl: '',
    })
    activeEnvKey = config.getActiveEnvKey()
    const tokenStore = createIsolatedTokenStore()
    const service = new AppServiceClass({
      tokenStore,
      getUserDataDirectory: () => userDataDirectory,
    })
    const switchedUser = { ...user, teamId: 'team-2', teamName: 'Team 2' }
    const initialToken = validSessionToken(Math.floor(Date.now() / 1000) + 3600)
    const switchedToken = validSessionToken(Math.floor(Date.now() / 1000) + 7200)
    const authClient = (
      service as unknown as {
        authClient: {
          passwordLogin: (email: string, password: string) => Promise<unknown>
          switchTeam: (token: string, teamId: string) => Promise<unknown>
          getMe: (token: string) => Promise<typeof user>
        }
      }
    ).authClient
    vi.spyOn(authClient, 'passwordLogin').mockResolvedValue({ token: initialToken, me: user })
    vi.spyOn(authClient, 'switchTeam').mockResolvedValue({ token: switchedToken })
    vi.spyOn(authClient, 'getMe').mockImplementation(async token =>
      token === switchedToken ? switchedUser : user
    )
    await expect(service.passwordLogin(user.email, 'synthetic-password')).resolves.toMatchObject({
      authenticated: true,
      sessionMode: 'temporary',
      me: user,
    })
    const originalDeadline = (service as unknown as { memoryOnlySession: { expiresAt: number } })
      .memoryOnlySession.expiresAt

    await expect(service.switchTeam('team-2')).resolves.toMatchObject({
      authenticated: true,
      sessionMode: 'temporary',
      me: switchedUser,
    })

    expect(
      (service as unknown as { memoryOnlySession: { expiresAt: number } }).memoryOnlySession
        .expiresAt
    ).toBe(originalDeadline)
    await service.logout()
  })

  it('does not use an RPC token returned after the temporary session expires', async () => {
    const service = new AppServiceClass({
      tokenStore: createIsolatedTokenStore(),
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
      tokenStore: createIsolatedTokenStore(),
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
      tokenStore: createIsolatedTokenStore(),
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
    ).toMatchObject({ intent: 'acceptance-pending' })
    await expectMemoryOnlyRestartFence()
  })

  it('signs out before an asynchronous GFS drain and ignores stale temporary expiry', async () => {
    const service = new AppServiceClass({
      tokenStore: createIsolatedTokenStore(),
      getUserDataDirectory: () => userDataDirectory,
    })
    const internals = service as unknown as {
      installAuthenticatedLogin: (result: { token: string; me: typeof user }) => Promise<unknown>
      memoryOnlySession: { expiresAt: number } | undefined
      suspendDesktopGfsUploadsForAuthBoundary: () => Promise<void>
      sessionToken: string | null
      me: typeof user | null
    }
    await internals.installAuthenticatedLogin({ token: validSessionToken(), me: user })
    expect(internals.memoryOnlySession).toBeDefined()

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
    expect(internals.sessionToken).toBeNull()
    expect(internals.me).toBeNull()
    expect(internals.memoryOnlySession).toBeUndefined()
    expect(service.checkTemporarySessionExpiry()).toBe(false)
    releaseDrain()

    await expect(logout).resolves.toMatchObject({ kind: 'committed' })
    expect(suspension).toHaveBeenCalledOnce()
    expect(
      markerStore.readPendingExternalLogoutIntent(userDataDirectory, activeEnvKey)
    ).toMatchObject({ intent: 'logout-pending' })
  })

  it('rejects a token-bearing request before dispatch when the temporary lease has expired', async () => {
    const notifySessionExpired = vi.fn()
    const service = new AppServiceClass({
      tokenStore: createIsolatedTokenStore(),
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
    const requestContext = (service as any).sessionAuthority.captureSessionRequestContext(token)
    internals.memoryOnlySession!.expiresAt = Date.now() - 1
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { requestJson } = await import('../httpClient.js')

    const { runWithSessionRequestContext } = await import('../httpClient.js')
    await expect(
      runWithSessionRequestContext(requestContext, () =>
        requestJson('GET', 'https://api.example.test/protected', { token })
      )
    ).rejects.toThrow('Temporary session expired')

    expect(fetchMock).not.toHaveBeenCalled()
    expect(internals.sessionToken).toBeNull()
    expect(notifySessionExpired).toHaveBeenCalledOnce()
    expect(
      markerStore.readPendingExternalLogoutIntent(userDataDirectory, activeEnvKey)
    ).toMatchObject({ intent: 'acceptance-pending' })
    await internals.memoryOnlySessionTermination
    await expectMemoryOnlyRestartFence()
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
    const tokenStore = createIsolatedTokenStore()
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
