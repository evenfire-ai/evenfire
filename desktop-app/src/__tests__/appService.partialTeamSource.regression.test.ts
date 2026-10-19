import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import fsSync from 'node:fs'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const runtime = vi.hoisted(() => ({ directory: '', keychain: new Map<string, string>() }))
const boundary = vi.hoisted(() => ({
  getPassword: vi.fn(),
  setPassword: vi.fn(),
  deletePassword: vi.fn(),
  notifySessionChanged: vi.fn(),
}))
const keyOf = (service: string, account: string) => `${service}::${account}`
vi.mock('keytar', () => boundary)
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => runtime.directory), isReady: vi.fn(() => true) },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    getSelectedStorageBackend: () => 'gnome_libsecret',
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
  tryGetPluginSdkRuntime: () => ({
    notifySessionChanged: boundary.notifySessionChanged,
    unpinAllSandboxUiSurfaces: vi.fn(),
  }),
}))

const homeToken = 'fixture-r21-home-session'
const teamToken = 'fixture-r21-team-session'
const homeMe = {
  id: 'fixture-r21-user',
  email: 'fixture-r21@example.com',
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
  runtime.keychain.clear()
  runtime.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-r21-marker-'))
  boundary.getPassword
    .mockReset()
    .mockImplementation(
      async (service, account) => runtime.keychain.get(keyOf(service, account)) ?? null
    )
  boundary.setPassword.mockReset().mockImplementation(async (service, account, token) => {
    runtime.keychain.set(keyOf(service, account), token)
  })
  boundary.deletePassword
    .mockReset()
    .mockImplementation(async (service, account) =>
      runtime.keychain.delete(keyOf(service, account))
    )
  const { safeStorage } = await import('electron')
  vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(runtime.directory, { recursive: true, force: true })
  runtime.directory = ''
  runtime.keychain.clear()
  vi.resetModules()
})

async function harness(options: { isolated?: boolean } = {}) {
  const [{ AppService }, { TokenStore }, markers, config] = await Promise.all([
    import('../appService.js'),
    import('../tokenStore.js'),
    import('../pendingExternalLogout.js'),
    import('../config.js'),
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
  const state = service as unknown as {
    sessionToken: string | null
    me: typeof homeMe | null
    installAuthenticatedLogin: (result: { token: string; me: typeof homeMe }) => Promise<unknown>
    runWithTeamContext: <T>(team: string, operation: (token: string) => Promise<T>) => Promise<T>
    authClient: {
      getMe: (token: string) => Promise<typeof homeMe>
      switchTeam: (token: string, teamId: string) => Promise<{ token: string }>
    }
  }
  vi.spyOn(state.authClient, 'getMe').mockImplementation(async token => ({
    ...homeMe,
    teamId: token === teamToken ? 'fixture-other' : homeMe.teamId,
  }))
  vi.spyOn(state.authClient, 'switchTeam').mockImplementation(async (_token, team) => ({
    token: team === homeMe.teamId ? homeToken : teamToken,
  }))
  const envKey = config.getActiveEnvKey()
  const markerPath = path.join(
    runtime.directory,
    `pending-external-logout-${createHash('sha256').update(envKey).digest('hex')}`
  )
  return { service, tokenStore, markers, envKey, markerPath, state, reportFailure }
}

describe('R21-M7 installed team source cleanup', () => {
  it('repairs a rejected final team acceptance observation before clearing its runtime', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    let acceptanceReached = false
    let failed = false
    boundary.notifySessionChanged.mockImplementation((authenticated: boolean) => {
      if (authenticated) acceptanceReached = true
    })
    const open = fsSync.openSync.bind(fsSync)
    vi.spyOn(fsSync, 'openSync').mockImplementation((file, flags, mode) => {
      if (acceptanceReached && !failed && String(file) === h.markerPath) {
        failed = true
        throw Object.assign(new Error('fixture-final acceptance observation'), { code: 'EMFILE' })
      }
      return open(file, flags, mode)
    })
    const error = await h.service.switchTeam('fixture-other').then(
      () => null,
      error => error
    )
    vi.restoreAllMocks()
    expect(acceptanceReached).toBe(true)
    expect(failed).toBe(true)
    const rejectedRuntime = h.state.sessionToken
    const restarted = await harness()
    await restarted.service.initialize()
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(teamToken)
    expect(rejectedRuntime).toBeNull()
    expect(await h.tokenStore.getKeytarSessionToken(h.envKey)).toBe(homeToken)
    expect(h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)).toBeNull()
    const journal = await import('../sessionPersistenceJournal.js')
    expect(journal.readSessionPersistenceJournal(runtime.directory, h.envKey)).toBeNull()
    expect(error).toBeInstanceOf(Error)
  })

  it('does not restore a rejected team session after transient cleanup-source inspection', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    const state = h.service as unknown as {
      suspendDesktopGfsUploadsForAuthBoundary: () => Promise<void>
    }
    vi.spyOn(state, 'suspendDesktopGfsUploadsForAuthBoundary').mockRejectedValueOnce(
      new Error('fixture-genuine GFS boundary failed')
    )
    const getMe = vi.mocked(h.state.authClient.getMe).getMockImplementation()!
    let armed = false
    vi.mocked(h.state.authClient.getMe).mockImplementation(async token => {
      const me = await getMe(token)
      if (token === teamToken) armed = true
      return me
    })
    const open = fsSync.openSync.bind(fsSync)
    const spy = vi.spyOn(fsSync, 'openSync').mockImplementation((file, flags, mode) => {
      if (String(file) === h.markerPath && armed) {
        armed = false
        throw Object.assign(new Error('fixture-GFS cleanup marker EMFILE'), { code: 'EMFILE' })
      }
      return open(file, flags, mode)
    })
    const error = await h.service.switchTeam('fixture-other').then(
      () => null,
      error => error
    )
    spy.mockRestore()
    expect(error).toBeInstanceOf(Error)
    expect(h.state.sessionToken).toBeNull()
    expect(h.state.me).toBeNull()
    expect(await h.tokenStore.getKeytarSessionToken(h.envKey)).toBe(homeToken)
    expect(h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)).toBeNull()
    const restarted = await harness()
    const result = await restarted.service.initialize()
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(teamToken)
    expect(result.me?.teamId).not.toBe('fixture-other')
  })
})
