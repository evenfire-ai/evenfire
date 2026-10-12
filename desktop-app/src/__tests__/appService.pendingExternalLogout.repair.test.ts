import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import fsSync from 'node:fs'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const runtime = vi.hoisted(() => ({ directory: '' }))
const { notifySessionChanged } = vi.hoisted(() => ({ notifySessionChanged: vi.fn() }))
const keychain = new Map<string, string>()
const keyOf = (service: string, account: string) => `${service}::${account}`
const keytarMock = {
  getPassword: vi.fn(
    async (service: string, account: string) => keychain.get(keyOf(service, account)) ?? null
  ),
  setPassword: vi.fn(async (service: string, account: string, token: string) => {
    keychain.set(keyOf(service, account), token)
  }),
  deletePassword: vi.fn(async (service: string, account: string) =>
    keychain.delete(keyOf(service, account))
  ),
}

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => runtime.directory), isReady: vi.fn(() => true) },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(`encrypted:${value}`)),
    decryptString: vi.fn((value: Buffer) => value.toString().replace(/^encrypted:/, '')),
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

const me = {
  id: 'fixture-user',
  email: 'fixture@example.com',
  name: null,
  picture: null,
  teamId: 'fixture-home-team',
  teamName: 'Fixture home team',
  role: 'member',
}

beforeEach(async () => {
  vi.clearAllMocks()
  vi.resetModules()
  keychain.clear()
  keytarMock.getPassword
    .mockReset()
    .mockImplementation(async (service, account) => keychain.get(keyOf(service, account)) ?? null)
  keytarMock.setPassword.mockReset().mockImplementation(async (service, account, token) => {
    keychain.set(keyOf(service, account), token)
  })
  keytarMock.deletePassword
    .mockReset()
    .mockImplementation(async (service, account) => keychain.delete(keyOf(service, account)))
  vi.doMock('keytar', () => keytarMock)
  runtime.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-marker-login-repair-'))
  const { safeStorage } = await import('electron')
  vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
})

afterEach(async () => {
  vi.restoreAllMocks()
  if (runtime.directory) await fs.rm(runtime.directory, { recursive: true, force: true })
  runtime.directory = ''
  keychain.clear()
  vi.resetModules()
})

