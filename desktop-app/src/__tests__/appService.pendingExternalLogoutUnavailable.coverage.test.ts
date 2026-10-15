import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const runtime = vi.hoisted(() => ({ directory: '' }))
const { notifySessionChanged } = vi.hoisted(() => ({ notifySessionChanged: vi.fn() }))
// The absent module is the actual TokenStore producer's supported loadKeytar=null boundary.
vi.mock('keytar', () => ({}))
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
  tryGetPluginSdkRuntime: () => ({ notifySessionChanged, unpinAllSandboxUiSurfaces: vi.fn() }),
}))

beforeEach(async () => {
  vi.clearAllMocks()
  vi.resetModules()
  runtime.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-marker-absent-coverage-'))
  const { safeStorage } = await import('electron')
  vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
})
afterEach(async () => {
  vi.restoreAllMocks()
  if (runtime.directory) await fs.rm(runtime.directory, { recursive: true, force: true })
  runtime.directory = ''
  vi.resetModules()
})

async function createService() {
  const [{ AppService }, { TokenStore }, config, markers] = await Promise.all([
    import('../appService.js'),
    import('../tokenStore.js'),
    import('../config.js'),
    import('../pendingExternalLogout.js'),
  ])
  const tokenStore = new TokenStore()
  const service = new AppService({ tokenStore, getUserDataDirectory: () => runtime.directory })
  return { service, tokenStore, envKey: config.getActiveEnvKey(), markers }
}

function validSessionToken(): string {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })
  ).toString('base64url')
  return `header.${payload}.signature`
}

// October 14 owner clarification extends the logout fence to an absent production module.
describe('pending logout without a Keytar module', () => {
  it('retains logout intent after canceled-quit file cleanup when Keytar cleanup cannot be verified', async () => {
    const { service, tokenStore, envKey, markers } = await createService()
    await tokenStore.setSafeStorageSessionToken('fixture-stale-file-session', envKey)
    markers.recordPendingExternalLogout(runtime.directory, envKey)
    await service.prepareForQuit()
    service.cancelQuitPreparation()

    await expect(service.applyPendingExternalLogoutIntent()).resolves.toBe(true)
    await expect(tokenStore.getSafeStorageSessionToken(envKey)).resolves.toBeNull()
    expect(markers.readPendingExternalLogoutIntent(runtime.directory, envKey)).toEqual({
      intent: 'logout-pending',
    })
    expect(notifySessionChanged).toHaveBeenCalledWith(false)
    const restarted = await createService()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(markers.readPendingExternalLogoutIntent(runtime.directory, envKey)).toEqual({
      intent: 'logout-pending',
    })
  })

  it('admits a temporary login after logout when no secure provider is available', async () => {
    const { service, tokenStore, envKey, markers } = await createService()
    await tokenStore.setSafeStorageSessionToken('fixture-file-session', envKey)

    await expect(service.logout()).resolves.toBeUndefined()
    await expect(tokenStore.getSafeStorageSessionToken(envKey)).resolves.toBeNull()
    expect(markers.readPendingExternalLogoutIntent(runtime.directory, envKey)).toEqual({
      intent: 'logout-pending',
    })
    expect(notifySessionChanged).toHaveBeenCalledWith(false)
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    const state = service as unknown as {
      installAuthenticatedLogin: (result: {
        token: string
        me: {
          id: string
          email: string
          name: null
          picture: null
          teamId: string
          teamName: string
          role: string
        }
      }) => Promise<unknown>
    }
    await expect(
      state.installAuthenticatedLogin({
        token: validSessionToken(),
        me: {
          id: 'fixture-user',
          email: 'fixture@example.com',
          name: null,
          picture: null,
          teamId: 'fixture-team',
          teamName: 'Fixture team',
          role: 'member',
        },
      })
    ).resolves.toMatchObject({ authenticated: true, sessionMode: 'temporary' })
    expect(await fs.readdir(runtime.directory)).not.toContain(`session-token-${envKey}.json`)
    const restarted = await createService()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(markers.readPendingExternalLogoutIntent(runtime.directory, envKey)).toMatchObject({
      intent: 'memory-only-session',
    })
  })

  it('retains the memory-only restart fence when external logout cannot verify absent Keytar cleanup', async () => {
    const { service, tokenStore, envKey, markers } = await createService()
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
    await tokenStore.setSafeStorageSessionToken('stale-saved-session', envKey)
    const marker = markers.recordMemoryOnlySessionIfMissing(
      runtime.directory,
      envKey,
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222'
    )
    expect(marker).not.toBeNull()

    await expect(service.applyPendingExternalLogoutIntent()).resolves.toBe(true)

    expect(markers.readPendingExternalLogoutMarker(runtime.directory, envKey)).toEqual(marker)
    await expect(tokenStore.getSafeStorageSessionToken(envKey)).resolves.toBeNull()
    const restarted = await createService()
    const authClient = (
      restarted.service as unknown as {
        authClient: { getMe: (token: string) => Promise<unknown> }
      }
    ).authClient
    const getMe = vi.spyOn(authClient, 'getMe')
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(getMe).not.toHaveBeenCalled()
    expect(markers.readPendingExternalLogoutMarker(runtime.directory, envKey)).toEqual(marker)
  })
})
