import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { testLoginResult, testSessionMe } from '../../testSupport/authTestFixtures.js'

const originalConfigPath = process.env.CLERUM_DESKTOP_CONFIG_PATH
let directory = ''
let closeStore: (() => void) | undefined

afterEach(async () => {
  closeStore?.()
  vi.restoreAllMocks()
  vi.doUnmock('electron')
  vi.resetModules()
  if (originalConfigPath === undefined) delete process.env.CLERUM_DESKTOP_CONFIG_PATH
  else process.env.CLERUM_DESKTOP_CONFIG_PATH = originalConfigPath
  if (directory) await fs.rm(directory, { recursive: true, force: true })
})

async function fixture() {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-discovery-lifecycle-'))
  const configPath = path.join(directory, 'runtime.json')
  process.env.CLERUM_DESKTOP_CONFIG_PATH = configPath
  vi.resetModules()
  vi.doMock('electron', () => ({
    app: {
      getPath: () => directory,
      isPackaged: false,
      isReady: () => true,
      setName: vi.fn(),
      setPath: vi.fn(),
    },
    safeStorage: { isEncryptionAvailable: () => false },
  }))
  const [{ AppService }, config, { AuthClient }, { RpcProxyClient }, { TokenStore }, chat] =
    await Promise.all([
      import('../appService.js'),
      import('../config.js'),
      import('../authClient.js'),
      import('../rpcProxyClient.js'),
      import('../tokenStore.js'),
      import('../chatStoreBinding.js'),
    ])
  chat.__setChatStoreBaseDirForTests(path.join(directory, 'chats'))
  closeStore = chat.unbindChatStore
  const rest = 'https://api-a.example.test'
  const rpc = 'https://rpc-discovered.example.test'
  await config.saveDesktopRuntimeConfig({ externalRestApiBaseUrl: rest, rpcProxyBaseUrl: '' })
  const store = new TokenStore({ isolatedUserDataPath: directory })
  const service = new AppService()
  ;(service as unknown as { tokenStore: InstanceType<typeof TokenStore> }).tokenStore = store
  const discovery = vi.spyOn(AuthClient.prototype, 'getDesktopEnvironment')
  discovery.mockRejectedValueOnce(new Error('initial discovery unavailable'))
  discovery.mockResolvedValue({ externalRestApiBaseUrl: rest, rpcProxyBaseUrl: rpc, appName: 'A' })
  vi.spyOn(AuthClient.prototype, 'googleLogin').mockResolvedValue(
    testLoginResult('synthetic-session-a', testSessionMe())
  )
  vi.spyOn(AuthClient.prototype, 'health').mockResolvedValue({ status: 'ok' })
  const rpcHealth = vi.spyOn(RpcProxyClient.prototype, 'health').mockResolvedValue({ status: 'ok' })
  return { service, config, configPath, store, chat, rest, rpc, AuthClient, discovery, rpcHealth }
}

describe('RPC discovery lifecycle through native producers', () => {
  it('retries discovery persistence after logout ends auth but its config write fails', async () => {
    const { service, config, configPath, store, rest, rpc, discovery, chat } = await fixture()
    await service.googleLogin('synthetic-google-token')
    await chat.requireChatStore().createChat('agent-a', 'chat-a')
    const oldKey = config.getActiveEnvKey()
    await service.getDependenciesHealth()
    const write = fs.writeFile.bind(fs)
    const failure = vi.spyOn(fs, 'writeFile').mockImplementation(async (file, ...args) => {
      if (String(file) === configPath) throw new Error('fixture config write denied')
      return write(file, ...args)
    })
    await service.logout()
    failure.mockRestore()
    expect(service.getCachedUserId()).toBeNull()
    expect(await store.getSessionToken(oldKey)).toBeNull()
    await service.getDependenciesHealth()
    await service.getDependenciesHealth()
    expect(config.config.externalRestApiBaseUrl).toBe(rest)
    expect(config.config.rpcProxyBaseUrl).toBe(rpc)
    expect(JSON.parse(await fs.readFile(configPath, 'utf8')).rpcProxyBaseUrl).toBe(rpc)
    expect(discovery).toHaveBeenCalledTimes(3)
  })

  it('recovers discovery after a team switch clears its partially replaced session', async () => {
    const { service, config, store, rpc, AuthClient, discovery } = await fixture()
    await service.googleLogin('synthetic-google-token')
    const oldKey = config.getActiveEnvKey()
    await service.getDependenciesHealth()
    vi.spyOn(AuthClient.prototype, 'switchTeam').mockResolvedValue({
      token: 'synthetic-team-b',
      team: { id: 'team-b', name: 'B', role: 'member' },
    })
    vi.spyOn(AuthClient.prototype, 'getMe').mockRejectedValue(
      new Error('fixture team refresh failed')
    )
    await expect(service.switchTeam('team-b')).rejects.toThrow('team refresh failed')
    expect(service.getCachedUserId()).toBeNull()
    expect(await store.getSessionToken(oldKey)).toBeNull()
    await service.getDependenciesHealth()
    expect(config.config.rpcProxyBaseUrl).toBe(rpc)
    expect(discovery).toHaveBeenCalledTimes(3)
  })

  it.each(['javascript:alert(1)', 'file:///fixture', undefined, '', 42])(
    'rejects invalid discovered RPC %s and permits a later valid discovery',
    async invalid => {
      const { service, config, rpc, rest, store, discovery, rpcHealth } = await fixture()
      await service.googleLogin('synthetic-google-token')
      const key = config.getActiveEnvKey()
      discovery.mockResolvedValueOnce({
        externalRestApiBaseUrl: rest,
        rpcProxyBaseUrl: invalid,
        appName: 'A',
      } as never)
      const activeGeneration = service.getSessionGeneration()
      await service.getDependenciesHealth()
      expect(config.config.rpcProxyBaseUrl).toBe('')
      await service.getDependenciesHealth()
      expect(discovery).toHaveBeenCalledTimes(3)
      expect(config.getActiveEnvKey()).toBe(key)
      expect(service.getSessionGeneration()).toBe(activeGeneration)
      expect(await store.getSessionToken(key)).toBe('synthetic-session-a')
      expect(service.getCachedUserId()).toBe('user-a')
      // The real transport provider must now supply the recovered endpoint.
      rpcHealth.mockRestore()
      const fetch = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(JSON.stringify({ status: 'ok' }), { status: 200 }))
      await service.getDependenciesHealth()
      expect(fetch).toHaveBeenCalledWith(`${rpc}/health`, expect.any(Object))
    }
  )
})