async function createService(options: { isolated?: boolean } = {}) {
  const [{ AppService }, { TokenStore }, config, markers] = await Promise.all([
    import('../appService.js'),
    import('../tokenStore.js'),
    import('../config.js'),
    import('../pendingExternalLogout.js'),
  ])
  const tokenStore = new TokenStore(
    options.isolated ? { isolatedUserDataPath: runtime.directory } : {}
  )
  const reportFailure = vi.fn()
  const service = new AppService({
    tokenStore,
    getUserDataDirectory: () => runtime.directory,
    reportDeferredLogoutFailure: reportFailure,
  })
  const envKey = config.getActiveEnvKey()
  const markerPath = path.join(
    runtime.directory,
    `pending-external-logout-${createHash('sha256').update(envKey).digest('hex')}`
  )
  // Only the external auth boundary is stubbed; marker and credential producers are real.
  const authClient = (
    service as unknown as {
      authClient: {
        getMe: (token: string) => Promise<typeof me>
        switchTeam: (token: string, teamId: string) => Promise<{ token: string }>
      }
    }
  ).authClient
  vi.spyOn(authClient, 'getMe').mockResolvedValue(me)
  const login = (token = 'fixture-fresh-session') =>
    (
      service as unknown as {
        installAuthenticatedLogin: (result: { token: string; me: typeof me }) => Promise<unknown>
      }
    ).installAuthenticatedLogin({ token, me })
  return { service, tokenStore, reportFailure, markers, envKey, markerPath, authClient, login }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(innerResolve => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

describe('explicit login repair uses the pending-logout storage plan', () => {
  it('recovers malformed regular bytes with failing Keytar and verified safeStorage', async () => {
    const harness = await createService()
    await fs.writeFile(harness.markerPath, '{malformed')
    keytarMock.getPassword.mockRejectedValue(new Error('fixture-Keytar unavailable'))
    keytarMock.setPassword.mockRejectedValue(new Error('fixture-Keytar unavailable'))
    keytarMock.deletePassword.mockRejectedValue(new Error('fixture-Keytar unavailable'))

    await expect(harness.login()).resolves.toEqual({ authenticated: true, me })

    expect(await harness.tokenStore.getSafeStorageSessionToken(harness.envKey)).toBe(
      'fixture-fresh-session'
    )
    expect(
      harness.markers.readPendingExternalLogoutIntent(runtime.directory, harness.envKey)
    ).toEqual({
      intent: 'keytar-cleanup-pending',
      credentialSource: 'safe-storage',
    })
    expect(harness.service.getCachedUserId()).toBe(me.id)
    expect(harness.reportFailure).toHaveBeenCalled()
    expect(await fs.readdir(runtime.directory)).not.toContain(
      `session-token-${harness.envKey}.json`
    )
    const restarted = await createService()
    await expect(restarted.service.initialize()).resolves.toEqual({ authenticated: true, me })
    expect(restarted.authClient.getMe).toHaveBeenCalledWith('fixture-fresh-session')
  })

  it('recovers malformed regular bytes when the Keytar module is absent', async () => {
    vi.doMock('keytar', () => ({}))
    const harness = await createService()
    await fs.writeFile(harness.markerPath, '{malformed')

    await expect(harness.login()).resolves.toEqual({ authenticated: true, me })

    expect(await harness.tokenStore.getSafeStorageSessionToken(harness.envKey)).toBe(
      'fixture-fresh-session'
    )
    expect(
      harness.markers.readPendingExternalLogoutIntent(runtime.directory, harness.envKey)
    ).toEqual({
      intent: 'keytar-cleanup-pending',
      credentialSource: 'safe-storage',
    })
    expect(await fs.readdir(runtime.directory)).not.toContain(
      `session-token-${harness.envKey}.json`
    )
  })

  it('converts normalized logout intent after an active-Keytar replacement write fails', async () => {
    const harness = await createService()
    await fs.writeFile(harness.markerPath, '{malformed')
    keytarMock.deletePassword.mockImplementation(async (service, account) => {
      if (account === `session-token::${harness.envKey}`)
        throw new Error('fixture-active delete failed')
      return keychain.delete(keyOf(service, account))
    })
    keytarMock.setPassword.mockRejectedValue(new Error('fixture-active write failed'))

    await expect(harness.login()).resolves.toEqual({ authenticated: true, me })

    expect(await harness.tokenStore.getSafeStorageSessionToken(harness.envKey)).toBe(
      'fixture-fresh-session'
    )
    expect(
      harness.markers.readPendingExternalLogoutIntent(runtime.directory, harness.envKey)
    ).toEqual({
      intent: 'keytar-cleanup-pending',
      credentialSource: 'safe-storage',
    })
  })

  it('allows a first isolated-development login without secure storage after malformed repair', async () => {
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    const harness = await createService({ isolated: true })
    await fs.writeFile(harness.markerPath, '{malformed')

    await expect(harness.login()).resolves.toEqual({ authenticated: true, me })

    expect(await harness.tokenStore.getSessionToken(harness.envKey)).toBe('fixture-fresh-session')
    expect(
      harness.markers.readPendingExternalLogoutMarker(runtime.directory, harness.envKey)
    ).toBeNull()
    expect(keytarMock.setPassword).not.toHaveBeenCalled()
    expect(await fs.readdir(runtime.directory)).toContain(`session-token-${harness.envKey}.json`)
  })

  it('normalizes the content hash before asynchronous cleanup begins', async () => {
    const harness = await createService()
    await fs.writeFile(harness.markerPath, '{malformed')
    const entered = deferred()
    const release = deferred()
    keytarMock.deletePassword.mockImplementationOnce(async () => {
      entered.resolve()
      await release.promise
      return false
    })
    const result = harness.login()
    await entered.promise
    let marker: ReturnType<typeof harness.markers.readPendingExternalLogoutMarker> | undefined
    let inspectionError: unknown
    try {
      marker = harness.markers.readPendingExternalLogoutMarker(runtime.directory, harness.envKey)
    } catch (error) {
      inspectionError = error
    } finally {
      release.resolve()
      await result
    }

    expect(inspectionError).toBeUndefined()
    expect(marker?.intent).toEqual({ intent: 'logout-pending' })
    expect(marker?.revision).toEqual(expect.any(String))
  })

  it('preserves the exact newer logout revision during a secure login write', async () => {
    const harness = await createService()
    await fs.writeFile(harness.markerPath, '{malformed')
    let newerMarker: ReturnType<typeof harness.markers.readPendingExternalLogoutMarker> | undefined
    keytarMock.setPassword.mockImplementation(async (service, account, token) => {
      keychain.set(keyOf(service, account), token)
      harness.markers.recordPendingExternalLogout(runtime.directory, harness.envKey)
      newerMarker = harness.markers.readPendingExternalLogoutMarker(
        runtime.directory,
        harness.envKey
      )
    })

    await expect(harness.login()).rejects.toThrow('Pending logout intent changed')

    expect(
      harness.markers.readPendingExternalLogoutMarker(runtime.directory, harness.envKey)
    ).toEqual(newerMarker)
    expect(harness.service.getCachedUserId()).toBeNull()
    expect(await harness.tokenStore.getKeytarSessionToken(harness.envKey)).toBeNull()
    expect(notifySessionChanged).toHaveBeenCalledWith(false)
  })
})

describe('team persistence respects pending-marker authority', () => {
  it('reports marker corruption and clears runtime authentication before team persistence', async () => {
    const harness = await createService()
    await harness.login()
    await fs.writeFile(harness.markerPath, '{malformed')
    const writeToken = vi.spyOn(harness.tokenStore, 'setSessionToken')
    vi.spyOn(harness.authClient, 'switchTeam').mockResolvedValue({
      token: 'fixture-other-team-session',
    })

    await expect(harness.service.switchTeam('fixture-other-team')).rejects.toThrow('invalid format')

    expect(harness.service.getCachedUserId()).toBeNull()
    expect(writeToken).not.toHaveBeenCalled()
    expect(harness.reportFailure).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Pending logout marker has an invalid format' })
    )
    expect(notifySessionChanged).toHaveBeenCalledWith(false)
    expect(await fs.readFile(harness.markerPath, 'utf8')).toBe('{malformed')
  })
})
