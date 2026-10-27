import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { testSessionMe, testSessionTokenWithExpiry } from '../../testSupport/authTestFixtures.js'

const originalConfigPath = process.env.CLERUM_DESKTOP_CONFIG_PATH
const originalAppData = process.env.APPDATA
const originalRestBase = process.env.EXTERNAL_REST_API_BASE_URL
const originalRpcBase = process.env.RPC_PROXY_BASE_URL
let tempDir: string | null = null
let cleanupModules: (() => Promise<void>) | null = null

afterEach(async () => {
  await cleanupModules?.()
  cleanupModules = null
  vi.doUnmock('electron')
  vi.doUnmock('keytar')
  vi.resetModules()
  if (originalConfigPath === undefined) delete process.env.CLERUM_DESKTOP_CONFIG_PATH
  else process.env.CLERUM_DESKTOP_CONFIG_PATH = originalConfigPath
  if (originalAppData === undefined) delete process.env.APPDATA
  else process.env.APPDATA = originalAppData
  if (originalRestBase === undefined) delete process.env.EXTERNAL_REST_API_BASE_URL
  else process.env.EXTERNAL_REST_API_BASE_URL = originalRestBase
  if (originalRpcBase === undefined) delete process.env.RPC_PROXY_BASE_URL
  else process.env.RPC_PROXY_BASE_URL = originalRpcBase
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true })
  tempDir = null
})

