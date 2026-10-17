import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const runtime = vi.hoisted(() => ({ directory: '', keychain: new Map<string, string>() }))
const keytarAdapter = vi.hoisted(() => ({
  getPassword: vi.fn(
    async (service: string, account: string) =>
      runtime.keychain.get(`${service}::${account}`) ?? null
  ),
  setPassword: vi.fn(async (service: string, account: string, token: string) => {
    runtime.keychain.set(`${service}::${account}`, token)
  }),
  deletePassword: vi.fn(async (service: string, account: string) =>
    runtime.keychain.delete(`${service}::${account}`)
  ),
}))
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => runtime.directory), isReady: vi.fn(() => true) },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: vi.fn((value: string) => Buffer.from(value)),
    decryptString: vi.fn((value: Buffer) => value.toString()),
  },
}))
vi.mock('../chatStoreBinding.js', () => ({
  bindChatStoreForUser: vi.fn(),
  unbindChatStore: vi.fn(),
  __setChatStoreBaseDirForTests: vi.fn(),
}))
vi.mock('../pluginSdkRuntime.js', () => ({
  tryGetPluginSdkRuntime: () => ({
    notifySessionChanged: vi.fn(),
    unpinAllSandboxUiSurfaces: vi.fn(),
  }),
}))

const me = {
  id: 'user-1',
  email: 'user@example.test',
  name: null,
  picture: null,
  teamId: 'team-1',
  teamName: 'Team 1',
  role: 'member' as const,
}

beforeEach(async () => {
  vi.clearAllMocks()
  runtime.keychain.clear()
  runtime.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-keytar-return-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.doUnmock('keytar')
  vi.resetModules()
  runtime.keychain.clear()
  if (runtime.directory) await fs.rm(runtime.directory, { recursive: true, force: true })
  runtime.directory = ''
})

async function createService(keytarAvailable: boolean) {
  // An absent module is different from rejected calls: loadKeytar must emit null.
  vi.resetModules()
  vi.doMock('keytar', () => (keytarAvailable ? keytarAdapter : {}))
  const [{ AppService }, { TokenStore }, config, markers] = await Promise.all([
    import('../appService.js'),
    import('../tokenStore.js'),
    import('../config.js'),
    import('../pendingExternalLogout.js'),
  ])
  const tokenStore = new TokenStore()
  const service = new AppService({ tokenStore, getUserDataDirectory: () => runtime.directory })
  const state = service as unknown as {
    authClient: { googleLogin: (idToken: string) => Promise<{ token: string; me: typeof me }> }
  }
  return { service, tokenStore, state, markers, envKey: config.getActiveEnvKey() }
}

describe('pending logout when an unavailable Keytar module returns', () => {
  it('never authenticates stale Keytar after secure recovery and a subsequent UI logout', async () => {
    const staleToken = 'fixture-stale-logged-out-keytar'
    const seed = await createService(true)
    await seed.tokenStore.setSessionToken(staleToken, seed.envKey)
    await seed.service.prepareForQuit()
    await expect(seed.service.logout()).rejects.toThrow('shutting down')
    expect(seed.markers.readPendingExternalLogoutIntent(runtime.directory, seed.envKey)).toEqual({
      intent: 'logout-pending',
    })

    const recovery = await createService(false)
    vi.spyOn(recovery.state.authClient, 'googleLogin').mockResolvedValue({
      token: 'fixture-fresh-safe-storage-session',
      me,
    })
    await expect(recovery.service.googleLogin('fixture-google-id-token')).resolves.toEqual({
      authenticated: true,
      me,
    })
    expect(
      recovery.markers.readPendingExternalLogoutIntent(runtime.directory, recovery.envKey)
    ).toEqual({ intent: 'keytar-cleanup-pending', credentialSource: 'safe-storage' })
    await expect(recovery.tokenStore.getSafeStorageSessionToken(recovery.envKey)).resolves.toBe(
      'fixture-fresh-safe-storage-session'
    )

    await expect(recovery.service.logout()).resolves.toBeTypeOf('number')
    await expect(
      recovery.tokenStore.getSafeStorageSessionToken(recovery.envKey)
    ).resolves.toBeNull()
    expect([...runtime.keychain.values()]).toContain(staleToken)

    const restarted = await createService(true)
    const authClient = (
      restarted.service as unknown as {
        authClient: { getMe: (token: string) => Promise<typeof me> }
      }
    ).authClient
    const getMe = vi.spyOn(authClient, 'getMe').mockResolvedValue(me)

    const restored = await restarted.service.initialize()

    expect(getMe).not.toHaveBeenCalledWith(staleToken)
    expect(restored).toEqual({ authenticated: false, me: null })
    await expect(restarted.tokenStore.getKeytarSessionToken(restarted.envKey)).resolves.toBeNull()
  })
})
