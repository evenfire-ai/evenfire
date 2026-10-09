import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const testRuntime = vi.hoisted(() => ({ userDataDirectory: '' }))
const { notifySessionChanged } = vi.hoisted(() => ({ notifySessionChanged: vi.fn() }))

vi.mock('keytar', () => ({}))
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => testRuntime.userDataDirectory),
    isReady: vi.fn(() => true),
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn((value: string) => Buffer.from(value, 'utf8')),
    decryptString: vi.fn((value: Buffer) => value.toString('utf8')),
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

let userDataDirectory = ''
let AppServiceClass: typeof import('../appService.js').AppService
let QuitAdmissionClosedErrorClass: typeof import('../appService.js').QuitAdmissionClosedError
let TokenStoreClass: typeof import('../tokenStore.js').TokenStore
let activeEnvKey = ''
let markerStore: typeof import('../pendingExternalLogout.js')

const user = {
  id: 'user-1',
  email: 'user@example.com',
  name: null,
  picture: null,
  teamId: 'team-1',
  teamName: 'Team 1',
  role: 'member' as const,
}

beforeEach(async () => {
  userDataDirectory = await mkdtemp(path.join(os.tmpdir(), 'evenfire-no-keytar-logout-'))
  testRuntime.userDataDirectory = userDataDirectory
  vi.clearAllMocks()
  vi.resetModules()
  const [appService, tokenStore, marker, config] = await Promise.all([
    import('../appService.js'),
    import('../tokenStore.js'),
    import('../pendingExternalLogout.js'),
    import('../config.js'),
  ])
  AppServiceClass = appService.AppService
  QuitAdmissionClosedErrorClass = appService.QuitAdmissionClosedError
  TokenStoreClass = tokenStore.TokenStore
  markerStore = marker
  activeEnvKey = config.getActiveEnvKey()
  const { safeStorage } = await import('electron')
  vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
})

afterEach(async () => {
  if (userDataDirectory) await rm(userDataDirectory, { recursive: true, force: true })
  userDataDirectory = ''
  testRuntime.userDataDirectory = ''
  vi.resetModules()
})

describe('AppService pending logout when Keytar is unavailable', () => {
  it('keeps a cleanup marker and restores verified safeStorage login while Keytar is unavailable', async () => {
    const tokenStore = new TokenStoreClass()
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
    const service = new AppServiceClass({
      tokenStore,
      getUserDataDirectory: () => userDataDirectory,
    })
    const authClient = (
      service as unknown as {
        authClient: { getMe: (token: string) => Promise<typeof user> }
      }
    ).authClient
    vi.spyOn(authClient, 'getMe').mockResolvedValue(user)
    const internals = service as unknown as {
      sessionToken: string | null
      me: typeof user | null
      quitPreparationStarted: boolean
      installAuthenticatedLogin: (result: { token: string; me: typeof user }) => Promise<unknown>
    }

    await tokenStore.setSessionToken('test-token-old-keychain-session', activeEnvKey)
    internals.sessionToken = 'test-token-old-keychain-session'
    internals.me = user
    internals.quitPreparationStarted = true

    await expect(service.logout()).rejects.toBeInstanceOf(QuitAdmissionClosedErrorClass)
    expect(markerStore.hasPendingExternalLogout(userDataDirectory, activeEnvKey)).toBe(true)

    service.cancelQuitPreparation()
    await expect(service.initialize()).resolves.toEqual({ authenticated: false, me: null })
    expect(markerStore.hasPendingExternalLogout(userDataDirectory, activeEnvKey)).toBe(true)
    await expect(tokenStore.getSessionToken(activeEnvKey)).resolves.toBeNull()

    await expect(
      internals.installAuthenticatedLogin({ token: 'test-token-new-file-backed-session', me: user })
    ).resolves.toEqual({ authenticated: true, me: user })
    expect(markerStore.hasPendingExternalLogout(userDataDirectory, activeEnvKey)).toBe(true)
    await expect(tokenStore.getSessionToken(activeEnvKey)).resolves.toBe(
      'test-token-new-file-backed-session'
    )
    const files = await readdir(userDataDirectory)
    expect(files).toContain(`session-token-${activeEnvKey}.enc`)
    expect(files).not.toContain(`session-token-${activeEnvKey}.json`)
    await expect(service.initialize()).resolves.toEqual({ authenticated: true, me: user })
    expect(markerStore.hasPendingExternalLogout(userDataDirectory, activeEnvKey)).toBe(true)
    await expect(tokenStore.getSessionToken(activeEnvKey)).resolves.toBe(
      'test-token-new-file-backed-session'
    )

    const environmentId = createHash('sha256').update(activeEnvKey).digest('hex')
    const marker = await readFile(
      path.join(userDataDirectory, `pending-external-logout-${environmentId}`),
      'utf8'
    )
    expect(marker).toContain('"intent":"keytar-cleanup-pending"')
    expect(notifySessionChanged).toHaveBeenCalledWith(false)
  })

  it('does not restore a safeStorage token for an active-Keytar cleanup marker', async () => {
    const tokenStore = new TokenStoreClass()
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
    await tokenStore.setSafeStorageSessionToken('stale-safe-storage-token', activeEnvKey)
    markerStore.recordPendingKeytarCleanup(userDataDirectory, activeEnvKey, 'active-keytar')
    const service = new AppServiceClass({
      tokenStore,
      getUserDataDirectory: () => userDataDirectory,
    })
    const authClient = (
      service as unknown as {
        authClient: { getMe: (token: string) => Promise<typeof user> }
      }
    ).authClient
    const getMe = vi.spyOn(authClient, 'getMe')

    await expect(service.initialize()).resolves.toEqual({ authenticated: false, me: null })

    expect(getMe).not.toHaveBeenCalled()
    expect(markerStore.readPendingExternalLogoutIntent(userDataDirectory, activeEnvKey)).toEqual({
      intent: 'keytar-cleanup-pending',
      credentialSource: 'active-keytar',
    })
  })

  it('fails closed without Keytar or safeStorage and never writes a plaintext token', async () => {
    markerStore.recordPendingExternalLogout(userDataDirectory, activeEnvKey)
    const service = new AppServiceClass({
      tokenStore: new TokenStoreClass(),
      getUserDataDirectory: () => userDataDirectory,
    })
    const state = service as unknown as {
      installAuthenticatedLogin: (result: { token: string; me: typeof user }) => Promise<unknown>
      sessionToken: string | null
      me: typeof user | null
    }

    await expect(
      state.installAuthenticatedLogin({ token: 'fixture-new-session-token', me: user })
    ).rejects.toThrow('Electron safeStorage is unavailable for session-token fallback')

    expect(state.sessionToken).toBeNull()
    expect(state.me).toBeNull()
    expect(markerStore.readPendingExternalLogoutIntent(userDataDirectory, activeEnvKey)).toEqual({
      intent: 'logout-pending',
    })
    expect(await readdir(userDataDirectory)).not.toContain(`session-token-${activeEnvKey}.json`)
  })
})
