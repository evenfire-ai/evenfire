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

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

function expectHomeDispatchScope(service: unknown) {
  const owner = service as {
    currentDesktopGfsUploadScope: (drive: undefined) => { ownerId: string; teamId: string | null }
  }
  expect(owner.currentDesktopGfsUploadScope(undefined)).toMatchObject({
    ownerId: homeMe.id,
    teamId: homeMe.teamId,
  })
}

async function enteredWithin(promise: Promise<void>, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const entered = await Promise.race([
      promise.then(() => true),
      new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), 2000)
      }),
    ])
    expect(entered, `producer reached ${label}`).toBe(true)
  } finally {
    clearTimeout(timer)
  }
}

describe('R21-M1 partial publication with unavailable repair', () => {
  it('never restores a rejected native candidate while both repair and marker inspection are unavailable', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    h.markers.recordPendingKeytarCleanup(runtime.directory, h.envKey, 'active-keytar')
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    let published = false
    boundary.setPassword.mockImplementationOnce(async (service, account, token) => {
      runtime.keychain.set(keyOf(service, account), token)
      published = true
      throw new Error('fixture-partial native publication rejected')
    })
    const get = boundary.getPassword.getMockImplementation()!
    boundary.getPassword.mockImplementation(async (...args) => {
      if (published) throw new Error('fixture-native repair locked')
      return get(...args)
    })
    const open = fsSync.openSync.bind(fsSync)
    let rejectedReads = 0
    vi.spyOn(fsSync, 'openSync').mockImplementation((file, flags, mode) => {
      if (published && String(file) === h.markerPath) {
        rejectedReads += 1
        throw Object.assign(new Error('fixture-transient owned marker read'), { code: 'EMFILE' })
      }
      return open(file, flags, mode)
    })
    const error = await h.service.switchTeam('fixture-other').then(
      () => null,
      error => error
    )
    expect(published).toBe(true)
    // Keep uncertainty active across three actual restore attempts, rather than
    // requiring the failed producer to manufacture three marker reads itself.
    await h.service.initialize()
    await h.service.initialize()
    expect(rejectedReads).toBeGreaterThanOrEqual(3)
    vi.restoreAllMocks()
    boundary.getPassword.mockImplementation(
      async (service, account) => runtime.keychain.get(keyOf(service, account)) ?? null
    )
    const restarted = await harness()
    const result = await restarted.service.initialize()
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(teamToken)
    expect(result.authenticated).toBe(false)
    expect(h.state.sessionToken).toBeNull()
    expect(error).toBeInstanceOf(Error)
  })
})

describe('R21-M2 newer independent source authority during logout cleanup', () => {
  it('preserves journal entries appended after the verified logout cleanup snapshot', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    h.markers.recordPendingExternalLogout(runtime.directory, h.envKey)
    const journal = await import('../sessionPersistenceJournal.js')
    const prior = new journal.SessionPersistenceProducer(
      runtime.directory,
      h.envKey,
      h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey),
      () => {},
      vi.fn()
    )
    prior.prepare('keytar', 'fixture-old-pending-candidate')
    const entered = deferred()
    const release = deferred()
    const remove = boundary.deletePassword.getMockImplementation()!
    boundary.deletePassword.mockImplementation(async (service, account) => {
      if (account === `session-token::${h.envKey}`) {
        entered.resolve()
        await release.promise
      }
      return remove(service, account)
    })
    const logout = h.service.logout()
    try {
      await enteredWithin(entered.promise, 'native logout cleanup before independent preparation')
      const independent = new journal.SessionPersistenceProducer(
        runtime.directory,
        h.envKey,
        h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey),
        () => {},
        vi.fn()
      )
      await h.tokenStore.setSafeStorageSessionToken('fixture-new-pending-candidate', h.envKey, {
        onMutationDispatched: (source, token) => independent.prepare(source, token),
      })
    } finally {
      release.resolve()
      await logout
    }
    const current = journal.readSessionPersistenceJournal(runtime.directory, h.envKey)
    expect(
      journal.isSessionPersistenceCandidateDenied(current, 'fixture-new-pending-candidate')
    ).toBe(true)
    expect(h.markers.readPendingExternalLogoutIntent(runtime.directory, h.envKey)).toEqual({
      intent: 'logout-pending',
    })
    expect(h.state.sessionToken).toBeNull()
    const restarted = await harness()
    expect((await restarted.service.initialize()).authenticated).toBe(false)
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(
      'fixture-new-pending-candidate'
    )
  })

  it('preserves a fresh encrypted producer after an older native logout clear rejects', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    h.markers.recordPendingExternalLogout(runtime.directory, h.envKey)
    const entered = deferred()
    const release = deferred()
    const remove = boundary.deletePassword.getMockImplementation()!
    const activeAccount = `session-token::${h.envKey}`
    boundary.deletePassword.mockImplementation(async (service, account) => {
      if (account === activeAccount) {
        entered.resolve()
        await release.promise
        throw new Error('fixture-older native logout clear failed')
      }
      return remove(service, account)
    })
    const logout = h.service.logout().then(
      () => null,
      error => error
    )
    const freshToken = 'fixture-independent-new-user-session'
    const freshMe = { ...homeMe, id: 'fixture-independent-new-user' }
    let winningMarker: Awaited<ReturnType<typeof h.markers.readPendingExternalLogoutMarker>>
    try {
      await enteredWithin(entered.promise, 'older native logout clear')
      await h.tokenStore.setSafeStorageSessionToken(freshToken, h.envKey)
      h.markers.recordPendingKeytarCleanup(runtime.directory, h.envKey, 'safe-storage')
      winningMarker = h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)
    } finally {
      release.resolve()
      await logout
      boundary.deletePassword.mockImplementation(remove)
    }
    const markerAfterOldLogout = h.markers.readPendingExternalLogoutMarker(
      runtime.directory,
      h.envKey
    )
    const restarted = await harness()
    vi.mocked(restarted.state.authClient.getMe).mockImplementation(async token =>
      token === freshToken ? freshMe : homeMe
    )
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: freshMe,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(freshToken)
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(homeToken)
    expect(markerAfterOldLogout).toEqual(winningMarker!)
    expect(await restarted.tokenStore.getSafeStorageSessionToken(h.envKey)).toBe(freshToken)
  })
})

