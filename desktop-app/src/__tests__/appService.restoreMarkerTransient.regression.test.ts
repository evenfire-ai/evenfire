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

describe('R21-M6 live restore retains verified authority after transient inspection', () => {
  it('preserves live CP-S Home when the actual selected encrypted read is transient', async () => {
    boundary.setPassword.mockImplementation(async () => {
      throw new Error('fixture-native setter unavailable before publication')
    })
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    // Historical heads did not bind ordinary encrypted login automatically.
    // This is the real marker producer over the already verified encrypted token.
    h.markers.recordPendingKeytarCleanup(runtime.directory, h.envKey, 'safe-storage')
    const marker = h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)
    const encryptedPath = path.join(runtime.directory, `session-token-${h.envKey}.enc`)
    const read = fs.readFile.bind(fs)
    const open = fsSync.openSync.bind(fsSync)
    let injected = false
    const failRead = (file: unknown) => {
      if (!injected && String(file) === encryptedPath) {
        injected = true
        throw Object.assign(new Error('fixture-selected encrypted read'), { code: 'EMFILE' })
      }
    }
    vi.spyOn(fs, 'readFile').mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
      failRead(args[0])
      return read(...args)
    })
    vi.spyOn(fsSync, 'openSync').mockImplementation(
      (...args: Parameters<typeof fsSync.openSync>) => {
        failRead(args[0])
        return open(...args)
      }
    )
    boundary.notifySessionChanged.mockClear()
    const result = await h.service.initialize()
    expect(injected).toBe(true)
    await expect(h.tokenStore.getSafeStorageSessionToken(h.envKey)).resolves.toBe(homeToken)
    expect(h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)).toEqual(marker)
    expect(result.authenticated).toBe(true)
    expect(h.state.sessionToken).toBe(homeToken)
    expect(h.state.me).toEqual(homeMe)
    expect(h.state.authClient.getMe).not.toHaveBeenCalled()
    expect(boundary.notifySessionChanged).not.toHaveBeenCalledWith(false)
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: homeMe,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(homeToken)
  })

  it('preserves live native authority after a transient fallback-file snapshot read', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    const encryptedPath = path.join(runtime.directory, `session-token-${h.envKey}.enc`)
    const open = fsSync.openSync.bind(fsSync)
    let injected = false
    vi.spyOn(fsSync, 'openSync').mockImplementation(
      (...args: Parameters<typeof fsSync.openSync>) => {
        if (!injected && String(args[0]) === encryptedPath) {
          injected = true
          throw Object.assign(new Error('fixture-fallback-snapshot-read'), { code: 'EMFILE' })
        }
        return open(...args)
      }
    )
    boundary.notifySessionChanged.mockClear()
    const result = await h.service.initialize()
    expect(injected).toBe(true)
    expect(result.authenticated).toBe(true)
    expect(h.state.sessionToken).toBe(homeToken)
    expect(h.state.me).toEqual(homeMe)
    expect(boundary.notifySessionChanged).not.toHaveBeenCalledWith(false)
    await expect(h.tokenStore.getKeytarSessionToken(h.envKey)).resolves.toBe(homeToken)
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: homeMe,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(homeToken)
  })

  it('preserves an already authenticated session when journal descriptor close is transient', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    const { SessionPersistenceProducer } = await import('../sessionPersistenceJournal.js')
    new SessionPersistenceProducer(
      runtime.directory,
      h.envKey,
      null,
      () => {},
      () => {}
    ).prepare('keytar', 'fixture-independent-unaccepted')
    const open = fsSync.openSync.bind(fsSync)
    const close = fsSync.closeSync.bind(fsSync)
    const descriptors = new Set<number>()
    let injected = false
    vi.spyOn(fsSync, 'openSync').mockImplementation(
      (...args: Parameters<typeof fsSync.openSync>) => {
        const descriptor = open(...args)
        if (String(args[0]).includes('session-persistence-journal-')) descriptors.add(descriptor)
        return descriptor
      }
    )
    vi.spyOn(fsSync, 'closeSync').mockImplementation(descriptor => {
      close(descriptor)
      if (descriptors.delete(descriptor) && !injected) {
        injected = true
        throw Object.assign(new Error('fixture-journal-close'), { code: 'EINTR' })
      }
    })
    boundary.notifySessionChanged.mockClear()
    const result = await h.service.initialize()
    expect(injected).toBe(true)
    expect(result.authenticated).toBe(true)
    expect(h.state.sessionToken).toBe(homeToken)
    expect(h.state.me).toEqual(homeMe)
    expect(boundary.notifySessionChanged).not.toHaveBeenCalledWith(false)
    await expect(h.tokenStore.getKeytarSessionToken(h.envKey)).resolves.toBe(homeToken)
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: homeMe,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(homeToken)
  })

  it('preserves live Home after a transient second journal read without announcing logout', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    boundary.notifySessionChanged.mockClear()
    const journalPath = path.join(
      runtime.directory,
      `session-persistence-journal-${createHash('sha256').update(h.envKey).digest('hex')}`
    )
    const open = fsSync.openSync.bind(fsSync)
    let journalReads = 0
    let faultReached = false
    vi.spyOn(fsSync, 'openSync').mockImplementation((file, flags, mode) => {
      if (String(file) === journalPath) {
        journalReads += 1
        if (journalReads === 2) {
          faultReached = true
          throw Object.assign(new Error('fixture-transient second journal read'), {
            code: 'EMFILE',
          })
        }
      }
      return open(file, flags, mode)
    })

    const result = await h.service.initialize()

    expect(faultReached).toBe(true)
    expect(await h.tokenStore.getKeytarSessionToken(h.envKey)).toBe(homeToken)
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: homeMe,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(homeToken)
    expect(h.service.getCachedUserId()).toBe(homeMe.id)
    expect(result).toEqual({ authenticated: true, me: homeMe })
    expect(h.state.sessionToken).toBe(homeToken)
    expect(boundary.notifySessionChanged).not.toHaveBeenCalledWith(false)
  })

  it('denies the owned recovery runtime when its genuine Home chat rebind fails', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    const freshToken = 'fixture-rejected-recovery-binding-session'
    const owner = h.service as unknown as {
      bindCurrentChatStore: (userId: string) => Promise<void>
    }
    const bind = owner.bindCurrentChatStore.bind(owner)
    let freshBound = false
    let recoveryAttempted = false
    let readFailed = false
    // Home and Fresh have distinct identities; only the restored Home rebind fails.
    vi.spyOn(owner, 'bindCurrentChatStore').mockImplementation(async userId => {
      if (freshBound && userId === homeMe.id) {
        recoveryAttempted = true
        throw new Error('fixture-genuine Home chat rebind failed')
      }
      await bind(userId)
      if (userId === 'fixture-new-user') freshBound = true
    })
    const open = fsSync.openSync.bind(fsSync)
    vi.spyOn(fsSync, 'openSync').mockImplementation((file, flags, mode) => {
      if (freshBound && !readFailed && String(file) === h.markerPath) {
        readFailed = true
        throw Object.assign(new Error('fixture-post-bind marker EMFILE'), { code: 'EMFILE' })
      }
      return open(file, flags, mode)
    })
    const error = await h.state
      .installAuthenticatedLogin({
        token: freshToken,
        me: { ...homeMe, id: 'fixture-new-user' },
      })
      .then(
        () => null,
        error => error
      )
    expect(recoveryAttempted).toBe(true)
    expect(h.service.getCachedUserId()).toBeNull()
    expect(h.state.sessionToken).toBeNull()
    expect(h.state.me).toBeNull()
    expect(h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)).toBeNull()
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: homeMe,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(freshToken)
    expect(error).toBeInstanceOf(Error)
  })

  it('restores the verified previous live scope after transient post-bind login inspection', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    const fresh = 'fixture-rejected-post-bind-user'
    const freshMe = { ...homeMe, id: 'fixture-post-bind-user' }
    const binding = await import('../chatStoreBinding.js')
    let armed = false
    vi.mocked(binding.bindChatStoreForUser).mockImplementationOnce(async () => {
      armed = true
    })
    const open = fsSync.openSync.bind(fsSync)
    const spy = vi.spyOn(fsSync, 'openSync').mockImplementation((file, flags, mode) => {
      if (String(file) === h.markerPath && armed) {
        armed = false
        throw Object.assign(new Error('fixture-login post-bind EMFILE'), { code: 'EMFILE' })
      }
      return open(file, flags, mode)
    })
    boundary.notifySessionChanged.mockClear()
    const error = await h.state.installAuthenticatedLogin({ token: fresh, me: freshMe }).then(
      () => null,
      error => error
    )
    spy.mockRestore()
    expect(h.state.sessionToken).toBe(homeToken)
    expect(h.state.me).toEqual(homeMe)
    expect(
      (
        h.service as unknown as {
          currentDesktopGfsUploadScope: (drive: undefined) => {
            ownerId: string
            teamId: string | null
          }
        }
      ).currentDesktopGfsUploadScope(undefined)
    ).toMatchObject({
      ownerId: homeMe.id,
      teamId: homeMe.teamId,
    })
    expect(boundary.notifySessionChanged).not.toHaveBeenCalledWith(false)
    expect(await h.tokenStore.getKeytarSessionToken(h.envKey)).toBe(homeToken)
    expect(h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)).toBeNull()
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: homeMe,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(fresh)
    expect(error).toBeInstanceOf(Error)
  })

  it('preserves already valid authentication when post-getMe marker inspection is transient', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    h.markers.recordPendingKeytarCleanup(runtime.directory, h.envKey, 'active-keytar')
    const getMe = h.state.authClient.getMe.bind(h.state.authClient)
    const open = fsSync.openSync.bind(fsSync)
    let armed = false
    vi.mocked(h.state.authClient.getMe).mockImplementationOnce(async token => {
      const me = await getMe(token)
      armed = true
      return me
    })
    vi.spyOn(fsSync, 'openSync').mockImplementation(
      (...args: Parameters<typeof fsSync.openSync>) => {
        if (String(args[0]) === h.markerPath && armed) {
          armed = false
          throw Object.assign(new Error('fixture-post-auth-transient'), { code: 'EMFILE' })
        }
        return open(...args)
      }
    )
    boundary.notifySessionChanged.mockClear()
    const result = await h.service.initialize()
    expect(result.authenticated).toBe(true)
    expect(h.state.sessionToken).toBe(homeToken)
    expect(h.state.me?.id).toBe(homeMe.id)
    await expect(h.tokenStore.getKeytarSessionToken(h.envKey)).resolves.toBe(homeToken)
    expect(boundary.notifySessionChanged).not.toHaveBeenCalledWith(false)
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: homeMe,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(homeToken)
  })
})
