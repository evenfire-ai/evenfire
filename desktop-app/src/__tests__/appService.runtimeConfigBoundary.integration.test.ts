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
    await tokenStore.setSessionToken('synthetic-saved-session-a', restOnlyEnvKey)
    await chatStoreBinding.bindChatStoreForUser(me.id, restOnlyEnvKey, {
      teamId: me.teamId,
    })
    await chatStoreBinding.requireChatStore().createChat('agent-a', 'chat-a')

    const gfsStatePath = path.join(userDataDir, 'gfs-upload-sessions.json')
    const now = new Date().toISOString()
    await fs.writeFile(
      gfsStatePath,
      JSON.stringify({
        version: 2,
        records: [
          {
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
              ownerId: me.id,
              teamId: me.teamId,
              environmentKey: restOnlyEnvKey,
              baseUrl: restBaseUrl,
              drive: 'main',
              authEpoch: 1,
            },
            status: 'active',
            updatedAt: now,
          },
        ],
        quarantined: [],
      }),
      { mode: 0o600 }
    )

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
})