describe('independent no-dispatch transient probe', () => {
  it('preserves a locked previous source when marker inspection rejects before any candidate write', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    h.markers.recordPendingKeytarCleanup(runtime.directory, h.envKey, 'active-keytar')
    const original = await fs.readFile(h.markerPath, 'utf8')
    boundary.getPassword.mockImplementation(async () => {
      throw new Error('fixture-native previous source temporarily locked')
    })
    boundary.setPassword.mockClear()
    const open = fsSync.openSync.bind(fsSync)
    let markerReads = 0
    const spy = vi.spyOn(fsSync, 'openSync').mockImplementation((file, flags, mode) => {
      if (String(file) === h.markerPath && ++markerReads === 3) {
        throw Object.assign(new Error('fixture-before-dispatch marker read'), { code: 'EMFILE' })
      }
      return open(file, flags, mode)
    })
    boundary.notifySessionChanged.mockClear()
    const result = await h.service.switchTeam('fixture-other').then(
      () => null,
      error => error
    )
    spy.mockRestore()
    expect(result).toBeInstanceOf(Error)
    expect(boundary.setPassword).not.toHaveBeenCalled()
    expect(h.state.sessionToken).toBe(homeToken)
    expect(h.state.me).toEqual(homeMe)
    expectHomeDispatchScope(h.service)
    expect(await fs.readFile(h.markerPath, 'utf8')).toBe(original)
    expect(boundary.notifySessionChanged).not.toHaveBeenCalledWith(false)
    boundary.getPassword.mockImplementation(
      async (service, account) => runtime.keychain.get(keyOf(service, account)) ?? null
    )
    expect(await h.tokenStore.getKeytarSessionToken(h.envKey)).toBe(homeToken)
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: homeMe,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(teamToken)
  })
})

