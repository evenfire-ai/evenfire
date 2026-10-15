import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const boundary = vi.hoisted(() => ({
  directory: '',
  keychain: new Map<string, string>(),
  getPassword: vi.fn(),
  setPassword: vi.fn(),
  deletePassword: vi.fn(),
  notifySessionChanged: vi.fn(),
}))
const keyOf = (service: string, account: string) => `${service}::${account}`
vi.mock('keytar', () => boundary)
vi.mock('electron', () => ({
  app: { getPath: () => boundary.directory, isReady: () => true },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
    decryptString: (value: Buffer) => value.toString().replace(/^encrypted:/, ''),
  },
}))
vi.mock('../chatStoreBinding.js', () => ({
  bindChatStoreForUser: vi.fn(),
  unbindChatStore: vi.fn(),
  __setChatStoreBaseDirForTests: vi.fn(),
}))
vi.mock('../pluginSdkRuntime.js', () => ({
  tryGetPluginSdkRuntime: () => ({
    notifySessionChanged: boundary.notifySessionChanged,
    unpinAllSandboxUiSurfaces: vi.fn(),
  }),
}))

const homeToken = 'fixture-journal-home'
const homeMe = {
  id: 'fixture-journal-home-user',
  email: 'fixture-journal@example.com',
  name: null,
  picture: null,
  teamId: 'fixture-home',
  teamName: 'Fixture home',
  role: 'member',
}
beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.doMock('keytar', () => boundary)
  boundary.keychain.clear()
  boundary.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-journal-producer-'))
  boundary.getPassword
    .mockReset()
    .mockImplementation(
      async (service, account) => boundary.keychain.get(keyOf(service, account)) ?? null
    )
  boundary.setPassword.mockReset().mockImplementation(async (service, account, token) => {
    boundary.keychain.set(keyOf(service, account), token)
  })
  boundary.deletePassword
    .mockReset()
    .mockImplementation(async (service, account) =>
      boundary.keychain.delete(keyOf(service, account))
    )
  boundary.notifySessionChanged.mockReset()
  const { safeStorage } = await import('electron')
  vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(boundary.directory, { recursive: true, force: true })
  boundary.directory = ''
  boundary.keychain.clear()
  vi.resetModules()
})

async function harness() {
  const [{ AppService }, { TokenStore }, markers, journal, config] = await Promise.all([
    import('../appService.js'),
    import('../tokenStore.js'),
    import('../pendingExternalLogout.js'),
    import('../sessionPersistenceJournal.js'),
    import('../config.js'),
  ])
  const tokenStore = new TokenStore()
  const reportFailure = vi.fn()
  const service = new AppService({
    tokenStore,
    getUserDataDirectory: () => boundary.directory,
    reportDeferredLogoutFailure: reportFailure,
  })
  const state = service as unknown as {
    sessionToken: string | null
    me: typeof homeMe | null
    installAuthenticatedLogin: (value: { token: string; me: typeof homeMe }) => Promise<unknown>
    authClient: {
      getMe: (token: string) => Promise<typeof homeMe>
    }
  }
  vi.spyOn(state.authClient, 'getMe').mockResolvedValue(homeMe)
  const envKey = config.getActiveEnvKey()
  const digest = createHash('sha256').update(envKey).digest('hex')
  return {
    service,
    state,
    tokenStore,
    markers,
    journal,
    envKey,
    reportFailure,
    journalPath: path.join(boundary.directory, `session-persistence-journal-${digest}`),
    markerPath: path.join(boundary.directory, `pending-external-logout-${digest}`),
    encryptedPath: path.join(boundary.directory, `session-token-${envKey}.enc`),
  }
}

describe('R21-M14 nullable native rollback requires verified absence', () => {
  it.each([false, true])(
    'denies a rejected login when deletion returns %s but retains its native token',
    async acknowledgement => {
      const h = await harness()
      const { safeStorage } = await import('electron')
      vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
      let written = false
      let readbackRejected = false
      let deletionAcknowledged = false
      let locked = false
      boundary.setPassword.mockImplementation(async (service, account, token) => {
        boundary.keychain.set(keyOf(service, account), token)
        written = true
      })
      boundary.getPassword.mockImplementation(async (service, account) => {
        const token = boundary.keychain.get(keyOf(service, account)) ?? null
        if (locked) throw new Error('fixture-keyring locked after false deletion')
        if (written && token === homeToken && !readbackRejected) {
          readbackRejected = true
          return 'fixture-rejected read-back'
        }
        return token
      })
      boundary.deletePassword.mockImplementation(async (service, account) => {
        if (boundary.keychain.get(keyOf(service, account)) === homeToken) {
          deletionAcknowledged = true
          locked = true
          return acknowledgement
        }
        return boundary.keychain.delete(keyOf(service, account))
      })
      const rejected = await h.state
        .installAuthenticatedLogin({ token: homeToken, me: homeMe })
        .then(
          () => null,
          error => error
        )
      expect(rejected).toBeInstanceOf(Error)
      expect(readbackRejected).toBe(true)
      expect(deletionAcknowledged).toBe(true)
      expect(locked).toBe(true)
      expect([...boundary.keychain.values()]).toContain(homeToken)
      locked = false
      const restart = await harness()
      await expect(restart.service.initialize()).resolves.toEqual({
        authenticated: false,
        me: null,
      })
      expect(restart.state.authClient.getMe).not.toHaveBeenCalledWith(homeToken)
      expect(h.state.sessionToken).toBeNull()
      expect(h.state.me).toBeNull()
    }
  )
})
