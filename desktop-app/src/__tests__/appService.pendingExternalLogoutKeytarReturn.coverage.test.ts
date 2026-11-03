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
vi.mock('../chatStoreBinding.js', async () => {
  const { createChatStoreBindingMock } = await import('../../testSupport/chatStoreBindingMock.js')
  return createChatStoreBindingMock()
})
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
  await config.saveDesktopRuntimeConfig({
    externalRestApiBaseUrl: 'https://password-auth.example.test',
    rpcProxyBaseUrl: 'https://password-rpc.example.test',
    appName: 'Password authentication fixture',
  })
  const tokenStore = new TokenStore()
  const service = new AppService({ tokenStore, getUserDataDirectory: () => runtime.directory })
  const state = service as unknown as {
    authClient: {
      passwordLogin: (email: string, password: string) => Promise<{ token: string; me: typeof me }>
      getMe: (token: string) => Promise<typeof me>
    }
  }
  return { service, tokenStore, state, markers, envKey: config.getActiveEnvKey() }
}

describe('pending logout when an unavailable Keytar module returns', () => {
  it('requires password authentication and never restores stale Keytar after recovery', async () => {
    const staleToken = 'fixture-stale-logged-out-keytar'
    const seed = await createService(true)
    await seed.tokenStore.setSessionToken(staleToken, seed.envKey)
    await seed.service.prepareForQuit()
    await expect(seed.service.logout()).resolves.toMatchObject({
      kind: 'not-committed',
      reason: 'deferred',
    })
    expect(seed.markers.readPendingExternalLogoutIntent(runtime.directory, seed.envKey)).toEqual({
      intent: 'logout-pending',
    })

    const recovery = await createService(false)
    const passwordLoginWithoutKeytar = vi
      .spyOn(recovery.state.authClient, 'passwordLogin')
      .mockResolvedValue({
        token: 'fixture-fresh-safe-storage-session',
        me,
      })
    const freshGetMe = vi.spyOn(recovery.state.authClient, 'getMe').mockResolvedValue(me)
    await expect(
      recovery.service.passwordLogin('user@example.test', 'fixture-password')
    ).resolves.toMatchObject({ authenticated: true, me })
    expect(recovery.service.sessionToken).toBe('fixture-fresh-safe-storage-session')
    expect(passwordLoginWithoutKeytar).toHaveBeenCalledOnce()
    expect(freshGetMe).toHaveBeenCalledWith('fixture-fresh-safe-storage-session')
    expect(freshGetMe).not.toHaveBeenCalledWith(staleToken)
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
    const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
    const selected = await readSessionAuthoritySourceSelection({
      tokenStore: restarted.tokenStore,
      envKey: restarted.envKey,
    })
    expect(selected.status).toBe('accepted')
    if (selected.status !== 'accepted') throw new Error('Expected the fresh V1 source to restore')
    expect(selected.session.token).toBe('fixture-fresh-safe-storage-session')
    expect(restored).toEqual({ authenticated: true, me })
    expect(getMe).toHaveBeenCalledWith('fixture-fresh-safe-storage-session')

    await expect(restarted.service.logout()).resolves.toMatchObject({ kind: 'committed' })

    const afterLogout = await createService(true)
    const getMeAfterLogout = vi.spyOn(afterLogout.state.authClient, 'getMe').mockResolvedValue(me)
    await expect(afterLogout.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(getMeAfterLogout).not.toHaveBeenCalledWith('fixture-fresh-safe-storage-session')
  })
})
