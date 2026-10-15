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
const teamToken = 'fixture-journal-team'
const freshToken = 'fixture-journal-fresh'
const homeMe = {
  id: 'fixture-journal-home-user',
  email: 'fixture-journal@example.com',
  name: null,
  picture: null,
  teamId: 'fixture-home',
  teamName: 'Fixture home',
  role: 'member',
}
const freshMe = { ...homeMe, id: 'fixture-journal-fresh-user' }
const userFor = (token: string) =>
  token === freshToken
    ? freshMe
    : { ...homeMe, teamId: token === teamToken ? 'fixture-team' : homeMe.teamId }
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
      switchTeam: (token: string, teamId: string) => Promise<{ token: string }>
    }
  }
  vi.spyOn(state.authClient, 'getMe').mockImplementation(async token => userFor(token))
  vi.spyOn(state.authClient, 'switchTeam').mockResolvedValue({ token: teamToken })
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

describe('R21-M6 terminal live recovery metadata remains a pure ownership check', () => {
  it('does not add a marker read after actual prior repair and journal retirement', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    boundary.setPassword.mockImplementationOnce(async (service, account, token) => {
      boundary.keychain.set(keyOf(service, account), token)
      throw new Error('fixture-Fresh setter rejected after publication')
    })
    const fsSync = (await import('node:fs')).default
    const actualOpen = fsSync.openSync.bind(fsSync)
    let nextMarkerReadFails = false
    let readFailed = false
    vi.spyOn(fsSync, 'openSync').mockImplementation((file, flags, mode) => {
      if (nextMarkerReadFails && String(file) === h.markerPath) {
        nextMarkerReadFails = false
        readFailed = true
        throw Object.assign(new Error('fixture-last prior marker EMFILE'), { code: 'EMFILE' })
      }
      return actualOpen(file, flags, mode)
    })
    const recovery = h.service as unknown as {
      retireRepairedPersistenceProducer: (producer: unknown) => Promise<void>
    }
    const actualRetire = recovery.retireRepairedPersistenceProducer.bind(recovery)
    vi.spyOn(recovery, 'retireRepairedPersistenceProducer').mockImplementationOnce(
      async producer => {
        await actualRetire(producer)
        nextMarkerReadFails = true
      }
    )
    const notifyBefore = boundary.notifySessionChanged.mock.calls.length
    const error = await h.state.installAuthenticatedLogin({ token: freshToken, me: freshMe }).then(
      () => null,
      error => error
    )
    expect(error).toBeInstanceOf(Error)
    expect(await h.tokenStore.getKeytarSessionToken(h.envKey)).toBe(homeToken)
    const liveToken = h.state.sessionToken
    const liveMe = h.state.me
    const notifications = boundary.notifySessionChanged.mock.calls.slice(notifyBefore)
    // The metadata fence has no filesystem observation; the armed historical
    // EMFILE target must remain undispatched. Reset it before actual restart.
    nextMarkerReadFails = false
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: homeMe,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(freshToken)
    expect(liveToken).toBe(homeToken)
    expect(liveMe).toEqual(homeMe)
    expect(notifications).not.toContainEqual([false])
    expect(readFailed).toBe(false)
  })
})