describe('R21-M1 marker observation uncertainty', () => {
  it('gives confirmed corruption precedence over a known-unpublished native outage', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    h.markers.recordPendingKeytarCleanup(runtime.directory, h.envKey, 'active-keytar')
    vi.doMock('keytar', () => ({}))
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    const paused = deferred()
    const release = deferred()
    const set = h.tokenStore.setSessionToken.bind(h.tokenStore)
    vi.spyOn(h.tokenStore, 'setSessionToken').mockImplementationOnce(async (...args) => {
      const outcome = await set(...args).then(
        value => ({ value }),
        error => ({ error })
      )
      paused.resolve()
      await release.promise
      if ('error' in outcome) throw outcome.error
      return outcome.value
    })
    const switching = h.service.switchTeam('fixture-other').then(
      () => null,
      error => error
    )
    try {
      await enteredWithin(paused.promise, 'known-unpublished native response')
      await fs.writeFile(h.markerPath, '{fixture-confirmed-corruption')
    } finally {
      release.resolve()
    }
    const error = await switching
    expect(h.service.getCachedUserId()).toBeNull()
    expect(h.state.sessionToken).toBeNull()
    expect(h.state.me).toBeNull()
    expect(await fs.readFile(h.markerPath, 'utf8')).toBe('{fixture-confirmed-corruption')
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalled()
    expect(error).toBeInstanceOf(Error)
  })

  it('reactivates the unchanged live GFS scope when login marker inspection rejects before dispatch', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    boundary.setPassword.mockClear()
    const set = h.tokenStore.setSessionToken.bind(h.tokenStore)
    let armed = false
    vi.spyOn(h.tokenStore, 'setSessionToken').mockImplementationOnce(async (...args) => {
      armed = true
      return set(...args)
    })
    const open = fsSync.openSync.bind(fsSync)
    const spy = vi.spyOn(fsSync, 'openSync').mockImplementation((file, flags, mode) => {
      if (String(file) === h.markerPath && armed) {
        armed = false
        throw Object.assign(new Error('fixture-login before-dispatch EMFILE'), { code: 'EMFILE' })
      }
      return open(file, flags, mode)
    })
    const error = await h.state.installAuthenticatedLogin({ token: teamToken, me: homeMe }).then(
      () => null,
      error => error
    )
    spy.mockRestore()
    expect(boundary.setPassword).not.toHaveBeenCalled()
    expect(h.state.sessionToken).toBe(homeToken)
    expect(h.state.me).toEqual(homeMe)
    expectHomeDispatchScope(h.service)
    expect(h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)).toBeNull()
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: homeMe,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(teamToken)
    expect(error).toBeInstanceOf(Error)
  })

  it('fails closed for confirmed marker corruption even when no login candidate was dispatched', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    boundary.setPassword.mockClear()
    const set = h.tokenStore.setSessionToken.bind(h.tokenStore)
    const corrupt = '{fixture-confirmed-marker-corruption'
    vi.spyOn(h.tokenStore, 'setSessionToken').mockImplementationOnce(async (...args) => {
      await fs.writeFile(h.markerPath, corrupt)
      return set(...args)
    })
    const error = await h.state.installAuthenticatedLogin({ token: teamToken, me: homeMe }).then(
      () => null,
      error => error
    )
    expect(boundary.setPassword).not.toHaveBeenCalled()
    expect(h.state.sessionToken).toBeNull()
    expect(h.state.me).toBeNull()
    expect(await fs.readFile(h.markerPath, 'utf8')).toBe(corrupt)
    expect(await h.tokenStore.getKeytarSessionToken(h.envKey)).toBe(homeToken)
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalled()
    expect(error).toBeInstanceOf(Error)
  })

  it.each(['active-keytar', 'safe-storage', 'absent'] as const)(
    'repairs rejected login publication without changing %s marker bytes after transient inspection',
    async source => {
      const h = await harness()
      if (source === 'safe-storage')
        boundary.setPassword.mockRejectedValueOnce(new Error('fixture secure encrypted Home'))
      await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
      if (source !== 'absent') {
        h.markers.recordPendingKeytarCleanup(runtime.directory, h.envKey, source)
      }
      const original = h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)
      const fresh = 'fixture-rejected-login-after-transient-read'
      let published = false
      boundary.setPassword.mockImplementationOnce(async (service, account, token) => {
        runtime.keychain.set(keyOf(service, account), token)
        published = true
      })
      const open = fsSync.openSync.bind(fsSync)
      let reads = 0
      const spy = vi.spyOn(fsSync, 'openSync').mockImplementation((file, flags, mode) => {
        if (String(file) === h.markerPath && published && ++reads <= 3)
          throw Object.assign(new Error('fixture-login marker EMFILE'), { code: 'EMFILE' })
        return open(file, flags, mode)
      })
      boundary.notifySessionChanged.mockClear()
      const error = await h.state.installAuthenticatedLogin({ token: fresh, me: homeMe }).then(
        () => null,
        error => error
      )
      spy.mockRestore()
      expect(h.state.sessionToken).toBe(homeToken)
      expect(h.state.me).toEqual(homeMe)
      expectHomeDispatchScope(h.service)
      expect(h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)).toEqual(
        original
      )
      expect(boundary.notifySessionChanged).not.toHaveBeenCalledWith(false)
      const restarted = await harness()
      await expect(restarted.service.initialize()).resolves.toEqual({
        authenticated: true,
        me: homeMe,
      })
      expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(fresh)
      expect(error).toBeInstanceOf(Error)
    }
  )

  it.each(['safe-storage', 'absent'] as const)(
    'retains the previous source for post-write uncertainty with %s authority',
    async source => {
      const h = await harness()
      await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
      if (source === 'safe-storage') {
        await h.tokenStore.setSafeStorageSessionToken(homeToken, h.envKey)
        h.markers.recordPendingKeytarCleanup(runtime.directory, h.envKey, source)
      } else {
        const rename = fs.rename.bind(fs)
        vi.spyOn(fs, 'rename').mockImplementationOnce(async (from, to) => {
          if (String(to).endsWith('.enc')) throw new Error('fixture-encrypted write failed')
          return rename(from, to)
        })
      }
      const original = h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)
      let candidateWritten = false
      if (source === 'safe-storage') {
        const rename = fs.rename.bind(fs)
        vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
          const result = await rename(from, to)
          if (String(to).endsWith('.enc')) candidateWritten = true
          return result
        })
      } else {
        boundary.setPassword.mockImplementationOnce(async (service, account, token) => {
          runtime.keychain.set(keyOf(service, account), token)
          candidateWritten = true
          throw new Error('fixture-partial native write')
        })
      }
      const open = fsSync.openSync.bind(fsSync)
      let reads = 0
      const spy = vi.spyOn(fsSync, 'openSync').mockImplementation((file, flags, mode) => {
        if (String(file) === h.markerPath && candidateWritten && ++reads <= 3)
          throw Object.assign(new Error('fixture-marker EMFILE'), { code: 'EMFILE' })
        return open(file, flags, mode)
      })
      const error = await h.service.switchTeam('fixture-other').then(
        () => null,
        error => error
      )
      spy.mockRestore()
      expect(h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)).toEqual(
        original
      )
      expect(h.state.sessionToken).toBe(homeToken)
      expect(h.state.me).toEqual(homeMe)
      const restarted = await harness()
      await expect(restarted.service.initialize()).resolves.toEqual({
        authenticated: true,
        me: homeMe,
      })
      expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(teamToken)
      expect(error).toBeInstanceOf(Error)
    }
  )

  it('fences a rejected candidate after transient inspection and genuine native repair failure', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    h.markers.recordPendingKeytarCleanup(runtime.directory, h.envKey, 'active-keytar')
    let candidateWritten = false
    boundary.setPassword.mockImplementation(async (service, account, token) => {
      if (token === homeToken) throw new Error('fixture-actual native repair failure')
      runtime.keychain.set(keyOf(service, account), token)
      if (token === teamToken) candidateWritten = true
    })
    const open = fsSync.openSync.bind(fsSync)
    let reads = 0
    const spy = vi.spyOn(fsSync, 'openSync').mockImplementation((file, flags, mode) => {
      if (String(file) === h.markerPath && candidateWritten && ++reads <= 3)
        throw Object.assign(new Error('fixture-marker EMFILE'), { code: 'EMFILE' })
      return open(file, flags, mode)
    })
    const error = await h.service.switchTeam('fixture-other').then(
      () => null,
      error => error
    )
    spy.mockRestore()
    expect(h.markers.readPendingExternalLogoutIntent(runtime.directory, h.envKey)).toEqual({
      intent: 'keytar-cleanup-pending',
      credentialSource: 'active-keytar',
    })
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(teamToken)
    expect(h.state.sessionToken).toBeNull()
    expect(error).toBeInstanceOf(Error)
  })

  it.each(['switch', 'hop'] as const)(
    'preserves the verified source after third/fourth-read EMFILE during %s',
    async operation => {
      const h = await harness()
      await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
      h.markers.recordPendingKeytarCleanup(runtime.directory, h.envKey, 'active-keytar')
      const original = await fs.readFile(h.markerPath, 'utf8')
      let candidateWritten = false
      boundary.setPassword.mockImplementation(async (service, account, token) => {
        runtime.keychain.set(keyOf(service, account), token)
        if (token === teamToken) candidateWritten = true
      })
      const open = fsSync.openSync.bind(fsSync)
      let reads = 0
      const spy = vi.spyOn(fsSync, 'openSync').mockImplementation((file, flags, mode) => {
        if (String(file) === h.markerPath && candidateWritten && ++reads <= 2)
          throw Object.assign(new Error('fixture-marker EMFILE'), { code: 'EMFILE' })
        return open(file, flags, mode)
      })
      boundary.notifySessionChanged.mockClear()
      const hopOperation = vi.fn(async () => 'must-not-run')
      const result =
        operation === 'switch'
          ? h.service.switchTeam('fixture-other')
          : h.state.runWithTeamContext('fixture-other', hopOperation)
      const error = await result.then(
        () => null,
        error => error
      )
      spy.mockRestore()
      expect(await h.tokenStore.getKeytarSessionToken(h.envKey)).toBe(homeToken)
      expect(h.state.sessionToken).toBe(homeToken)
      expect(h.state.me).toEqual(homeMe)
      expect(await fs.readFile(h.markerPath, 'utf8')).toBe(original)
      expect(boundary.notifySessionChanged).not.toHaveBeenCalledWith(false)
      const restarted = await harness()
      await expect(restarted.service.initialize()).resolves.toEqual({
        authenticated: true,
        me: homeMe,
      })
      expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(teamToken)
      expect(error).toBeInstanceOf(Error)
      expect(hopOperation).not.toHaveBeenCalled()
    }
  )

  it('repairs the exact native candidate after three consecutive transient ownership reads', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    h.markers.recordPendingKeytarCleanup(runtime.directory, h.envKey, 'active-keytar')
    const original = await fs.readFile(h.markerPath, 'utf8')
    let candidateWritten = false
    boundary.setPassword.mockImplementation(async (service, account, token) => {
      runtime.keychain.set(keyOf(service, account), token)
      if (token === teamToken) candidateWritten = true
    })
    const open = fsSync.openSync.bind(fsSync)
    let reads = 0
    const spy = vi.spyOn(fsSync, 'openSync').mockImplementation((file, flags, mode) => {
      if (String(file) === h.markerPath && candidateWritten && ++reads <= 3)
        throw Object.assign(new Error('fixture-marker EMFILE'), { code: 'EMFILE' })
      return open(file, flags, mode)
    })
    const error = await h.service.switchTeam('fixture-other').then(
      () => null,
      error => error
    )
    spy.mockRestore()
    expect(await fs.readFile(h.markerPath, 'utf8')).toBe(original)
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: homeMe,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(teamToken)
    expect(h.state.sessionToken).toBe(homeToken)
    expect(await h.tokenStore.getKeytarSessionToken(h.envKey)).toBe(homeToken)
    expect(error).toBeInstanceOf(Error)
    // Startup may retire verified cleanup; before startup the exact witness was preserved.
    expect(original).toContain('active-keytar')
  })

  it('does not report a false external logout for transient canceled-quit inspection', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    h.markers.recordPendingKeytarCleanup(runtime.directory, h.envKey, 'active-keytar')
    const observed = h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)
    const open = fsSync.openSync.bind(fsSync)
    const spy = vi.spyOn(fsSync, 'openSync').mockImplementation((file, flags, mode) => {
      if (String(file) === h.markerPath)
        throw Object.assign(new Error('fixture-marker EMFILE'), { code: 'EMFILE' })
      return open(file, flags, mode)
    })
    boundary.notifySessionChanged.mockClear()
    await expect(h.service.applyPendingExternalLogoutIntent()).resolves.toBe(false)
    spy.mockRestore()
    expect(h.state.sessionToken).toBe(homeToken)
    expect(h.service.getCachedUserId()).toBe(homeMe.id)
    expect(await h.tokenStore.getKeytarSessionToken(h.envKey)).toBe(homeToken)
    expect(h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)).toEqual(observed)
    expect(boundary.notifySessionChanged).not.toHaveBeenCalledWith(false)
  })
})

