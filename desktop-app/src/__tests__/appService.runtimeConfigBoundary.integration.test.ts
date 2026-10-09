import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { testSessionMe } from '../../testSupport/authTestFixtures.js'

const originalConfigPath = process.env.CLERUM_DESKTOP_CONFIG_PATH
const originalAppData = process.env.APPDATA
let tempDir: string | null = null
let cleanupModules: (() => Promise<void>) | null = null

afterEach(async () => {
  await cleanupModules?.()
  cleanupModules = null
  vi.doUnmock('electron')
  vi.resetModules()
  if (originalConfigPath === undefined) delete process.env.CLERUM_DESKTOP_CONFIG_PATH
  else process.env.CLERUM_DESKTOP_CONFIG_PATH = originalConfigPath
  if (originalAppData === undefined) delete process.env.APPDATA
  else process.env.APPDATA = originalAppData
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true })
  tempDir = null
})

describe('AppService RPC discovery restore boundary', () => {
  it('migrates real token, chat, and GFS state at the next restore boundary', async () => {
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
        googleLogin: ReturnType<typeof vi.fn>
      }
      tokenStore: TokenStore
      googleLogin: (idToken: string) => Promise<unknown>
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
    seedService.authClient = {
      getDesktopEnvironment: vi.fn().mockRejectedValue(new Error('seed discovery unavailable')),
      googleLogin: vi.fn().mockResolvedValue({ token: 'synthetic-saved-session-a', me }),
    }
    await seedService.googleLogin('synthetic-seed-google-token')
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

    await expect(service.initialize()).resolves.toMatchObject({ authenticated: true, me })

    const rpcEnvKey = runtimeConfig.getActiveEnvKey()
    expect(runtimeConfig.config.rpcProxyBaseUrl).toBe(rpcBaseUrl)
    expect(rpcEnvKey).not.toBe(restOnlyEnvKey)
    expect(await tokenStore.getSessionToken(rpcEnvKey)).toBe('synthetic-saved-session-a')
    expect(await tokenStore.getSessionToken(restOnlyEnvKey)).toBeNull()
    expect(
      (await chatStoreBinding.requireChatStore().listChats('agent-a')).map(chat => chat.id)
    ).toEqual(['chat-a'])
    await expect(fs.access(path.join(chatBaseDir, restOnlyEnvKey, me.id))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(
      fs.access(path.join(chatBaseDir, rpcEnvKey, me.id, 'agent-a', 'index.json'))
    ).resolves.toBeUndefined()
    await expect(service.listGfsUploadSessions('main')).resolves.toEqual([
      expect.objectContaining({ uploadId: 'upload-a', status: 'suspended_auth' }),
    ])
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
        googleLogin: ReturnType<typeof vi.fn>
      }
      tokenStore: TokenStore
      googleLogin: (idToken: string) => Promise<unknown>
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
    seedService.authClient = {
      getDesktopEnvironment: vi.fn().mockRejectedValue(new Error('seed discovery unavailable')),
      googleLogin: vi.fn().mockResolvedValue({ token: 'synthetic-seed-session', me }),
    }
    await seedService.googleLogin('synthetic-seed-google-token')
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
      }
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
        status: 'active',
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

    await runtimeConfig.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: restBaseUrl,
      rpcProxyBaseUrl: rpcBaseUrl,
      appName: 'Environment A',
    })
    const rpcEnvKey = runtimeConfig.getActiveEnvKey()
    const loginService = new AppService() as unknown as {
      authClient: { googleLogin: ReturnType<typeof vi.fn> }
      tokenStore: TokenStore
      googleLogin: (idToken: string) => Promise<unknown>
    }
    loginService.tokenStore = tokenStore
    loginService.authClient = {
      googleLogin: vi.fn().mockResolvedValue({ token: 'synthetic-login-session', me }),
    }

    await loginService.googleLogin('synthetic-login-google-token')

    expect(await tokenStore.getSessionToken(rpcEnvKey)).toBe('synthetic-login-session')
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
