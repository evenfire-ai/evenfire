import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { testLoginResult, testSessionTokenWithExpiry } from '../../testSupport/authTestFixtures.js'

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

const originalConfigPath = process.env.CLERUM_DESKTOP_CONFIG_PATH
const originalPreview = process.env.EVENFIRE_ONBOARDING_PREVIEW
let directory = ''
let closeStore: (() => void) | undefined

afterEach(async () => {
  closeStore?.()
  vi.restoreAllMocks()
  vi.doUnmock('electron')
  vi.doUnmock('keytar')
  vi.resetModules()
  if (originalConfigPath === undefined) delete process.env.CLERUM_DESKTOP_CONFIG_PATH
  else process.env.CLERUM_DESKTOP_CONFIG_PATH = originalConfigPath
  if (originalPreview === undefined) delete process.env.EVENFIRE_ONBOARDING_PREVIEW
  else process.env.EVENFIRE_ONBOARDING_PREVIEW = originalPreview
  if (directory) await fs.rm(directory, { recursive: true, force: true })
})

async function createAuthenticatedDirectoryProfile() {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-directory-discovery-'))
  delete process.env.CLERUM_DESKTOP_CONFIG_PATH
  delete process.env.EVENFIRE_ONBOARDING_PREVIEW
  vi.resetModules()
  vi.doMock('electron', () => ({
    app: { getPath: () => directory, isPackaged: false, isReady: () => true, setName: vi.fn() },
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
  const discovery = vi.spyOn(AuthClient.prototype, 'getDesktopEnvironment')
  discovery.mockRejectedValueOnce(new Error('initial optional discovery unavailable'))
  discovery.mockResolvedValue({ externalRestApiBaseUrl: rest, rpcProxyBaseUrl: rpc, appName: 'A' })
  const sessionToken = testSessionTokenWithExpiry()
  const loginResult = testLoginResult(sessionToken)
  vi.spyOn(AuthClient.prototype, 'passwordLogin').mockResolvedValue(loginResult)
  vi.spyOn(AuthClient.prototype, 'health').mockResolvedValue({ status: 'ok' })
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/api/v1/me'))
      return new Response(JSON.stringify(loginResult.me), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    // Native fetch rejects the relative /health URL when no transport is configured.
    return new Response(JSON.stringify({ status: 'ok' }), { status: 200 })
  })
  await service.passwordLogin('user-a@example.test', 'synthetic-password')
  const key = config.getActiveEnvKey()
  const generation = service.getSessionGeneration()
  const chatGeneration = chat.getChatStoreBindingGeneration()
  await service.getDependenciesHealth()
  expect(fetch).toHaveBeenCalledWith(`${rpc}/health`, expect.any(Object))
  discovery.mockRejectedValue(new Error('subsequent optional discovery unavailable'))
  const index = path.join(saved.storagePath, 'index.json')
  return { service, config, store, chat, a, b, key, index, generation, chatGeneration }
}

it('rejects sibling profile selection while authenticated without touching profile storage', async () => {
  const { service, config, store, chat, a, b, key, index, generation, chatGeneration } =
    await createAuthenticatedDirectoryProfile()
  const write = fs.writeFile.bind(fs)
  const failure = vi.spyOn(fs, 'writeFile').mockImplementation(async (file, ...args) => {
    if (String(file) === index) throw new Error('fixture profile index write denied')
    return write(file, ...args)
  })
  await expect(service.selectRuntimeConfig(b.id)).rejects.toThrow('desktop_setup_requires_signout')
  expect(failure).not.toHaveBeenCalled()
  failure.mockRestore()
  expect(config.getDesktopRuntimeConfigState().activeOptionId).toBe(a)
  expect(config.getActiveEnvKey()).toBe(key)
  expect(service.getSessionGeneration()).toBe(generation)
  expect(service.getCachedUserId()).toBe('user-a')
  expect(await store.getSessionToken(key)).toBeNull()
  await expect(service.getSessionState()).resolves.toMatchObject({
    authenticated: true,
    me: { id: 'user-a' },
    sessionMode: 'temporary',
  })
  expect(chat.getChatStoreBindingGeneration()).toBe(chatGeneration)
})

it('keeps failed signed-out selection unauthenticated and persists only a later successful selection', async () => {
  const { service, config, store, a, b, key, index } = await createAuthenticatedDirectoryProfile()
  const logout = await service.logout()
  expect(logout.kind).toBe('committed')
  expect(service.getCachedUserId()).toBeNull()
  expect(await store.getSessionToken(key)).toBeNull()
  await expect(service.getSessionState()).resolves.toMatchObject({
    authenticated: false,
    me: null,
  })
  const write = fs.writeFile.bind(fs)
  const failure = vi.spyOn(fs, 'writeFile').mockImplementation(async (file, ...args) => {
    if (String(file) === index) throw new Error('fixture profile index write denied')
    return write(file, ...args)
  })
  await expect(service.selectRuntimeConfig(b.id)).rejects.toThrow('profile index write denied')
  failure.mockRestore()
  await expect(service.getSessionState()).resolves.toMatchObject({ authenticated: false, me: null })
  expect(service.sessionToken).toBeNull()
  expect(await store.getSessionToken(key)).toBeNull()

  // A later successful signed-out selection persists B; it does not revive A's old session.
  await service.selectRuntimeConfig(b.id)
  expect(JSON.parse(await fs.readFile(index, 'utf8')).activeProfileId).toBe(b.id)
  expect(config.getDesktopRuntimeConfigState().activeOptionId).toBe(b.id)
  expect(config.getDesktopRuntimeConfigState().activeOptionId).not.toBe(a)
  await expect(service.getSessionState()).resolves.toMatchObject({ authenticated: false, me: null })
})
