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
      passwordLogin: (
        email: string,
        password: string
      ) => Promise<{ token: string; me: typeof homeMe }>
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
      const config = await import('../config.js')
      await config.saveDesktopRuntimeConfig({
        externalRestApiBaseUrl: 'https://auth.nullable-repair.test/api',
        rpcProxyBaseUrl: 'https://rpc.nullable-repair.test',
        appName: 'Evenfire Test',
      })
      const h = await harness()
      const { safeStorage } = await import('electron')
      vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
      let written = false
      let readbackRejected = false
      let deletionAcknowledged = false
      let locked = false
      let candidateAccount: string | null = null
      boundary.setPassword.mockImplementation(async (service, account, token) => {
        boundary.keychain.set(keyOf(service, account), token)
        const normalizedAccount = String(account)
        if (normalizedAccount.startsWith('session-v1:')) {
          candidateAccount = normalizedAccount
          written = true
        }
      })
      boundary.getPassword.mockImplementation(async (service, account) => {
        const token = boundary.keychain.get(keyOf(service, account)) ?? null
        if (locked) throw new Error('fixture-keyring locked after false deletion')
        if (written && String(account) === candidateAccount && !readbackRejected) {
          readbackRejected = true
          return `${token ?? ''}-fixture-rejected-read-back`
        }
        return token
      })
      boundary.deletePassword.mockImplementation(async (service, account) => {
        if (
          String(account) === candidateAccount &&
          boundary.keychain.has(keyOf(service, account))
        ) {
          deletionAcknowledged = true
          locked = true
          return acknowledgement
        }
        return boundary.keychain.delete(keyOf(service, account))
      })
      const passwordLogin = vi.spyOn(h.state.authClient, 'passwordLogin').mockResolvedValueOnce({
        token: homeToken,
        me: homeMe,
      })
      const rejected = await h.service.passwordLogin(homeMe.email, 'fixture-password').then(
        () => null,
        error => error
      )
      expect(rejected).toBeInstanceOf(Error)
      expect(passwordLogin).toHaveBeenCalledOnce()
      expect(readbackRejected).toBe(true)
      expect(deletionAcknowledged).toBe(true)
      expect(locked).toBe(true)
      const rejectedCandidateEntry = [...boundary.keychain.entries()].find(([account]) =>
        account.includes('session-v1:')
      )
      expect(rejectedCandidateEntry?.[0]).toContain('session-v1:')
      expect(rejectedCandidateEntry?.[1]).toContain(homeToken)
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
