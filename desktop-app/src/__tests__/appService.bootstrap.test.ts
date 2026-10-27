import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AppService } from '../appService.js'
import type { TokenStore } from '../tokenStore.js'

const credentialFixture = vi.hoisted(() => ({
  directory: `${process.cwd()}/.uninitialized-bootstrap-fixture`,
  safeStorageAvailable: false,
}))
vi.mock('electron', () => ({
  app: {
    getPath: () => credentialFixture.directory,
    isReady: () => true,
    isPackaged: false,
  },
  safeStorage: {
    isEncryptionAvailable: () => credentialFixture.safeStorageAvailable,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
    decryptString: (value: Buffer) => value.toString().replace(/^encrypted:/, ''),
  },
}))

// The chat store binds to the filesystem (Electron userData). Mock it so
// passwordLogin can be asserted to bind the env-scoped store without touching
// real directories.
vi.mock('../chatStoreBinding.js', async () => {
  const { createChatStoreBindingMock } = await import('../../testSupport/chatStoreBindingMock.js')
  return createChatStoreBindingMock()
})

describe('AppService invitation configuration lookup', () => {
  const originalConfigPath = process.env.CLERUM_DESKTOP_CONFIG_PATH
  const originalExternalRestApiBaseUrl = process.env.EXTERNAL_REST_API_BASE_URL
  const originalRpcProxyBaseUrl = process.env.RPC_PROXY_BASE_URL
  const originalProfileUiBaseUrl = process.env.PROFILE_UI_BASE_URL
  const tempDirs = new Set<string>()

  function authenticatedToken(userId: string): string {
    const payload = Buffer.from(
      JSON.stringify({ sub: userId, exp: Math.floor(Date.now() / 1000) + 60 * 60 })
    ).toString('base64url')
    return `header.${payload}.signature`
  }

  async function createTempConfigPath(prefix: string): Promise<string> {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`))
    tempDirs.add(tempDir)
    credentialFixture.directory = tempDir
    return path.join(tempDir, 'config.json')
  }

  async function createIsolatedTokenStore(configPath: string): Promise<TokenStore> {
    const { TokenStore } = await import('../tokenStore.js')
    return new TokenStore({ isolatedUserDataPath: path.dirname(configPath) })
  }

  async function acceptCurrentFormatSession(
    configPath: string,
    tokenStore: TokenStore
  ): Promise<{ token: string; me: Record<string, unknown> }> {
    const { AppService } = await import('../appService.js')
    const token = authenticatedToken('user-1')
    const me = {
      id: 'user-1',
      email: 'user@example.com',
      name: null,
      picture: null,
      teamId: 'team-1',
      teamName: 'Marketing',
      role: 'member',
    }
    const producer = new AppService({
      tokenStore,
      getUserDataDirectory: () => path.dirname(configPath),
    })
    const mutableProducer = producer as unknown as {
      authClient: {
        passwordLogin: ReturnType<typeof vi.fn>
        getMe: ReturnType<typeof vi.fn>
      }
    }
    mutableProducer.authClient = {
      passwordLogin: vi.fn().mockResolvedValue({ token, me }),
      getMe: vi.fn().mockResolvedValue(me),
    }
    await (producer as AppService).passwordLogin(me.email, 'synthetic-password')
    return { token, me }
  }

  afterEach(async () => {
    credentialFixture.safeStorageAvailable = false
    if (originalConfigPath === undefined) {
      delete process.env.CLERUM_DESKTOP_CONFIG_PATH
    } else {
      process.env.CLERUM_DESKTOP_CONFIG_PATH = originalConfigPath
    }
    if (originalExternalRestApiBaseUrl === undefined) {
      delete process.env.EXTERNAL_REST_API_BASE_URL
    } else {
      process.env.EXTERNAL_REST_API_BASE_URL = originalExternalRestApiBaseUrl
    }
    if (originalRpcProxyBaseUrl === undefined) {
      delete process.env.RPC_PROXY_BASE_URL
    } else {
      process.env.RPC_PROXY_BASE_URL = originalRpcProxyBaseUrl
    }
    if (originalProfileUiBaseUrl === undefined) {
      delete process.env.PROFILE_UI_BASE_URL
    } else {
      process.env.PROFILE_UI_BASE_URL = originalProfileUiBaseUrl
    }
    vi.resetModules()
    await Promise.all(
      [...tempDirs].map(tempDir => fs.rm(tempDir, { recursive: true, force: true }))
    )
    tempDirs.clear()
  })

  it('accepts terminal-dot discovery when the canonical REST endpoint matches', async () => {
    const configPath = await createTempConfigPath('clerum-desktop-config')
    process.env.CLERUM_DESKTOP_CONFIG_PATH = configPath
    delete process.env.EXTERNAL_REST_API_BASE_URL
    delete process.env.RPC_PROXY_BASE_URL
    delete process.env.PROFILE_UI_BASE_URL
    vi.resetModules()

    const [
      { AppService },
      { config, getActiveLegacyRestOnlyEnvKey, isDesktopRuntimeConfigured, resolveEnvKey },
    ] = await Promise.all([import('../appService.js'), import('../config.js')])
    const { prepareChatStoreBindingForUser, requireChatStore } =
      await import('../chatStoreBinding.js')

    const service = new AppService({
      getUserDataDirectory: () => path.dirname(configPath),
    }) as unknown as {
      authClient: {
        passwordLogin: ReturnType<typeof vi.fn>
        getMe: ReturnType<typeof vi.fn>
        getDesktopEnvironment: ReturnType<typeof vi.fn>
      }
      memberRegistrationServiceClient: { completeDesktopSetup: ReturnType<typeof vi.fn> }
      tokenStore: TokenStore
      rpcTokenManager: { clear: ReturnType<typeof vi.fn> }
      completeDesktopSetup: (email: string, authorizationToken: string) => Promise<unknown>
      passwordLogin: (email: string, password: string) => Promise<unknown>
    }

    service.memberRegistrationServiceClient = {
      completeDesktopSetup: vi.fn().mockResolvedValue({
        valid: true,
        email: 'user@example.com',
        externalRestApiBaseUrl: 'https://api.example.com',
        rpcProxyBaseUrl: 'https://rpc.example.com',
        appName: 'Evenfire',
      }),
    } as never
    service.authClient = {
      getDesktopEnvironment: vi.fn().mockResolvedValue({
        externalRestApiBaseUrl: 'https://api.example.com.',
        rpcProxyBaseUrl: 'https://rpc.example.com',
        appName: 'Evenfire',
      }),
      passwordLogin: vi.fn().mockResolvedValue({
        token: authenticatedToken('user-1'),
        me: {
          id: 'user-1',
          email: 'user@example.com',
          name: null,
          picture: null,
          teamId: 'team-1',
          teamName: 'Marketing',
          role: 'member',
        },
      }),
      getMe: vi.fn().mockResolvedValue({
        id: 'user-1',
        email: 'user@example.com',
        name: null,
        picture: null,
        teamId: 'team-1',
        teamName: 'Marketing',
        role: 'member',
      }),
    } as never
    service.tokenStore = await createIsolatedTokenStore(configPath)
    service.rpcTokenManager = {
      clear: vi.fn(),
    } as never

    await service.completeDesktopSetup('user@example.com', 'setup-token')

    expect(config.externalRestApiBaseUrl).toBe('https://api.example.com')
    expect(config.rpcProxyBaseUrl).toBe('https://rpc.example.com')

    expect(service.memberRegistrationServiceClient.completeDesktopSetup).toHaveBeenCalledWith(
      'user@example.com',
      'setup-token'
    )
    expect(service.authClient.getDesktopEnvironment).toHaveBeenCalled()
    expect(isDesktopRuntimeConfigured()).toBe(true)

    const result = await service.passwordLogin('user@example.com', 'password123')

    expect(service.authClient.passwordLogin).toHaveBeenCalledWith('user@example.com', 'password123')
    expect(result).toMatchObject({ authenticated: true, me: { email: 'user@example.com' } })
    // The env-scoped chat store must be bound after a password login, or every
    // chat:* IPC throws "Not authenticated" until something else re-binds.
    expect(prepareChatStoreBindingForUser).toHaveBeenCalledWith(
      'user-1',
      resolveEnvKey('https://api.example.com', 'https://rpc.example.com'),
      { legacyEnvKeys: [getActiveLegacyRestOnlyEnvKey()], teamId: 'team-1' }
    )
    expect(requireChatStore().getAuthorityScope()).toEqual({
      environmentKey: resolveEnvKey('https://api.example.com', 'https://rpc.example.com'),
      userId: 'user-1',
      teamId: 'team-1',
    })
    expect(config.externalRestApiBaseUrl).toBe('https://api.example.com')
    expect(config.rpcProxyBaseUrl).toBe('https://rpc.example.com')
    expect(config.desktopProfileUiBaseUrl).toBe('https://profile.example.com')

    const persisted = JSON.parse(await fs.readFile(configPath, 'utf8')) as {
      externalRestApiBaseUrl: string
      rpcProxyBaseUrl: string
      appName: string
    }
    expect(persisted).toEqual({
      externalRestApiBaseUrl: 'https://api.example.com',
      rpcProxyBaseUrl: 'https://rpc.example.com',
      appName: 'Evenfire',
    })
  })

  it('does not save RPC when dotted discovery names a different REST endpoint', async () => {
    const configPath = await createTempConfigPath('clerum-desktop-config-mismatched-discovery')
    process.env.CLERUM_DESKTOP_CONFIG_PATH = configPath
    delete process.env.EXTERNAL_REST_API_BASE_URL
    delete process.env.RPC_PROXY_BASE_URL
    delete process.env.PROFILE_UI_BASE_URL
    vi.resetModules()

    const [{ AppService }, { config }] = await Promise.all([
      import('../appService.js'),
      import('../config.js'),
    ])
    const service = new AppService({
      getUserDataDirectory: () => path.dirname(configPath),
    }) as unknown as {
      authClient: { getDesktopEnvironment: ReturnType<typeof vi.fn> }
      memberRegistrationServiceClient: { completeDesktopSetup: ReturnType<typeof vi.fn> }
      completeDesktopSetup: (email: string, authorizationToken: string) => Promise<unknown>
    }

    service.memberRegistrationServiceClient = {
      completeDesktopSetup: vi.fn().mockResolvedValue({
        valid: true,
        email: 'user@example.com',
        externalRestApiBaseUrl: 'https://api.example.com/confirmed',
        rpcProxyBaseUrl: '',
        appName: 'Evenfire',
      }),
    } as never
    service.authClient = {
      getDesktopEnvironment: vi.fn().mockResolvedValue({
        externalRestApiBaseUrl: 'https://api.example.com./different',
        rpcProxyBaseUrl: 'https://rpc.example.com',
        appName: 'Discovered',
      }),
    } as never

    await service.completeDesktopSetup('user@example.com', 'setup-token')

    expect(service.authClient.getDesktopEnvironment).toHaveBeenCalledOnce()
    expect(config.externalRestApiBaseUrl).toBe('https://api.example.com/confirmed')
    expect(config.rpcProxyBaseUrl).toBe('')

    const persisted = JSON.parse(await fs.readFile(configPath, 'utf8')) as {
      externalRestApiBaseUrl: string
      rpcProxyBaseUrl: string
      appName: string
    }
    expect(persisted).toEqual({
      externalRestApiBaseUrl: 'https://api.example.com/confirmed',
      rpcProxyBaseUrl: '',
      appName: 'Evenfire',
    })
  })

  it('does not contact member-registration-service when runtime config is already set', async () => {
    const configPath = await createTempConfigPath('clerum-desktop-config-already-set')
    process.env.EXTERNAL_REST_API_BASE_URL = 'https://api.example.com'
    process.env.RPC_PROXY_BASE_URL = 'https://rpc.example.com'
    delete process.env.PROFILE_UI_BASE_URL
    vi.resetModules()

    const { AppService } = await import('../appService.js')
    const service = new AppService({
      getUserDataDirectory: () => path.dirname(configPath),
    }) as unknown as {
      authClient: {
        passwordLogin: ReturnType<typeof vi.fn>
        getMe: ReturnType<typeof vi.fn>
      }
      memberRegistrationServiceClient: { completeDesktopSetup: ReturnType<typeof vi.fn> }
      tokenStore: TokenStore
      rpcTokenManager: { clear: ReturnType<typeof vi.fn> }
      passwordLogin: (email: string, password: string) => Promise<unknown>
    }

    service.memberRegistrationServiceClient = {
      completeDesktopSetup: vi.fn(),
    } as never
    service.authClient = {
      passwordLogin: vi.fn().mockResolvedValue({
        token: authenticatedToken('user-1'),
        me: {
          id: 'user-1',
          email: 'user@example.com',
          name: null,
          picture: null,
          teamId: 'team-1',
          teamName: 'Marketing',
          role: 'member',
        },
      }),
      getMe: vi.fn().mockResolvedValue({
        id: 'user-1',
        email: 'user@example.com',
        name: null,
        picture: null,
        teamId: 'team-1',
        teamName: 'Marketing',
        role: 'member',
      }),
    } as never
    service.tokenStore = await createIsolatedTokenStore(configPath)
    service.rpcTokenManager = {
      clear: vi.fn(),
    } as never

    await service.passwordLogin('user@example.com', 'password123')

    expect(service.memberRegistrationServiceClient.completeDesktopSetup).not.toHaveBeenCalled()
    expect(service.authClient.passwordLogin).toHaveBeenCalledWith('user@example.com', 'password123')
  })

  it('does not repeat a failed startup restore before the login screen can paint', async () => {
    const configPath = await createTempConfigPath('clerum-desktop-restore-local')
    await fs.writeFile(
      configPath,
      JSON.stringify({
        externalRestApiBaseUrl: 'http://127.0.0.1:8091',
        rpcProxyBaseUrl: 'http://127.0.0.1:8094',
        appName: 'Localhost',
      })
    )
    process.env.CLERUM_DESKTOP_CONFIG_PATH = configPath
    process.env.EXTERNAL_REST_API_BASE_URL = 'http://127.0.0.1:8091'
    process.env.RPC_PROXY_BASE_URL = 'http://127.0.0.1:8094'
    delete process.env.PROFILE_UI_BASE_URL
    vi.resetModules()

    let now = 1_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const [{ AppService }, { getActiveEnvKey }] = await Promise.all([
      import('../appService.js'),
      import('../config.js'),
    ])
    credentialFixture.safeStorageAvailable = true
    const tokenStore = await createIsolatedTokenStore(configPath)
    credentialFixture.safeStorageAvailable = true
    await acceptCurrentFormatSession(configPath, tokenStore)
    const clearSessionToken = vi.spyOn(tokenStore, 'clearSessionToken')
    const service = new AppService({
      tokenStore,
      getUserDataDirectory: () => path.dirname(configPath),
    }) as unknown as {
      authClient: { getMe: ReturnType<typeof vi.fn> }
      tokenStore: TokenStore
      rpcTokenManager: { clear: ReturnType<typeof vi.fn> }
      initialize: () => Promise<unknown>
      getSessionState: () => Promise<unknown>
    }

    service.authClient = {
      getMe: vi.fn().mockRejectedValueOnce(new Error('fetch failed')).mockResolvedValue({
        id: 'user-1',
        email: 'user@example.com',
        name: null,
        picture: null,
        teamId: 'team-1',
        teamName: null,
        role: null,
      }),
    } as never
    service.rpcTokenManager = {
      clear: vi.fn(),
    } as never

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await expect(service.initialize()).resolves.toEqual({ authenticated: false, me: null })

      expect(clearSessionToken).not.toHaveBeenCalled()

      // Source verification may reread the selected credential. A cached
      // failed restore must not start another storage/authentication attempt.
      await expect(service.getSessionState()).resolves.toEqual({
        authenticated: false,
        me: null,
      })
      expect(service.authClient.getMe).toHaveBeenCalledTimes(1)

      now += 5_001
      await expect(service.getSessionState()).resolves.toMatchObject({
        authenticated: true,
        me: { id: 'user-1' },
      })
      expect(service.authClient.getMe).toHaveBeenCalledTimes(2)
    } finally {
      warn.mockRestore()
      nowSpy.mockRestore()
    }
  })

  it('fails closed when the saved-token store cannot be read', async () => {
    const configPath = await createTempConfigPath('clerum-desktop-token-read-failure')
    process.env.EXTERNAL_REST_API_BASE_URL = 'https://api.example.com'
    process.env.RPC_PROXY_BASE_URL = 'https://rpc.example.com'
    vi.resetModules()

    const [{ AppService }, { getActiveEnvKey }] = await Promise.all([
      import('../appService.js'),
      import('../config.js'),
    ])
    const getMe = vi.fn()
    const tokenStore = await createIsolatedTokenStore(configPath)
    credentialFixture.safeStorageAvailable = true
    await acceptCurrentFormatSession(configPath, tokenStore)
    const readSessionTokenCandidate = vi
      .spyOn(tokenStore, 'readSessionTokenCandidate')
      .mockRejectedValue(new Error('fixture-session-read unavailable'))
    const service = new AppService({
      tokenStore,
      getUserDataDirectory: () => path.dirname(configPath),
    }) as unknown as {
      authClient: { getMe: ReturnType<typeof vi.fn> }
      tokenStore: TokenStore
      rpcTokenManager: { clear: ReturnType<typeof vi.fn> }
      getSessionState: () => Promise<unknown>
    }
    service.authClient = { getMe } as never
    service.rpcTokenManager = { clear: vi.fn() } as never

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await expect(service.getSessionState()).resolves.toEqual({
        authenticated: false,
        me: null,
      })
    } finally {
      warn.mockRestore()
    }
    expect(getMe).not.toHaveBeenCalled()
    expect(readSessionTokenCandidate).toHaveBeenCalledOnce()
  })

  it('accepts logout at the durable LP boundary while exact-source cleanup is pending', async () => {
    process.env.EXTERNAL_REST_API_BASE_URL = 'https://api.example.com'
    process.env.RPC_PROXY_BASE_URL = 'https://rpc.example.com'
    const configPath = await createTempConfigPath('clerum-desktop-logout-failure')
    vi.resetModules()

    const [{ AppService }, { getActiveEnvKey }, markerStore, { SessionAuthorityRecordRepository }] =
      await Promise.all([
        import('../appService.js'),
        import('../config.js'),
        import('../pendingExternalLogout.js'),
        import('../sessionAuthorityRecord.js'),
      ])
    const reportFailure = vi.fn()
    const tokenStore = await createIsolatedTokenStore(configPath)
    credentialFixture.safeStorageAvailable = true
    const strictClear = vi.spyOn(tokenStore, 'clearSessionTokenStrictly')
    vi.spyOn(tokenStore, 'deleteSessionCredentialSourceIfUnselectedWithProof').mockRejectedValue(
      new Error('fixture-token cleanup unavailable')
    )
    const service = new AppService({
      tokenStore,
      getUserDataDirectory: () => path.dirname(configPath),
      reportDeferredLogoutFailure: reportFailure,
    }) as unknown as {
      tokenStore: TokenStore
      rpcTokenManager: { clear: ReturnType<typeof vi.fn> }
      logoutInProgress: boolean
      sessionToken: string | null
      me: unknown
      suspendDesktopGfsUploadsForAuthBoundary: ReturnType<typeof vi.fn>
      sessionAuthorityCleanupInFlight: Promise<void> | null
      authClient: {
        passwordLogin: ReturnType<typeof vi.fn>
        getMe: ReturnType<typeof vi.fn>
      }
      passwordLogin: (email: string, password: string) => Promise<unknown>
      logout: () => Promise<{ kind: string; sessionGeneration: number }>
      getSessionGeneration: () => number
    }
    service.tokenStore = tokenStore
    service.rpcTokenManager = { clear: vi.fn() } as never
    service.suspendDesktopGfsUploadsForAuthBoundary = vi.fn().mockResolvedValue(undefined)
    const token = authenticatedToken('user-1')
    const me = {
      id: 'user-1',
      email: 'user@example.com',
      name: null,
      picture: null,
      teamId: 'team-1',
      teamName: 'Marketing',
      role: 'member',
    }
    service.authClient = {
      passwordLogin: vi.fn().mockResolvedValue({ token, me }),
      getMe: vi.fn().mockResolvedValue(me),
    }
    await service.passwordLogin(me.email, 'synthetic-password')
    const generationBeforeLogout = service.getSessionGeneration()
    await expect(service.logout()).resolves.toMatchObject({
      kind: 'committed',
      sessionGeneration: generationBeforeLogout + 1,
    })
    expect(strictClear).not.toHaveBeenCalled()
    expect(
      markerStore.readPendingExternalLogoutIntent(path.dirname(configPath), getActiveEnvKey())
    ).toEqual({
      intent: 'logout-pending',
    })
    expect(service.sessionToken).toBeNull()
    expect(service.me).toBeNull()
    await service.sessionAuthorityCleanupInFlight
    expect(
      service.tokenStore.deleteSessionCredentialSourceIfUnselectedWithProof
    ).toHaveBeenCalledOnce()
    expect(reportFailure).toHaveBeenCalledOnce()
    expect(service.logoutInProgress).toBe(false)
    const storageScope = await tokenStore.createSessionAuthorityStorageScope()
    const authority = new SessionAuthorityRecordRepository(
      storageScope,
      getActiveEnvKey(),
      tokenStore
    ).observe()
    expect(authority.status).toBe('observed')
    if (authority.status === 'observed') {
      expect(authority.record.frame.mode).toBe('logged-out')
      expect(authority.record.cleanupDebts).toHaveLength(1)
      expect(authority.record.cleanupDebts[0]?.source.format).toBe('v1')
    }
  })

  it('shares one saved-session restore across concurrent session-state requests', async () => {
    const configPath = await createTempConfigPath('clerum-desktop-restore-single-flight')
    await fs.writeFile(
      configPath,
      JSON.stringify({
        externalRestApiBaseUrl: 'http://127.0.0.1:8091',
        rpcProxyBaseUrl: 'http://127.0.0.1:8094',
        appName: 'Localhost',
      })
    )
    process.env.CLERUM_DESKTOP_CONFIG_PATH = configPath
    process.env.EXTERNAL_REST_API_BASE_URL = 'http://127.0.0.1:8091'
    process.env.RPC_PROXY_BASE_URL = 'http://127.0.0.1:8094'
    vi.resetModules()
    const [{ AppService }, chatStoreBinding, { getActiveEnvKey }] = await Promise.all([
      import('../appService.js'),
      import('../chatStoreBinding.js'),
      import('../config.js'),
    ])
    chatStoreBinding.__setChatStoreBaseDirForTests(path.dirname(configPath))
    const me = {
      id: 'user-1',
      email: 'user@example.com',
      name: null,
      picture: null,
      teamId: 'team-1',
      teamName: 'Marketing',
      role: 'member',
    }
    let resolveMe!: (value: typeof me) => void
    const pendingMe = new Promise<typeof me>(resolve => {
      resolveMe = resolve
    })
    const tokenStore = await createIsolatedTokenStore(configPath)
    credentialFixture.safeStorageAvailable = true
    await acceptCurrentFormatSession(configPath, tokenStore)
    const getMe = vi.fn().mockReturnValue(pendingMe)
    const service = new AppService({
      tokenStore,
      getUserDataDirectory: () => path.dirname(configPath),
    }) as unknown as {
      authClient: { getMe: ReturnType<typeof vi.fn> }
      tokenStore: TokenStore
      rpcTokenManager: { clear: ReturnType<typeof vi.fn> }
      initialize: () => Promise<unknown>
      getSessionState: () => Promise<unknown>
    }
    service.authClient = { getMe } as never
    service.rpcTokenManager = { clear: vi.fn() } as never

    const first = service.initialize()
    const second = service.getSessionState()
    resolveMe(me)

    await expect(Promise.all([first, second])).resolves.toEqual([
      { authenticated: true, me },
      { authenticated: true, me },
    ])
    // Both callers share one authentication attempt; the result is observable
    // at the public authentication boundary rather than through a legacy reader.
    expect(getMe).toHaveBeenCalledTimes(1)
  })

  it('does not claim durable logout or advance ownership when no session was accepted', async () => {
    const configPath = await createTempConfigPath('clerum-desktop-restore-after-logout')
    await fs.writeFile(
      configPath,
      JSON.stringify({
        externalRestApiBaseUrl: 'https://api.example.com',
        rpcProxyBaseUrl: 'https://rpc.example.com',
        appName: 'Example',
      })
    )
    process.env.CLERUM_DESKTOP_CONFIG_PATH = configPath
    process.env.EXTERNAL_REST_API_BASE_URL = 'https://api.example.com'
    process.env.RPC_PROXY_BASE_URL = 'https://rpc.example.com'
    vi.resetModules()

    const [{ AppService }, { getActiveEnvKey }] = await Promise.all([
      import('../appService.js'),
      import('../config.js'),
    ])
    const service = new AppService() as unknown as {
      getSessionGeneration: () => number
      getSessionState: () => Promise<unknown>
      logout: () => Promise<{ kind: 'committed' | 'not-committed'; sessionGeneration: number }>
      savedSessionRestoreAttemptedEnvKey: string | null
      savedSessionRestoreAttemptedAtMs: number
      tokenStore: TokenStore
    }
    const tokenStore = await createIsolatedTokenStore(configPath)
    service.tokenStore = tokenStore
    vi.spyOn(tokenStore, 'clearSessionTokenStrictly').mockResolvedValue({
      keytarAvailable: true,
      keytarDisabled: false,
      keytarDisposition: 'available',
    })

    const logoutOutcome = await service.logout()
    service.savedSessionRestoreAttemptedEnvKey = null
    service.savedSessionRestoreAttemptedAtMs = 0

    await expect(service.getSessionState()).resolves.toEqual({ authenticated: false, me: null })
    expect(logoutOutcome.kind).toBe('not-committed')
    expect(service.getSessionGeneration()).toBe(logoutOutcome.sessionGeneration)
  })

  it('clears a saved token when startup session restore is rejected by the API', async () => {
    const configPath = await createTempConfigPath('clerum-desktop-restore-api')
    await fs.writeFile(
      configPath,
      JSON.stringify({
        externalRestApiBaseUrl: 'https://api.example.com',
        rpcProxyBaseUrl: 'https://rpc.example.com',
        appName: 'Example',
      })
    )
    process.env.CLERUM_DESKTOP_CONFIG_PATH = configPath
    process.env.EXTERNAL_REST_API_BASE_URL = 'https://api.example.com'
    process.env.RPC_PROXY_BASE_URL = 'https://rpc.example.com'
    delete process.env.PROFILE_UI_BASE_URL
    vi.resetModules()

    const [{ AppService }, { getActiveEnvKey }, { ApiError }] = await Promise.all([
      import('../appService.js'),
      import('../config.js'),
      import('../httpClient.js'),
    ])
    credentialFixture.safeStorageAvailable = true
    const tokenStore = await createIsolatedTokenStore(configPath)
    await tokenStore.setSessionToken('stored-token', getActiveEnvKey())
    const service = new AppService({
      tokenStore,
      getUserDataDirectory: () => path.dirname(configPath),
    }) as unknown as {
      authClient: { getMe: ReturnType<typeof vi.fn> }
      tokenStore: TokenStore
      rpcTokenManager: { clear: ReturnType<typeof vi.fn> }
      initialize: () => Promise<unknown>
    }

    service.authClient = {
      getMe: vi.fn().mockRejectedValue(new ApiError('401 Unauthorized', 401, '')),
    } as never
    service.rpcTokenManager = {
      clear: vi.fn(),
    } as never

    await expect(service.initialize()).resolves.toEqual({ authenticated: false, me: null })

    expect(await tokenStore.getSessionToken(getActiveEnvKey())).toBe('stored-token')
    expect(service.authClient.getMe).not.toHaveBeenCalled()
  })

  it('clears a saved token when startup session restore is forbidden', async () => {
    const configPath = await createTempConfigPath('clerum-desktop-restore-forbidden')
    await fs.writeFile(
      configPath,
      JSON.stringify({
        externalRestApiBaseUrl: 'https://api.example.com',
        rpcProxyBaseUrl: 'https://rpc.example.com',
        appName: 'Example',
      })
    )
    process.env.CLERUM_DESKTOP_CONFIG_PATH = configPath
    process.env.EXTERNAL_REST_API_BASE_URL = 'https://api.example.com'
    process.env.RPC_PROXY_BASE_URL = 'https://rpc.example.com'
    delete process.env.PROFILE_UI_BASE_URL
    vi.resetModules()

    const [{ AppService }, { ApiError }, { getActiveEnvKey }] = await Promise.all([
      import('../appService.js'),
      import('../httpClient.js'),
      import('../config.js'),
    ])
    credentialFixture.safeStorageAvailable = true
    const tokenStore = await createIsolatedTokenStore(configPath)
    await tokenStore.setSessionToken('stored-token', getActiveEnvKey())
    const service = new AppService({
      tokenStore,
      getUserDataDirectory: () => path.dirname(configPath),
    }) as unknown as {
      authClient: { getMe: ReturnType<typeof vi.fn> }
      tokenStore: TokenStore
      rpcTokenManager: { clear: ReturnType<typeof vi.fn> }
      initialize: () => Promise<unknown>
    }

    service.authClient = {
      getMe: vi.fn().mockRejectedValue(new ApiError('403 Forbidden', 403, '')),
    } as never
    service.rpcTokenManager = {
      clear: vi.fn(),
    } as never

    await expect(service.initialize()).resolves.toEqual({ authenticated: false, me: null })

    expect(await tokenStore.getSessionToken(getActiveEnvKey())).toBe('stored-token')
    expect(service.authClient.getMe).not.toHaveBeenCalled()
  })

  it('persists a manually saved runtime environment', async () => {
    const configPath = await createTempConfigPath('clerum-desktop-manual-config')
    process.env.CLERUM_DESKTOP_CONFIG_PATH = configPath
    delete process.env.EXTERNAL_REST_API_BASE_URL
    delete process.env.RPC_PROXY_BASE_URL
    delete process.env.PROFILE_UI_BASE_URL
    vi.resetModules()

    const [{ AppService }, { config, isDesktopRuntimeConfigured }] = await Promise.all([
      import('../appService.js'),
      import('../config.js'),
    ])

    const service = new AppService() as unknown as {
      saveRuntimeConfig: (next: {
        externalRestApiBaseUrl: string
        rpcProxyBaseUrl: string
        appName?: string
      }) => Promise<unknown>
      deleteRuntimeConfig: (optionId: string) => Promise<unknown>
    }

    const state = await service.saveRuntimeConfig({
      externalRestApiBaseUrl: 'https://example.com',
      rpcProxyBaseUrl: 'https://example.com',
      appName: 'Production',
    })

    expect(isDesktopRuntimeConfigured()).toBe(true)
    expect(state).toMatchObject({
      configured: true,
      activeOptionId: 'custom-file',
    })
    expect(config.externalRestApiBaseUrl).toBe('https://example.com')
    expect(config.rpcProxyBaseUrl).toBe('https://example.com')
    expect(config.desktopProfileUiBaseUrl).toBe('https://example.com')
    expect(config.appName).toBe('Production')

    const persisted = JSON.parse(await fs.readFile(configPath, 'utf8')) as {
      externalRestApiBaseUrl: string
      rpcProxyBaseUrl: string
      appName: string
    }
    expect(persisted).toEqual({
      externalRestApiBaseUrl: 'https://example.com',
      rpcProxyBaseUrl: 'https://example.com',
      appName: 'Production',
    })

    const deletedState = await service.deleteRuntimeConfig('custom-file')

    expect(deletedState).toMatchObject({
      configured: false,
      activeOptionId: null,
    })
    await expect(fs.access(configPath)).rejects.toThrow()
  })
})