describe('R21-M2 stale native producer fencing', () => {
  it.each(['active-encrypted-read', 'legacy-encrypted-migration'] as const)(
    'keeps %s authority across native recovery and restart',
    async producer => {
      const h = await harness()
      await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
      const fresh = 'fixture-selected-encrypted-user'
      const freshMe = { ...homeMe, id: 'fixture-selected-user' }
      if (producer === 'active-encrypted-read')
        await h.tokenStore.setSafeStorageSessionToken(fresh, h.envKey)
      else {
        const { safeStorage } = await import('electron')
        await fs.writeFile(
          path.join(runtime.directory, 'session-token.enc'),
          safeStorage.encryptString(fresh)
        )
        boundary.setPassword.mockRejectedValueOnce(
          new Error('fixture-migration native write failed')
        )
      }
      boundary.getPassword.mockRejectedValue(
        new Error('fixture-native read temporarily unavailable')
      )
      const initial = await harness()
      vi.mocked(initial.state.authClient.getMe).mockImplementation(async token =>
        token === fresh ? freshMe : homeMe
      )
      await expect(initial.service.initialize()).resolves.toEqual({
        authenticated: true,
        me: freshMe,
      })
      const bound = initial.markers.readPendingExternalLogoutIntent(runtime.directory, h.envKey)
      expect(await initial.tokenStore.getSafeStorageSessionToken(h.envKey)).toBe(fresh)
      boundary.getPassword.mockImplementation(
        async (service, account) => runtime.keychain.get(keyOf(service, account)) ?? null
      )
      const restarted = await harness()
      vi.mocked(restarted.state.authClient.getMe).mockImplementation(async token =>
        token === fresh ? freshMe : homeMe
      )
      await expect(restarted.service.initialize()).resolves.toEqual({
        authenticated: true,
        me: freshMe,
      })
      expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(homeToken)
      expect(bound).toEqual({ intent: 'keytar-cleanup-pending', credentialSource: 'safe-storage' })
      if (producer === 'legacy-encrypted-migration')
        await expect(
          fs.stat(path.join(runtime.directory, 'session-token.enc'))
        ).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )

  it.each(['login', 'team'] as const)(
    'preserves the valid old session when a %s production write cannot dispatch securely',
    async producer => {
      const h = await harness()
      await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
      vi.doMock('keytar', () => ({}))
      const { safeStorage } = await import('electron')
      vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
      boundary.setPassword.mockClear()
      const attempted =
        producer === 'login'
          ? h.state.installAuthenticatedLogin({
              token: teamToken,
              me: { ...homeMe, teamId: 'fixture-other' },
            })
          : h.service.switchTeam('fixture-other')
      const error = await attempted.then(
        () => null,
        error => error
      )
      expect(h.state.sessionToken).toBe(homeToken)
      expect(h.state.me).toEqual(homeMe)
      expect(boundary.setPassword).not.toHaveBeenCalled()
      expect(h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)).toBeNull()
      expect(await fs.readdir(runtime.directory)).not.toContain(`session-token-${h.envKey}.json`)
      vi.doMock('keytar', () => boundary)
      const restarted = await harness()
      await expect(restarted.service.initialize()).resolves.toEqual({
        authenticated: true,
        me: homeMe,
      })
      expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(teamToken)
      expect(error).toBeInstanceOf(Error)
    }
  )

  it('source-binds a verified encrypted team fallback before runtime installation', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    boundary.setPassword.mockRejectedValueOnce(new Error('fixture-one native setter rejection'))
    await h.service.switchTeam('fixture-other')
    expect(h.state.sessionToken).toBe(teamToken)
    expect(h.state.me?.teamId).toBe('fixture-other')
    expect(await h.tokenStore.getSafeStorageSessionToken(h.envKey)).toBe(teamToken)
    const bound = h.markers.readPendingExternalLogoutIntent(runtime.directory, h.envKey)
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: { ...homeMe, teamId: 'fixture-other' },
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(homeToken)
    expect(bound).toEqual({ intent: 'keytar-cleanup-pending', credentialSource: 'safe-storage' })
  })

  it('keeps fresh encrypted login authority after native availability recovers', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    boundary.setPassword.mockRejectedValueOnce(new Error('fixture-native setter unavailable'))
    boundary.getPassword.mockRejectedValue(new Error('fixture-native getter unavailable'))
    const fresh = 'fixture-new-user-encrypted-session'
    const freshMe = { ...homeMe, id: 'fixture-new-user' }
    await h.state.installAuthenticatedLogin({ token: fresh, me: freshMe })
    expect(h.state.sessionToken).toBe(fresh)
    expect(h.state.me).toEqual(freshMe)
    const bound = h.markers.readPendingExternalLogoutIntent(runtime.directory, h.envKey)
    boundary.getPassword.mockImplementation(
      async (service, account) => runtime.keychain.get(keyOf(service, account)) ?? null
    )
    const restarted = await harness()
    vi.mocked(restarted.state.authClient.getMe).mockImplementation(async token =>
      token === fresh ? freshMe : homeMe
    )
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: freshMe,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(homeToken)
    expect(bound).toEqual({ intent: 'keytar-cleanup-pending', credentialSource: 'safe-storage' })
  })

  it('rejects first production login without either secure store or a plaintext file', async () => {
    vi.doMock('keytar', () => ({}))
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    const h = await harness()
    const error = await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe }).then(
      () => null,
      error => error
    )
    expect(h.state.sessionToken).toBeNull()
    expect(h.state.me).toBeNull()
    expect(await fs.readdir(runtime.directory)).not.toContain(`session-token-${h.envKey}.json`)
    expect(h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)).toBeNull()
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalled()
    expect(error).toBeInstanceOf(Error)
  })

  it.each(['post-refresh', 'partial-refresh'] as const)(
    'preserves a newer login after the older team GFS %s fence rejects',
    async phase => {
      const h = await harness()
      await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
      const entered = deferred()
      const release = deferred()
      const actor = h.service as unknown as {
        suspendDesktopGfsUploadsForAuthBoundary: () => Promise<void>
      }
      const suspend = actor.suspendDesktopGfsUploadsForAuthBoundary.bind(actor)
      vi.spyOn(actor, 'suspendDesktopGfsUploadsForAuthBoundary')
        .mockImplementationOnce(async () => {
          entered.resolve()
          await release.promise
          throw new Error('fixture-older GFS fence failed')
        })
        .mockImplementation(suspend)
      if (phase === 'partial-refresh')
        vi.mocked(h.state.authClient.getMe).mockImplementationOnce(async () => {
          throw new Error('fixture-team identity refresh failed')
        })
      const switching = h.service.switchTeam('fixture-other').then(
        () => null,
        error => error
      )
      const fresh = 'fixture-newer-login-during-team-fence'
      try {
        await enteredWithin(entered.promise, 'older team GFS boundary')
        await h.state.installAuthenticatedLogin({ token: fresh, me: homeMe })
      } finally {
        release.resolve()
      }
      const error = await switching
      expect(h.state.sessionToken).toBe(fresh)
      expect(h.state.me).toEqual(homeMe)
      expect(await h.tokenStore.getKeytarSessionToken(h.envKey)).toBe(fresh)
      expect(h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)).toBeNull()
      const restarted = await harness()
      await expect(restarted.service.initialize()).resolves.toEqual({
        authenticated: true,
        me: homeMe,
      })
      expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(fresh)
      expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(teamToken)
      expect(error).toBeInstanceOf(Error)
    }
  )

  it('does not authenticate an accepted saved-token read after a newer rejected-admission logout', async () => {
    const h = await harness()
    await h.tokenStore.setSessionToken(homeToken, h.envKey)
    const read = h.tokenStore.getSessionToken.bind(h.tokenStore)
    const entered = deferred()
    const release = deferred()
    vi.spyOn(h.tokenStore, 'getSessionToken').mockImplementationOnce(async (...args) => {
      const token = await read(...args)
      entered.resolve()
      await release.promise
      return token
    })
    const initializing = h.service.initialize()
    let quitting: Promise<void> | undefined
    try {
      await enteredWithin(entered.promise, 'real saved credential read')
      quitting = h.service.prepareForQuit()
      const { QuitAdmissionClosedError } = await import('../appService.js')
      await expect(h.service.logout()).rejects.toBeInstanceOf(QuitAdmissionClosedError)
    } finally {
      release.resolve()
      await Promise.allSettled([initializing, ...(quitting ? [quitting] : [])])
      h.service.cancelQuitPreparation()
    }
    await expect(initializing).resolves.toEqual({ authenticated: false, me: null })
    expect(h.state.authClient.getMe).not.toHaveBeenCalledWith(homeToken)
    expect(h.service.getCachedUserId()).toBeNull()
    expect(h.markers.readPendingExternalLogoutIntent(runtime.directory, h.envKey)).toEqual({
      intent: 'logout-pending',
    })
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(homeToken)
  })

  it('does not let an older corruption failure clear a younger verified login after GFS fencing', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    await fs.writeFile(h.markerPath, '{fixture-malformed')
    const owner = h.service as unknown as {
      suspendDesktopGfsUploadsForAuthBoundary: () => Promise<void>
    }
    const fence = owner.suspendDesktopGfsUploadsForAuthBoundary.bind(owner)
    const entered = deferred()
    const release = deferred()
    vi.spyOn(owner, 'suspendDesktopGfsUploadsForAuthBoundary').mockImplementationOnce(async () => {
      await fence()
      entered.resolve()
      await release.promise
    })
    const switching = h.service.switchTeam('fixture-other')
    const settled = switching.then(
      () => null,
      error => error
    )
    const fresh = 'fixture-younger-user-session'
    const freshMe = { ...homeMe, id: 'fixture-younger-user' }
    try {
      await enteredWithin(entered.promise, 'real older corruption GFS fence')
      await h.state.installAuthenticatedLogin({ token: fresh, me: freshMe })
    } finally {
      release.resolve()
      await settled
    }
    expect(h.state.sessionToken).toBe(fresh)
    expect(h.state.me).toEqual(freshMe)
    expect(await h.tokenStore.getKeytarSessionToken(h.envKey)).toBe(fresh)
    const restarted = await harness()
    vi.mocked(restarted.state.authClient.getMe).mockResolvedValue(freshMe)
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: freshMe,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(fresh)
    expect(await settled).toBeInstanceOf(Error)
  })

  it('orders a held login transaction before the complete queued logout', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    const { bindChatStoreForUser } = await import('../chatStoreBinding.js')
    const entered = deferred()
    const release = deferred()
    vi.mocked(bindChatStoreForUser).mockImplementationOnce(async () => {
      entered.resolve()
      await release.promise
    })
    const login = h.state.installAuthenticatedLogin({
      token: 'fixture-late-login-session',
      me: { ...homeMe, id: 'fixture-new-user' },
    })
    const settled = login.then(
      () => null,
      error => error
    )
    let logout: Promise<void> | undefined
    try {
      await enteredWithin(entered.promise, 'real login binding')
      logout = h.service.logout()
      await new Promise(resolve => setImmediate(resolve))
    } finally {
      release.resolve()
      await Promise.allSettled([settled, ...(logout ? [logout] : [])])
    }
    const error = await settled
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith('fixture-late-login-session')
    expect(h.service.getCachedUserId()).toBeNull()
    expect(await h.tokenStore.getKeytarSessionToken(h.envKey)).toBeNull()
    expect(error).toBeNull()
  })

  it('does not restore the prior credential when rollback completes across logout', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    const entered = deferred()
    const release = deferred()
    boundary.setPassword.mockImplementation(async (service, account, token) => {
      if (token === teamToken) {
        runtime.keychain.set(keyOf(service, account), token)
        throw new Error('fixture-post-write rejection')
      }
      if (token === homeToken) {
        entered.resolve()
        await release.promise
      }
      runtime.keychain.set(keyOf(service, account), token)
    })
    const rename = fs.rename.bind(fs)
    let failed = false
    vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => {
      if (!failed && String(target).endsWith('.enc')) {
        failed = true
        throw new Error('fixture-encrypted replacement failed')
      }
      return rename(source, target)
    })
    const switching = h.service.switchTeam('fixture-other')
    const settledSwitch = switching.catch(() => undefined)
    let logout: Promise<void> | undefined
    try {
      await enteredWithin(entered.promise, 'restorative native setter')
      logout = h.service.logout()
      // On the buggy head logout finishes before this paused setter. The native
      // lane instead keeps logout pending; either schedule releases deterministically.
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          logout,
          new Promise<void>(resolve => {
            timer = setTimeout(resolve, 100)
          }),
        ])
        // A queued logout may not clear runtime until the admitted transaction
        // settles; the final restart below is the credential-resurrection proof.
      } finally {
        clearTimeout(timer)
      }
    } finally {
      release.resolve()
      await Promise.allSettled([settledSwitch, ...(logout ? [logout] : [])])
    }
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(homeToken)
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(teamToken)
    expect(await h.tokenStore.getKeytarSessionToken(h.envKey)).toBeNull()
    expect(h.state.sessionToken).toBeNull()
  })
})