describe('AppService RPC discovery restore boundary', () => {
  it('uses the versioned credential namespace when profiles collide in the legacy namespace', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-runtime-legacy-collision-'))
    const userDataDir = path.join(tempDir, 'user-data')
    const runtimeConfigDir = path.join(userDataDir, 'runtime-configs')
    await fs.mkdir(runtimeConfigDir, { recursive: true })
    delete process.env.CLERUM_DESKTOP_CONFIG_PATH
    delete process.env.EXTERNAL_REST_API_BASE_URL
    delete process.env.RPC_PROXY_BASE_URL
    delete process.env.APPDATA

    const activeRest = 'https://api.shared-legacy.example.test'
    const activeRpc = 'https://rpc.active.example.test'
    const siblingRpc = 'https://rpc.sibling.example.test'
    const timestamp = '2026-01-01T00:00:00.000Z'
    await fs.writeFile(
      path.join(runtimeConfigDir, 'index.json'),
      JSON.stringify({
        version: 1,
        activeProfileId: 'active-profile',
        profiles: [
          {
            id: 'active-profile',
            appName: 'Active',
            fileName: 'runtime-config-active.json',
            createdAt: timestamp,
            updatedAt: timestamp,
          },
          {
            id: 'sibling-profile',
            appName: 'Sibling',
            fileName: 'runtime-config-sibling.json',
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ],
      })
    )
    await fs.writeFile(
      path.join(runtimeConfigDir, 'runtime-config-active.json'),
      JSON.stringify({
        externalRestApiBaseUrl: activeRest,
        rpcProxyBaseUrl: activeRpc,
        appName: 'Active',
      })
    )
    await fs.writeFile(
      path.join(runtimeConfigDir, 'runtime-config-sibling.json'),
      JSON.stringify({
        externalRestApiBaseUrl: activeRest,
        rpcProxyBaseUrl: siblingRpc,
        appName: 'Sibling',
      })
    )

    vi.resetModules()
    const keychain = new Map<string, string>()
    const keytar = {
      getPassword: vi.fn(
        async (service: string, account: string) => keychain.get(`${service}::${account}`) ?? null
      ),
      setPassword: vi.fn(async (service: string, account: string, value: string) => {
        keychain.set(`${service}::${account}`, value)
      }),
      deletePassword: vi.fn(async (service: string, account: string) =>
        keychain.delete(`${service}::${account}`)
      ),
    }
    vi.doMock('keytar', () => keytar)
    vi.doMock('electron', () => ({
      app: {
        getPath: vi.fn((name: string) =>
          name === 'appData' ? path.dirname(userDataDir) : userDataDir
        ),
        isPackaged: false,
        isReady: vi.fn(() => true),
        setName: vi.fn(),
        setPath: vi.fn(),
      },
      safeStorage: {
        isEncryptionAvailable: vi.fn(() => true),
        getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret'),
        encryptString: vi.fn((value: string) => Buffer.from(`encrypted:${value}`)),
        decryptString: vi.fn((value: Buffer) => value.toString().replace(/^encrypted:/, '')),
      },
    }))

    const [{ AppService }, runtimeConfig, { TokenStore }, chatStoreBinding] = await Promise.all([
      import('../appService.js'),
      import('../config.js'),
      import('../tokenStore.js'),
      import('../chatStoreBinding.js'),
    ])
    const chatBaseDir = path.join(tempDir, 'chats')
    chatStoreBinding.__setChatStoreBaseDirForTests(chatBaseDir)
    cleanupModules = async () => {
      chatStoreBinding.unbindChatStore()
      chatStoreBinding.__setChatStoreBaseDirForTests(null)
    }

    expect(runtimeConfig.config.externalRestApiBaseUrl).toBe(activeRest)
    expect(runtimeConfig.config.rpcProxyBaseUrl).toBe(activeRpc)
    expect(runtimeConfig.getActiveLegacyEnvKeyInventory()).toEqual({ keys: [], complete: false })
    const tokenStore = new TokenStore()
    const legacyToken = testSessionTokenWithExpiry()
    const candidateToken = testSessionTokenWithExpiry(Date.now() + 2 * 60 * 60 * 1000)
    const legacyEnvKey = runtimeConfig.getActiveLegacyRestOnlyEnvKey()
    await tokenStore.setSessionToken(legacyToken, legacyEnvKey)
    const writeCandidate = vi.spyOn(tokenStore, 'writeSessionTokenCandidate')
    keytar.setPassword.mockClear()
    keytar.getPassword.mockClear()

    const me = testSessionMe()
    const service = new AppService({
      tokenStore,
      getUserDataDirectory: () => userDataDir,
      reportDeferredLogoutFailure: vi.fn(),
    }) as unknown as {
      authClient: {
        passwordLogin: ReturnType<typeof vi.fn>
        getMe: ReturnType<typeof vi.fn>
        getDesktopEnvironment: ReturnType<typeof vi.fn>
      }
      initialize: () => Promise<unknown>
      passwordLogin: (email: string, password: string) => Promise<unknown>
    }
    const passwordLogin = vi.spyOn(service.authClient, 'passwordLogin').mockResolvedValue({
      token: candidateToken,
      me,
    })
    const getMe = vi.spyOn(service.authClient, 'getMe').mockResolvedValue(me)
    vi.spyOn(service.authClient, 'getDesktopEnvironment').mockRejectedValue(
      new Error('runtime discovery unavailable')
    )

    await expect(service.passwordLogin('user@example.test', 'test-password')).resolves.toEqual({
      authenticated: true,
      me,
    })
    expect(passwordLogin).toHaveBeenCalledOnce()
    expect(writeCandidate).toHaveBeenCalledOnce()
    expect(keytar.setPassword).toHaveBeenCalled()
    expect(keychain.values()).toContain(legacyToken)
    expect(keychain.values()).not.toContain(candidateToken)
    expect(getMe).not.toHaveBeenCalledWith(legacyToken)
    expect(chatStoreBinding.requireChatStore()).toBeDefined()
    const activeEnvKey = runtimeConfig.getActiveEnvKey()
    const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
    const accepted = await readSessionAuthoritySourceSelection({ tokenStore, envKey: activeEnvKey })
    expect(accepted.status).toBe('accepted')
    if (accepted.status !== 'accepted') throw new Error('Expected fresh V1 authority')
    expect(accepted.session.token).toBe(candidateToken)
    expect(accepted.session.accepted.record.frame.source).toMatchObject({
      format: 'v1',
      kind: 'keytar',
    })

    const restartedTokenStore = new TokenStore()
    const restarted = new AppService({
      tokenStore: restartedTokenStore,
      getUserDataDirectory: () => userDataDir,
      reportDeferredLogoutFailure: vi.fn(),
    }) as unknown as {
      authClient: {
        getMe: ReturnType<typeof vi.fn>
        getDesktopEnvironment: ReturnType<typeof vi.fn>
      }
      initialize: () => Promise<unknown>
    }
    const restartedGetMe = vi.spyOn(restarted.authClient, 'getMe').mockResolvedValue(me)
    vi.spyOn(restarted.authClient, 'getDesktopEnvironment').mockRejectedValue(
      new Error('runtime discovery unavailable')
    )
    await expect(restarted.initialize()).resolves.toEqual({ authenticated: true, me })
    expect(restartedGetMe).toHaveBeenCalledWith(candidateToken)
    expect(restartedGetMe).not.toHaveBeenCalledWith(legacyToken)
    expect(keytar.getPassword).not.toHaveBeenCalledWith(
      'Evenfire',
      `session-token::${legacyEnvKey}`
    )
    expect(keychain.values()).toContain(legacyToken)
  })

  it('does not restore a temporary session after RPC discovery changes the environment key', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-runtime-boundary-'))
    const userDataDir = path.join(tempDir, 'user-data')
    const chatBaseDir = path.join(tempDir, 'chats')
    const configPath = path.join(tempDir, 'runtime-config.json')
    await fs.mkdir(userDataDir, { recursive: true })
    process.env.CLERUM_DESKTOP_CONFIG_PATH = configPath
    delete process.env.APPDATA

    vi.resetModules()
    vi.doMock('electron', () => ({
      app: {
        getPath: vi.fn((name: string) =>
          name === 'appData' ? path.dirname(userDataDir) : userDataDir
        ),
        isPackaged: false,
        isReady: vi.fn(() => true),
        setName: vi.fn(),
        setPath: vi.fn(),
      },
      safeStorage: { isEncryptionAvailable: vi.fn(() => false) },
    }))

    const [{ AppService }, runtimeConfig, chatStoreBinding, { TokenStore }] = await Promise.all([
      import('../appService.js'),
      import('../config.js'),
      import('../chatStoreBinding.js'),
      import('../tokenStore.js'),
    ])
    cleanupModules = async () => {
      chatStoreBinding.unbindChatStore()
    }
    chatStoreBinding.__setChatStoreBaseDirForTests(chatBaseDir)

    const restBaseUrl = 'https://api-a.example.test'
    const rpcBaseUrl = 'https://rpc-discovered.example.test'
    await runtimeConfig.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: restBaseUrl,
      rpcProxyBaseUrl: '',
      appName: 'Environment A',
    })
    const restOnlyEnvKey = runtimeConfig.getActiveEnvKey()
    const me = testSessionMe()
    const tokenStore = new TokenStore({ isolatedUserDataPath: userDataDir })
    const seedService = new AppService() as unknown as {
      authClient: {
        getDesktopEnvironment: ReturnType<typeof vi.fn>
        getMe: ReturnType<typeof vi.fn>
        passwordLogin: ReturnType<typeof vi.fn>
      }
      tokenStore: TokenStore
      passwordLogin: (email: string, password: string) => Promise<unknown>
      gfsScopeIdentity: {
        ownerId: string
        teamId: string | null
        environmentKey: string
        baseUrl: string
      } | null
      gfsAuthEpoch: number
      persistDesktopGfsUpload: (record: unknown) => Promise<void>
    }
    seedService.tokenStore = tokenStore
    const savedToken = testSessionTokenWithExpiry()
    seedService.authClient = {
      getDesktopEnvironment: vi.fn().mockRejectedValue(new Error('seed discovery unavailable')),
      getMe: vi.fn().mockResolvedValue(me),
      passwordLogin: vi.fn().mockResolvedValue({ token: savedToken, me }),
    }
    await seedService.passwordLogin('user@example.test', 'test-password')
    await chatStoreBinding.requireChatStore().createChat('agent-a', 'chat-a')
    if (!seedService.gfsScopeIdentity)
      throw new Error('The seed login did not activate a GFS scope')
    const now = new Date().toISOString()
    await seedService.persistDesktopGfsUpload({
      version: 2,
      uploadId: 'upload-a',
      filePath: '/payload.bin',
      fileName: 'payload.bin',
      fileSize: 4,
      target: { operation: 'create', parentRid: 'parent-a' },
      name: 'payload.bin',
      session: {
        uploadId: 'upload-a',
        drive: 'main',
        operation: 'create',
        expectedBytes: 4,
        partBytes: 4,
        partCount: 1,
        state: 'uploading',
        contiguousBytes: 0,
        committedBytes: 0,
        committedPartCount: 0,
        activePartCount: 0,
        expiresAt: now,
      },
      scope: {
        ...seedService.gfsScopeIdentity,
        drive: 'main',
        authEpoch: seedService.gfsAuthEpoch,
      },
      status: 'active',
      updatedAt: now,
    })

    const service = new AppService() as unknown as {
      authClient: {
        getDesktopEnvironment: ReturnType<typeof vi.fn>
        getMe: ReturnType<typeof vi.fn>
      }
      tokenStore: TokenStore
      initialize: () => Promise<unknown>
      listGfsUploadSessions: (
        drive?: string
      ) => Promise<Array<{ uploadId: string; status: string }>>
    }
    service.tokenStore = tokenStore
    service.authClient = {
      getDesktopEnvironment: vi.fn().mockResolvedValue({
        externalRestApiBaseUrl: restBaseUrl,
        rpcProxyBaseUrl: rpcBaseUrl,
        appName: 'Environment A',
      }),
      getMe: vi.fn().mockResolvedValue(me),
    }

    await expect(service.initialize()).resolves.toEqual({ authenticated: false, me: null })

    const rpcEnvKey = runtimeConfig.getActiveEnvKey()
    expect(runtimeConfig.config.rpcProxyBaseUrl).toBe(rpcBaseUrl)
    expect(rpcEnvKey).not.toBe(restOnlyEnvKey)
    expect(service.authClient.getMe).not.toHaveBeenCalled()
    expect(await tokenStore.getSessionToken(rpcEnvKey)).toBeNull()
    expect(await tokenStore.getSessionToken(restOnlyEnvKey)).toBeNull()
    expect(await tokenStore.getSessionToken(rpcEnvKey)).toBeNull()
    expect(service.authClient.getMe).not.toHaveBeenCalledWith(savedToken)
    expect(() => chatStoreBinding.requireChatStore()).toThrow('Not authenticated')
    await expect(fs.access(path.join(chatBaseDir, rpcEnvKey, me.id))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(fs.access(path.join(chatBaseDir, restOnlyEnvKey, me.id))).resolves.toBeUndefined()
    await expect(service.listGfsUploadSessions('main')).rejects.toThrow(
      'GFS upload dispatch is unavailable without an active authenticated scope'
    )
  })

  it('migrates only matching producer-written GFS records during login', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-runtime-login-boundary-'))
    const userDataDir = path.join(tempDir, 'user-data')
    const configPath = path.join(tempDir, 'runtime-config.json')
    await fs.mkdir(userDataDir, { recursive: true })
    process.env.CLERUM_DESKTOP_CONFIG_PATH = configPath
    delete process.env.APPDATA

    vi.resetModules()
    vi.doMock('electron', () => ({
      app: {
        getPath: vi.fn((name: string) =>
          name === 'appData' ? path.dirname(userDataDir) : userDataDir
        ),
        isPackaged: false,
        isReady: vi.fn(() => true),
        setName: vi.fn(),
        setPath: vi.fn(),
      },
      safeStorage: { isEncryptionAvailable: vi.fn(() => false) },
    }))

    const [{ AppService }, runtimeConfig, { TokenStore }] = await Promise.all([
      import('../appService.js'),
      import('../config.js'),
      import('../tokenStore.js'),
    ])
    const restBaseUrl = 'https://api-a.example.test'
    const rpcBaseUrl = 'https://rpc-discovered.example.test'
    await runtimeConfig.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: restBaseUrl,
      rpcProxyBaseUrl: '',
      appName: 'Environment A',
    })
    const restOnlyEnvKey = runtimeConfig.getActiveEnvKey()
    const me = testSessionMe()
    const tokenStore = new TokenStore({ isolatedUserDataPath: userDataDir })
    const seedService = new AppService() as unknown as {
      authClient: {
        getDesktopEnvironment: ReturnType<typeof vi.fn>
        getMe: ReturnType<typeof vi.fn>
        passwordLogin: ReturnType<typeof vi.fn>
      }
      tokenStore: TokenStore
      passwordLogin: (email: string, password: string) => Promise<unknown>
      logout: () => Promise<number>
      gfsScopeIdentity: {
        ownerId: string
        teamId: string | null
        environmentKey: string
        baseUrl: string
      } | null
      gfsAuthEpoch: number
      persistDesktopGfsUpload: (record: unknown) => Promise<void>
    }
    seedService.tokenStore = tokenStore
    const seedToken = testSessionTokenWithExpiry()
    seedService.authClient = {
      getDesktopEnvironment: vi.fn().mockRejectedValue(new Error('seed discovery unavailable')),
      getMe: vi.fn().mockResolvedValue(me),
      passwordLogin: vi.fn().mockResolvedValue({ token: seedToken, me }),
    }
    await seedService.passwordLogin('user@example.test', 'test-password')
    if (!seedService.gfsScopeIdentity)
      throw new Error('The seed login did not activate a GFS scope')
    const seedScope = seedService.gfsScopeIdentity
    const expiresAt = new Date(Date.now() + 60_000).toISOString()
    const persistRecord = async (
      uploadId: string,
      scope: {
        ownerId: string
        teamId: string | null
        environmentKey: string
        baseUrl: string
      },
      status: 'active' | 'paused' = 'active'
    ) => {
      await seedService.persistDesktopGfsUpload({
        version: 2,
        uploadId,
        filePath: `/${uploadId}.bin`,
        fileName: `${uploadId}.bin`,
        fileSize: 4,
        target: { operation: 'create', parentRid: 'parent-a' },
        name: `${uploadId}.bin`,
        session: {
          uploadId,
          drive: 'main',
          operation: 'create',
          expectedBytes: 4,
          partBytes: 4,
          partCount: 1,
          state: 'uploading',
          contiguousBytes: 0,
          committedBytes: 0,
          committedPartCount: 0,
          activePartCount: 0,
          expiresAt,
        },
        scope: { ...scope, drive: 'main', authEpoch: seedService.gfsAuthEpoch },
        status,
        updatedAt: new Date().toISOString(),
      })
    }
    await persistRecord('matching-upload', seedScope)
    await persistRecord('other-user-upload', { ...seedScope, ownerId: 'other-user' })
    await persistRecord('other-team-upload', { ...seedScope, teamId: 'other-team' })
    await persistRecord('other-rest-upload', {
      ...seedScope,
      baseUrl: 'https://api-other.example.test',
    })
    await seedService.logout()
    await persistRecord('paused-upload', seedScope, 'paused')
    const unrelatedEnvKey = runtimeConfig.resolveEnvKey('https://unrelated.example.test')
    await persistRecord('other-environment-upload', {
      ...seedScope,
      environmentKey: unrelatedEnvKey,
    })

    await runtimeConfig.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: restBaseUrl,
      rpcProxyBaseUrl: rpcBaseUrl,
      appName: 'Environment A',
    })
    const rpcEnvKey = runtimeConfig.getActiveEnvKey()
    const loginService = new AppService() as unknown as {
      authClient: {
        getMe: ReturnType<typeof vi.fn>
        passwordLogin: ReturnType<typeof vi.fn>
      }
      tokenStore: TokenStore
      passwordLogin: (email: string, password: string) => Promise<unknown>
    }
    loginService.tokenStore = tokenStore
    const loginToken = testSessionTokenWithExpiry()
    loginService.authClient = {
      getMe: vi.fn().mockResolvedValue(me),
      passwordLogin: vi.fn().mockResolvedValue({ token: loginToken, me }),
    }

    const loginState = await loginService.passwordLogin('user@example.test', 'test-password')

    expect(loginState).toEqual(expect.objectContaining({ authenticated: true }))
    expect(await tokenStore.getSessionToken(rpcEnvKey)).toBeNull()
    expect(await tokenStore.getSessionToken(restOnlyEnvKey)).toBeNull()
    const state = JSON.parse(
      await fs.readFile(path.join(userDataDir, 'gfs-upload-sessions.json'), 'utf8')
    ) as {
      records: Array<{
        uploadId: string
        status: string
        scope: { environmentKey: string; ownerId: string; teamId: string | null; baseUrl: string }
      }>
    }
    const byId = new Map(state.records.map(record => [record.uploadId, record]))
    expect(byId.get('paused-upload')).toEqual(
      expect.objectContaining({
        status: 'paused',
        scope: expect.objectContaining({ environmentKey: rpcEnvKey }),
      })
    )
    expect(byId.get('other-environment-upload')).toEqual(
      expect.objectContaining({
        status: 'active',
        scope: expect.objectContaining({ environmentKey: unrelatedEnvKey }),
      })
    )
    expect(byId.get('matching-upload')).toEqual(
      expect.objectContaining({
        status: 'suspended_auth',
        scope: expect.objectContaining({ environmentKey: rpcEnvKey }),
      })
    )
    for (const uploadId of ['other-user-upload', 'other-team-upload', 'other-rest-upload']) {
      expect(byId.get(uploadId)).toEqual(
        expect.objectContaining({
          scope: expect.objectContaining({ environmentKey: restOnlyEnvKey }),
        })
      )
    }
  })
})
