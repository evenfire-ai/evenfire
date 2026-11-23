import { afterEach, expect, it, vi } from 'vitest'
import syncFs from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { testLoginResult } from '../../testSupport/authTestFixtures.js'

const originalConfigPath = process.env.CLERUM_DESKTOP_CONFIG_PATH
const originalPreview = process.env.EVENFIRE_ONBOARDING_PREVIEW
let directory = ''
let closeStore: (() => void) | undefined

afterEach(async () => {
  closeStore?.()
  vi.restoreAllMocks()
  vi.doUnmock('electron')
  vi.resetModules()
  if (originalConfigPath === undefined) delete process.env.CLERUM_DESKTOP_CONFIG_PATH
  else process.env.CLERUM_DESKTOP_CONFIG_PATH = originalConfigPath
  if (originalPreview === undefined) delete process.env.EVENFIRE_ONBOARDING_PREVIEW
  else process.env.EVENFIRE_ONBOARDING_PREVIEW = originalPreview
  if (directory) await fs.rm(directory, { recursive: true, force: true })
})

async function selectSiblingAfterIndexFailure() {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-directory-discovery-'))
  delete process.env.CLERUM_DESKTOP_CONFIG_PATH
  delete process.env.EVENFIRE_ONBOARDING_PREVIEW
  vi.resetModules()
  vi.doMock('electron', () => ({
    app: { getPath: () => directory, isPackaged: true, isReady: () => true, setName: vi.fn() },
    safeStorage: { isEncryptionAvailable: () => false },
  }))
  const rest = 'https://shared-api.example.test/api'
  const rpc = 'https://discovered-a.example.test'
  const producer = await import('../config.js')
  await producer.saveDesktopRuntimeConfig({
    externalRestApiBaseUrl: rest,
    rpcProxyBaseUrl: '',
    appName: 'A',
  })
  const a = producer.getDesktopRuntimeConfigState().activeOptionId!
  await producer.saveDesktopRuntimeConfig({
    externalRestApiBaseUrl: `${rest}/legacy`,
    rpcProxyBaseUrl: '',
    appName: 'B',
  })
  const saved = producer.getDesktopRuntimeConfigState()
  const b = saved.options.find(option => option.id === saved.activeOptionId)!
  // A supported legacy directory may contain distinct IDs with equivalent REST URLs.
  // Preserve the producer's file schema and index; only edit the configured endpoint.
  const legacy = JSON.parse(await fs.readFile(b.configPath!, 'utf8'))
  await fs.writeFile(
    b.configPath!,
    JSON.stringify({ ...legacy, externalRestApiBaseUrl: `${rest}/#legacy` })
  )
  vi.resetModules()
  const [config, { AppService }, { AuthClient }, { TokenStore }, chat] = await Promise.all([
    import('../config.js'),
    import('../appService.js'),
    import('../authClient.js'),
    import('../tokenStore.js'),
    import('../chatStoreBinding.js'),
  ])
  await config.selectDesktopRuntimeConfigOption(a)
  chat.__setChatStoreBaseDirForTests(path.join(directory, 'chats'))
  closeStore = chat.unbindChatStore
  const store = new TokenStore({ isolatedUserDataPath: directory })
  const service = new AppService()
  ;(service as unknown as { tokenStore: InstanceType<typeof TokenStore> }).tokenStore = store
  const discovery = vi.spyOn(AuthClient.prototype, 'getDesktopEnvironmentForEndpoint')
  discovery.mockResolvedValue({
    externalRestApiBaseUrl: rest,
    rpcProxyBaseUrl: rpc,
    appName: 'A',
    responseUrl: `${rest}/api/v1/desktop/environment`,
  })
  vi.spyOn(AuthClient.prototype, 'googleLogin').mockResolvedValue(testLoginResult())
  vi.spyOn(AuthClient.prototype, 'health').mockResolvedValue({ status: 'ok' })
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    // Native fetch rejects the relative /health URL when no transport is configured.
    new URL(String(input))
    return new Response(JSON.stringify({ status: 'ok' }), { status: 200 })
  })
  await service.googleLogin('synthetic-google-token')
  const key = config.getActiveEnvKey()
  const generation = service.getSessionGeneration()
  const chatGeneration = chat.getChatStoreBindingGeneration()
  await service.getDependenciesHealth()
  expect(fetch).toHaveBeenCalledWith(`${rpc}/health`, expect.any(Object))
  discovery.mockRejectedValue(new Error('subsequent optional discovery unavailable'))
  const index = path.join(saved.storagePath, 'index.json')
  const rename = syncFs.renameSync.bind(syncFs)
  const failure = vi.spyOn(syncFs, 'renameSync').mockImplementation((source, destination) => {
    if (String(destination).endsWith('.runtime-config-transaction.json')) {
      throw new Error('fixture profile index commit denied')
    }
    return rename(source, destination)
  })
  await expect(service.selectRuntimeConfig(b.id)).rejects.toThrow('profile index commit denied')
  failure.mockRestore()
  expect(config.getDesktopRuntimeConfigState().activeOptionId).toBe(a)
  expect(config.getActiveEnvKey()).toBe(key)
  expect(service.getSessionGeneration()).toBeGreaterThan(generation)
  expect(service.getCachedUserId()).toBe('user-a')
  expect(await store.getSessionToken(key)).toBe('synthetic-session-a')
  expect(chat.getChatStoreBindingGeneration()).toBe(chatGeneration)
  return { service, config, store, a, b, key, rpc, fetch, index }
}

it('does not route a surviving session through another profile after an index write rejection', async () => {
  const { service, config, fetch, a, rpc } = await selectSiblingAfterIndexFailure()
  fetch.mockClear()
  const health = await service.getDependenciesHealth()
  expect(health.rpcProxy.ok).toBe(true)
  expect(fetch).toHaveBeenCalledWith(`${rpc}/health`, expect.any(Object))
  expect(config.getDesktopRuntimeConfigState().activeOptionId).toBe(a)
  expect(config.config.rpcProxyBaseUrl).toBe(rpc)
})

it('does not persist another directory profile discovery on logout after an index write rejection', async () => {
  const { service, config, store, a, b, key, rpc, index } = await selectSiblingAfterIndexFailure()
  await service.logout()
  expect(service.getCachedUserId()).toBeNull()
  expect(await store.getSessionToken(key)).toBeNull()
  expect(config.getDesktopRuntimeConfigState().activeOptionId).toBe(a)
  expect(config.config.rpcProxyBaseUrl).toBe(rpc)
  // A later successful selection persists B without copying A's RPC projection.
  await service.selectRuntimeConfig(b.id)
  expect(JSON.parse(await fs.readFile(index, 'utf8')).activeProfileId).toBe(b.id)
  expect(config.config.rpcProxyBaseUrl).toBe('')
})