describe('R18-H1 owner-approved absent-module outage policy', () => {
  it('retains LP after ordinary logout without Keytar until verified secure recovery is available', async () => {
    vi.doMock('keytar', () => ({}))
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    const h = await harness()
    const historicalProducer = await harness({ isolated: true })
    await historicalProducer.tokenStore.setSessionToken(homeToken, h.envKey)
    await h.service.initialize()
    await h.service.logout()
    expect(h.state.sessionToken).toBeNull()
    expect(h.markers.readPendingExternalLogoutIntent(runtime.directory, h.envKey)).toEqual({
      intent: 'logout-pending',
    })
    await expect(
      h.state.installAuthenticatedLogin({ token: 'fixture-denied-session', me: homeMe })
    ).rejects.toThrow('safeStorage is unavailable')
    expect(await fs.readdir(runtime.directory)).not.toContain(`session-token-${h.envKey}.json`)
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalled()
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
    await h.state.installAuthenticatedLogin({ token: 'fixture-secure-recovery', me: homeMe })
    const recovered = await harness()
    await expect(recovered.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: homeMe,
    })
    expect(recovered.state.authClient.getMe).toHaveBeenCalledWith('fixture-secure-recovery')
  })

  it('preserves the explicit isolated-development keytarDisabled exception', async () => {
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    const h = await harness({ isolated: true })
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    await h.service.logout()
    expect(h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)).toBeNull()
    await h.state.installAuthenticatedLogin({ token: 'fixture-isolated-fresh-session', me: homeMe })
    expect(h.service.getCachedUserId()).toBe(homeMe.id)
    expect(await h.tokenStore.getSessionToken(h.envKey)).toBe('fixture-isolated-fresh-session')
  })
})

