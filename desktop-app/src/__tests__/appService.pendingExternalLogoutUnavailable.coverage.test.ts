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

// Characterization of the accepted missing-Keytar trade-off, not a new storage policy.
describe('pending logout without a Keytar module', () => {
  it('allows ordinary no-marker logout after file cleanup when Keytar is missing', async () => {
    const { service, tokenStore, envKey, markers } = await createService()
    await tokenStore.setSafeStorageSessionToken('fixture-file-session', envKey)

    await expect(service.logout()).resolves.toBeUndefined()
    await expect(tokenStore.getSafeStorageSessionToken(envKey)).resolves.toBeNull()
    expect(markers.readPendingExternalLogoutMarker(runtime.directory, envKey)).toBeNull()
    expect(notifySessionChanged).toHaveBeenCalledWith(false)
  })
})
