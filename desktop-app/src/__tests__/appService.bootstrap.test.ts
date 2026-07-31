import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// The chat store binds to the filesystem (Electron userData). Mock it so
// passwordLogin can be asserted to bind the env-scoped store without touching
// real directories.
vi.mock('../chatStoreBinding.js', () => ({
  bindChatStoreForUser: vi.fn(),
  unbindChatStore: vi.fn(),
  __setChatStoreBaseDirForTests: vi.fn(),
}))

describe('AppService invitation configuration lookup', () => {
  const originalConfigPath = process.env.CLERUM_DESKTOP_CONFIG_PATH
  const originalExternalRestApiBaseUrl = process.env.EXTERNAL_REST_API_BASE_URL
  const originalRpcProxyBaseUrl = process.env.RPC_PROXY_BASE_URL
  const originalProfileUiBaseUrl = process.env.PROFILE_UI_BASE_URL
  const tempDirs = new Set<string>()

  async function createTempConfigPath(prefix: string): Promise<string> {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`))
    tempDirs.add(tempDir)
    return path.join(tempDir, 'config.json')
  }

  afterEach(async () => {
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

  it('persists runtime config when desktop setup is completed', async () => {
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
    const { bindChatStoreForUser } = await import('../chatStoreBinding.js')

    const service = new AppService() as unknown as {
      authClient: {
        passwordLogin: ReturnType<typeof vi.fn>
        getDesktopEnvironment: ReturnType<typeof vi.fn>
      }
      memberRegistrationServiceClient: { completeDesktopSetup: ReturnType<typeof vi.fn> }
      tokenStore: { setSessionToken: ReturnType<typeof vi.fn> }
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
        externalRestApiBaseUrl: 'https://api.example.com',
        rpcProxyBaseUrl: 'https://rpc.example.com',
        appName: 'Evenfire',
      }),
      passwordLogin: vi.fn().mockResolvedValue({
        token: 'session-token',
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
    } as never
    service.tokenStore = {
      setSessionToken: vi.fn().mockResolvedValue(undefined),
    } as never
    service.rpcTokenManager = {
      clear: vi.fn(),
    } as never

    await service.completeDesktopSetup('user@example.com', 'setup-token')

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
    expect(bindChatStoreForUser).toHaveBeenCalledWith(
      'user-1',
      resolveEnvKey('https://api.example.com', 'https://rpc.example.com'),
      { legacyEnvKeys: [getActiveLegacyRestOnlyEnvKey()] }
    )
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

  it('does not contact member-registration-service when runtime config is already set', async () => {
    process.env.EXTERNAL_REST_API_BASE_URL = 'https://api.example.com'
    process.env.RPC_PROXY_BASE_URL = 'https://rpc.example.com'
    delete process.env.PROFILE_UI_BASE_URL
    vi.resetModules()

    const { AppService } = await import('../appService.js')
    const service = new AppService() as unknown as {
      authClient: { passwordLogin: ReturnType<typeof vi.fn> }
      memberRegistrationServiceClient: { completeDesktopSetup: ReturnType<typeof vi.fn> }
      tokenStore: { setSessionToken: ReturnType<typeof vi.fn> }
      rpcTokenManager: { clear: ReturnType<typeof vi.fn> }
      passwordLogin: (email: string, password: string) => Promise<unknown>
    }

    service.memberRegistrationServiceClient = {
      completeDesktopSetup: vi.fn(),
    } as never
    service.authClient = {
      passwordLogin: vi.fn().mockResolvedValue({
        token: 'session-token',
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
    } as never
    service.tokenStore = {
      setSessionToken: vi.fn().mockResolvedValue(undefined),
    } as never
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

    const { AppService } = await import('../appService.js')
    const getSessionToken = vi.fn().mockResolvedValue('stored-token')
    const clearSessionToken = vi.fn().mockResolvedValue(undefined)
    const service = new AppService() as unknown as {
      authClient: { getMe: ReturnType<typeof vi.fn> }
      tokenStore: {
        getSessionToken: ReturnType<typeof vi.fn>
        clearSessionToken: ReturnType<typeof vi.fn>
      }
      rpcTokenManager: { clear: ReturnType<typeof vi.fn> }
      initialize: () => Promise<unknown>
      getSessionState: () => Promise<unknown>
    }

    service.authClient = {
      getMe: vi.fn().mockRejectedValue(new Error('fetch failed')),
    } as never
    service.tokenStore = {
      getSessionToken,
      clearSessionToken,
    } as never
    service.rpcTokenManager = {
      clear: vi.fn(),
    } as never

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await expect(service.initialize()).resolves.toEqual({ authenticated: false, me: null })

      expect(clearSessionToken).not.toHaveBeenCalled()

      await expect(service.getSessionState()).resolves.toEqual({
        authenticated: false,
        me: null,
      })
      expect(getSessionToken).toHaveBeenCalledTimes(1)
      expect(service.authClient.getMe).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('fails closed when the saved-token store cannot be read', async () => {
    process.env.EXTERNAL_REST_API_BASE_URL = 'https://api.example.com'
    process.env.RPC_PROXY_BASE_URL = 'https://rpc.example.com'
    vi.resetModules()

    const { AppService } = await import('../appService.js')
    const getMe = vi.fn()
    const service = new AppService() as unknown as {
      authClient: { getMe: ReturnType<typeof vi.fn> }
      tokenStore: {
        getSessionToken: ReturnType<typeof vi.fn>
        clearSessionToken: ReturnType<typeof vi.fn>
      }
      rpcTokenManager: { clear: ReturnType<typeof vi.fn> }
      getSessionState: () => Promise<unknown>
    }
    service.authClient = { getMe } as never
    service.tokenStore = {
      getSessionToken: vi.fn().mockRejectedValue(new Error('keychain unavailable')),
      clearSessionToken: vi.fn(),
    } as never
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
  })

  it('releases the logout guard when clearing the saved token fails', async () => {
    process.env.EXTERNAL_REST_API_BASE_URL = 'https://api.example.com'
    process.env.RPC_PROXY_BASE_URL = 'https://rpc.example.com'
    vi.resetModules()

    const [{ AppService }, { getActiveEnvKey, getActiveLegacyRestOnlyEnvKey }] = await Promise.all([
      import('../appService.js'),
      import('../config.js'),
    ])
    const service = new AppService() as unknown as {
      tokenStore: { clearSessionToken: ReturnType<typeof vi.fn> }
      rpcTokenManager: { clear: ReturnType<typeof vi.fn> }
      logoutInProgress: boolean
      logout: () => Promise<void>
    }
    service.tokenStore = {
      clearSessionToken: vi.fn().mockRejectedValue(new Error('keychain unavailable')),
    } as never
    service.rpcTokenManager = { clear: vi.fn() } as never

    await expect(service.logout()).rejects.toThrow(/keychain unavailable/)
    expect(service.tokenStore.clearSessionToken).toHaveBeenCalledWith(getActiveEnvKey(), {
      legacyEnvKeys: [getActiveLegacyRestOnlyEnvKey()],
    })
    expect(service.logoutInProgress).toBe(false)
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
    vi.doMock('electron', () => ({
      app: {
        getPath: vi.fn(() => path.dirname(configPath)),
        isPackaged: false,
        isReady: vi.fn(() => true),
        setName: vi.fn(),
        setPath: vi.fn(),
      },
    }))

    const [{ AppService }, chatStoreBinding] = await Promise.all([
      import('../appService.js'),
      import('../chatStoreBinding.js'),
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
    const getSessionToken = vi.fn().mockResolvedValue('stored-token')
    const getMe = vi.fn().mockReturnValue(pendingMe)
    const service = new AppService() as unknown as {
      authClient: { getMe: ReturnType<typeof vi.fn> }
      tokenStore: {
        getSessionToken: ReturnType<typeof vi.fn>
        clearSessionToken: ReturnType<typeof vi.fn>
      }
      rpcTokenManager: { clear: ReturnType<typeof vi.fn> }
      initialize: () => Promise<unknown>
      getSessionState: () => Promise<unknown>
    }
    service.authClient = { getMe } as never
    service.tokenStore = {
      getSessionToken,
      clearSessionToken: vi.fn(),
    } as never
    service.rpcTokenManager = { clear: vi.fn() } as never

    const first = service.initialize()
    const second = service.getSessionState()
    resolveMe(me)

    await expect(Promise.all([first, second])).resolves.toEqual([
      { authenticated: true, me },
      { authenticated: true, me },
    ])
    expect(getSessionToken).toHaveBeenCalledTimes(1)
    expect(getMe).toHaveBeenCalledTimes(1)
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

    const [{ AppService }, { resolveEnvKey }, { ApiError }] = await Promise.all([
      import('../appService.js'),
      import('../config.js'),
      import('../httpClient.js'),
    ])
    const clearSessionToken = vi.fn().mockResolvedValue(undefined)
    const service = new AppService() as unknown as {
      authClient: { getMe: ReturnType<typeof vi.fn> }
      tokenStore: {
        getSessionToken: ReturnType<typeof vi.fn>
        clearSessionToken: ReturnType<typeof vi.fn>
      }
      rpcTokenManager: { clear: ReturnType<typeof vi.fn> }
      initialize: () => Promise<unknown>
    }

    service.authClient = {
      getMe: vi.fn().mockRejectedValue(new ApiError('401 Unauthorized', 401, '')),
    } as never
    service.tokenStore = {
      getSessionToken: vi.fn().mockResolvedValue('stored-token'),
      clearSessionToken,
    } as never
    service.rpcTokenManager = {
      clear: vi.fn(),
    } as never

    await expect(service.initialize()).resolves.toEqual({ authenticated: false, me: null })

    expect(clearSessionToken).toHaveBeenCalledWith(
      resolveEnvKey('https://api.example.com', 'https://rpc.example.com'),
      {
        legacyEnvKeys: [resolveEnvKey('https://api.example.com')],
      }
    )
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

    const [{ AppService }, { ApiError }] = await Promise.all([
      import('../appService.js'),
      import('../httpClient.js'),
    ])
    const clearSessionToken = vi.fn().mockResolvedValue(undefined)
    const service = new AppService() as unknown as {
      authClient: { getMe: ReturnType<typeof vi.fn> }
      tokenStore: {
        getSessionToken: ReturnType<typeof vi.fn>
        clearSessionToken: ReturnType<typeof vi.fn>
      }
      rpcTokenManager: { clear: ReturnType<typeof vi.fn> }
      initialize: () => Promise<unknown>
    }

    service.authClient = {
      getMe: vi.fn().mockRejectedValue(new ApiError('403 Forbidden', 403, '')),
    } as never
    service.tokenStore = {
      getSessionToken: vi.fn().mockResolvedValue('stored-token'),
      clearSessionToken,
    } as never
    service.rpcTokenManager = {
      clear: vi.fn(),
    } as never

    await expect(service.initialize()).resolves.toEqual({ authenticated: false, me: null })

    expect(clearSessionToken).toHaveBeenCalled()
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
