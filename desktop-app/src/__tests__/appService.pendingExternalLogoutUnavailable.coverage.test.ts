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
vi.mock('../chatStoreBinding.js', async () => {
  const { createChatStoreBindingMock } = await import('../../testSupport/chatStoreBindingMock.js')
  return createChatStoreBindingMock()
})
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

describe('pending logout without a Keytar module', () => {
  it('does not restore historical safeStorage credentials under a legacy LP marker', async () => {
    const { service, tokenStore, envKey, markers } = await createService()
    await tokenStore.setSafeStorageSessionToken('fixture-stale-file-session', envKey)
    markers.recordPendingExternalLogout(runtime.directory, envKey)
    const authClient = (
      service as unknown as { authClient: { getMe: (token: string) => Promise<unknown> } }
    ).authClient
    const initialGetMe = vi.spyOn(authClient, 'getMe')

    await expect(service.initialize()).resolves.toEqual({ authenticated: false, me: null })

    expect(initialGetMe).not.toHaveBeenCalled()
    await expect(tokenStore.getSafeStorageSessionToken(envKey)).resolves.toBe(
      'fixture-stale-file-session'
    )
    expect(markers.readPendingExternalLogoutIntent(runtime.directory, envKey)).toEqual({
      intent: 'logout-pending',
    })
    const restarted = await createService()
    const restartedAuth = (
      restarted.service as unknown as { authClient: { getMe: ReturnType<typeof vi.fn> } }
    ).authClient
    const restartedGetMe = vi.spyOn(restartedAuth, 'getMe')
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(restartedGetMe).not.toHaveBeenCalled()
    expect(markers.readPendingExternalLogoutIntent(runtime.directory, envKey)).toEqual({
      intent: 'logout-pending',
    })
  })

  it('preserves historical safeStorage bytes when a fresh password login is rejected', async () => {
    const config = await import('../config.js')
    await config.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: 'https://auth.example.test/api',
      rpcProxyBaseUrl: '',
    })
    const { service, tokenStore, envKey, markers } = await createService()
    await tokenStore.setSafeStorageSessionToken('fixture-file-session', envKey)
    const safeStorageSourcePath = path.join(runtime.directory, `session-token-${envKey}.enc`)
    const originalSafeStorageBytes = await fs.readFile(safeStorageSourcePath)
    const authClient = (
      service as unknown as {
        authClient: { passwordLogin: (email: string, password: string) => Promise<unknown> }
      }
    ).authClient
    vi.spyOn(authClient, 'passwordLogin').mockRejectedValue(new Error('synthetic login rejection'))

    await expect(
      service.passwordLogin('fixture@example.com', 'synthetic-password')
    ).rejects.toThrow('synthetic login rejection')

    await expect(tokenStore.getSafeStorageSessionToken(envKey)).resolves.toBe(
      'fixture-file-session'
    )
    expect(markers.readPendingExternalLogoutIntent(runtime.directory, envKey)).toBeNull()
    await expect(fs.readFile(safeStorageSourcePath)).resolves.toEqual(originalSafeStorageBytes)
  })

  it('retains memory-only denial without deleting saved sources absent durable logout debt', async () => {
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

    await expect(service.applyPendingExternalLogoutIntent()).resolves.toBe(false)

    expect(markers.readPendingExternalLogoutMarker(runtime.directory, envKey)).toEqual(marker)
    await expect(tokenStore.getSafeStorageSessionToken(envKey)).resolves.toBe('stale-saved-session')
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