describe('R21-M1 confirmed-invalid asynchronous cleanup', () => {
  it('denies existing authentication when a real native cleanup observes newly corrupt marker bytes', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    h.markers.recordPendingKeytarCleanup(runtime.directory, h.envKey, 'active-keytar')
    const remove = boundary.deletePassword.getMockImplementation()!
    let corrupted = false
    boundary.deletePassword.mockImplementationOnce(async (...args) => {
      const deleted = await remove(...args)
      await fs.writeFile(h.markerPath, '{fixture-new-marker-corruption')
      corrupted = true
      return deleted
    })
    await expect(h.service.applyPendingExternalLogoutIntent()).resolves.toBe(false)
    expect(corrupted).toBe(true)
    expect(h.state.sessionToken).toBeNull()
    expect(h.state.me).toBeNull()
    expect(await h.tokenStore.getKeytarSessionToken(h.envKey)).toBe(homeToken)
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalled()
  })
})

describe('R21-L1 exact stale encrypted disposal', () => {
  it('retires CP-S after fresh Keytar login without retaining a prior-user encrypted token', async () => {
    const h = await harness()
    const previous = 'fixture-previous-user-session'
    const fresh = 'fixture-new-user-session'
    await h.tokenStore.setSafeStorageSessionToken(previous, h.envKey)
    h.markers.recordPendingKeytarCleanup(runtime.directory, h.envKey, 'safe-storage')
    await h.state.installAuthenticatedLogin({ token: fresh, me: homeMe })
    expect(await h.tokenStore.getSafeStorageSessionToken(h.envKey)).toBeNull()
    expect(h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)).toBeNull()
    for (let restart = 0; restart < 3; restart += 1) {
      const next = await harness()
      await expect(next.service.initialize()).resolves.toEqual({ authenticated: true, me: homeMe })
      expect(next.state.authClient.getMe).toHaveBeenCalledWith(fresh)
      expect(next.state.authClient.getMe).not.toHaveBeenCalledWith(previous)
      expect(next.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)).toBeNull()
    }
    vi.doMock('keytar', () => ({}))
    const unavailable = await harness()
    await expect(unavailable.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(unavailable.state.authClient.getMe).not.toHaveBeenCalledWith(previous)
  })
})
