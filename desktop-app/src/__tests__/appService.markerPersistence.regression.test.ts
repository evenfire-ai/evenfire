import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import fsSync from 'node:fs'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const runtime = vi.hoisted(() => ({ directory: '', keychain: new Map<string, string>() }))
const { notifySessionChanged } = vi.hoisted(() => ({ notifySessionChanged: vi.fn() }))
const keytarBoundary = vi.hoisted(() => ({
  getPassword: vi.fn(),
  setPassword: vi.fn(),
  deletePassword: vi.fn(),
}))
const keyOf = (service: string, account: string) => `${service}::${account}`
const barrierReleases = new Set<() => void>()
const ownedOperations = new Set<Promise<unknown>>()
vi.mock('keytar', () => keytarBoundary)
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

const homeToken = 'fixture-home-session'
const homeMe = {
  id: 'fixture-user',
  email: 'fixture@example.com',
  name: null,
  picture: null,
  teamId: 'fixture-home',
  teamName: 'Fixture home',
  role: 'member',
}

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.doMock('keytar', () => keytarBoundary)
  runtime.keychain.clear()
  runtime.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-marker-persistence-'))
  const keytar = await import('keytar')
  vi.mocked(keytar.getPassword)
    .mockReset()
    .mockImplementation(
      async (service, account) => runtime.keychain.get(keyOf(service, account)) ?? null
    )
  vi.mocked(keytar.setPassword)
    .mockReset()
    .mockImplementation(async (service, account, token) => {
      runtime.keychain.set(keyOf(service, account), token)
    })
  vi.mocked(keytar.deletePassword)
    .mockReset()
    .mockImplementation(async (service, account) =>
      runtime.keychain.delete(keyOf(service, account))
    )
  const { safeStorage } = await import('electron')
  vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
})

afterEach(async () => {
  for (const release of barrierReleases) release()
  await Promise.allSettled([...ownedOperations])
  barrierReleases.clear()
  vi.restoreAllMocks()
  await fs.rm(runtime.directory, { recursive: true, force: true })
  runtime.directory = ''
  runtime.keychain.clear()
  vi.resetModules()
})

async function harness() {
  const [{ AppService }, { TokenStore }, markers, config] = await Promise.all([
    import('../appService.js'),
    import('../tokenStore.js'),
    import('../pendingExternalLogout.js'),
    import('../config.js'),
  ])
  const tokenStore = new TokenStore()
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
    runSessionPersistence: <T>(operation: () => Promise<T>) => Promise<T>
    runWithTeamContext: <T>(team: string, operation: (token: string) => Promise<T>) => Promise<T>
    authClient: {
      getMe: (token: string) => Promise<typeof homeMe>
      switchTeam: (token: string, teamId: string) => Promise<{ token: string }>
    }
  }
  vi.spyOn(state.authClient, 'getMe').mockImplementation(async token => ({
    ...homeMe,
    teamId: token === homeToken ? homeMe.teamId : 'fixture-other',
  }))
  vi.spyOn(state.authClient, 'switchTeam').mockImplementation(async (_token, teamId) => ({
    token: teamId === homeMe.teamId ? homeToken : 'fixture-other-session',
  }))
  return { service, tokenStore, markers, envKey: config.getActiveEnvKey(), state, reportFailure }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = () => {
      barrierReleases.delete(resolve)
      done()
    }
  })
  barrierReleases.add(resolve)
  return { promise, resolve }
}

function own<T>(operation: Promise<T>): Promise<T> {
  ownedOperations.add(operation)
  void operation.then(
    () => ownedOperations.delete(operation),
    () => ownedOperations.delete(operation)
  )
  return operation
}

async function awaitPhase(phase: Promise<void>, producer: Promise<unknown>, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      phase.then(() => 'entered'),
      producer.then(
        () => 'settled',
        () => 'settled'
      ),
      new Promise<string>(resolve => {
        timer = setTimeout(() => resolve('deadline'), 5_000)
      }),
    ])
    expect(result, `The producer must reach ${label} before settling`).toBe('entered')
  } finally {
    if (timer) clearTimeout(timer)
  }
}

describe('failed login follows an already-admitted logout transaction', () => {
  it('queues the rejected login behind logout and never restores its credential', async () => {
    const h = await harness()
    h.markers.recordPendingExternalLogout(runtime.directory, h.envKey)
    const entered = deferred()
    const release = deferred()
    const keytar = await import('keytar')
    vi.mocked(keytar.deletePassword).mockImplementation(async (service, account) => {
      if (runtime.keychain.get(keyOf(service, account)) === 'fixture-rejected-session') {
        throw new Error('fixture-rollback deletion failed')
      }
      return runtime.keychain.delete(keyOf(service, account))
    })
    vi.mocked(keytar.getPassword).mockImplementation(async (service, account) => {
      const token = runtime.keychain.get(keyOf(service, account)) ?? null
      if (token === 'fixture-rejected-session') throw new Error('fixture-read-back failed')
      return token
    })
    // Pause the real clear's response after native effects have settled. The full
    // logout transaction must retain the persistence lane until that response.
    const clear = h.tokenStore.clearSessionTokenStrictly.bind(h.tokenStore)
    vi.spyOn(h.tokenStore, 'clearSessionTokenStrictly').mockImplementationOnce(async (...args) => {
      const result = await clear(...args)
      entered.resolve()
      await release.promise
      return result
    })
    const oldLogout = own(h.service.logout())
    await awaitPhase(entered.promise, oldLogout, 'completed native logout cleanup')
    const loginQueued = deferred()
    const persist = h.state.runSessionPersistence.bind(h.state)
    vi.spyOn(h.state, 'runSessionPersistence').mockImplementationOnce(operation => {
      loginQueued.resolve()
      return persist(operation)
    })
    const login = own(
      h.state.installAuthenticatedLogin({ token: 'fixture-rejected-session', me: homeMe })
    )
    const loginOutcome = login.then(
      () => null,
      error => error
    )
    try {
      await awaitPhase(loginQueued.promise, login, 'queued explicit login')
      expect(keytar.setPassword).not.toHaveBeenCalled()
    } finally {
      release.resolve()
      await oldLogout
    }
    const error = await loginOutcome
    vi.mocked(keytar.getPassword).mockImplementation(
      async (service, account) => runtime.keychain.get(keyOf(service, account)) ?? null
    )
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith('fixture-rejected-session')
    expect(restarted.service.getCachedUserId()).toBeNull()
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain('Fresh session token could not be verified')
  })
})

describe('team persistence preserves the existing secure session on transient failures', () => {
  it('preserves Home through verified encrypted recovery after native storage becomes unavailable', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    h.markers.recordPendingKeytarCleanup(runtime.directory, h.envKey, 'active-keytar')
    vi.doMock('keytar', () => ({}))
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.decryptString).mockReturnValueOnce('')
    await expect(h.service.switchTeam('fixture-other')).rejects.toThrow('could not be verified')
    expect(h.state.sessionToken).toBe(homeToken)
    expect(h.state.me).toEqual(homeMe)
    expect(h.markers.readPendingExternalLogoutIntent(runtime.directory, h.envKey)).toEqual({
      intent: 'keytar-cleanup-pending',
      credentialSource: 'safe-storage',
    })
    expect(await h.tokenStore.getSafeStorageSessionToken(h.envKey)).toBe(homeToken)
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: homeMe,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(homeToken)
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith('fixture-other-session')
  })

  it('keeps accepted cleanup eligibility inside the quit-drained producer lifetime', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    h.markers.recordPendingKeytarCleanup(runtime.directory, h.envKey, 'active-keytar')
    const entered = deferred()
    const release = deferred()
    const snapshot = h.tokenStore.snapshotSessionTokenFallbackFiles.bind(h.tokenStore)
    vi.spyOn(h.tokenStore, 'snapshotSessionTokenFallbackFiles').mockImplementationOnce(
      async (...args) => {
        const result = await snapshot(...args)
        entered.resolve()
        await release.promise
        return result
      }
    )
    const events: string[] = []
    const retry = own(h.service.applyPendingExternalLogoutIntent()).then(result => {
      events.push('retry')
      return result
    })
    await awaitPhase(entered.promise, retry, 'whole-source cleanup eligibility snapshot')
    const quitting = own(h.service.prepareForQuit()).then(() => {
      events.push('quit')
    })
    await new Promise(resolve => setImmediate(resolve))
    release.resolve()
    await expect(retry).resolves.toBe(false)
    await quitting
    expect(events).toEqual(['retry', 'quit'])
    expect(h.state.sessionToken).toBe(homeToken)
    expect(h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)).toBeNull()
  })

  it('disposes old encrypted credentials after a fresh Keytar login from CP-S', async () => {
    const h = await harness()
    await h.tokenStore.setSafeStorageSessionToken('fixture-previous-user-session', h.envKey)
    h.markers.recordPendingKeytarCleanup(runtime.directory, h.envKey, 'safe-storage')
    const freshMe = { ...homeMe, id: 'fixture-new-user' }
    await expect(
      h.state.installAuthenticatedLogin({ token: 'fixture-new-user-session', me: freshMe })
    ).resolves.toEqual({ authenticated: true, me: freshMe })
    expect(h.markers.readPendingExternalLogoutIntent(runtime.directory, h.envKey)).toBeNull()
    expect(await h.tokenStore.getSafeStorageSessionToken(h.envKey)).toBeNull()
    vi.doMock('keytar', () => ({}))
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(
      'fixture-previous-user-session'
    )
  })

  it('repairs an active write that mutated its slot before rejecting', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    h.markers.recordPendingKeytarCleanup(runtime.directory, h.envKey, 'active-keytar')
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    const keytar = await import('keytar')
    vi.mocked(keytar.setPassword).mockImplementationOnce(async (service, account, token) => {
      runtime.keychain.set(keyOf(service, account), token)
      throw new Error('fixture-partial active write')
    })
    await expect(h.service.switchTeam('fixture-other')).rejects.toThrow(/Keytar|safeStorage/)
    expect(h.state.sessionToken).toBe(homeToken)
    expect(await h.tokenStore.getKeytarSessionToken(h.envKey)).toBe(homeToken)
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: homeMe,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(homeToken)
  })

  it('repairs an unverified active read-back before retaining the old session', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    h.markers.recordPendingKeytarCleanup(runtime.directory, h.envKey, 'active-keytar')
    const keytar = await import('keytar')
    vi.mocked(keytar.getPassword).mockImplementationOnce(async () => null)
    await expect(h.service.switchTeam('fixture-other')).rejects.toThrow('could not be verified')
    expect(h.state.sessionToken).toBe(homeToken)
    expect(await h.tokenStore.getKeytarSessionToken(h.envKey)).toBe(homeToken)
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: homeMe,
    })
  })

  it('denies a rejected partial write without manufacturing logout intent after failed repair', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    h.markers.recordPendingKeytarCleanup(runtime.directory, h.envKey, 'active-keytar')
    const originalMarker = h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    const keytar = await import('keytar')
    vi.mocked(keytar.setPassword).mockImplementation(async (service, account, token) => {
      if (token !== homeToken) runtime.keychain.set(keyOf(service, account), token)
      throw new Error('fixture-active write and restoration fail')
    })
    await expect(h.service.switchTeam('fixture-other')).rejects.toThrow(/Keytar|safeStorage/)
    expect(h.service.getCachedUserId()).toBeNull()
    expect(h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)).toEqual(
      originalMarker
    )
    const journal = await import('../sessionPersistenceJournal.js')
    expect(
      journal.isSessionPersistenceCandidateDenied(
        journal.readSessionPersistenceJournal(runtime.directory, h.envKey),
        'fixture-other-session'
      )
    ).toBe(true)
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalled()
  })

  it('preserves the newer quit-time logout revision during encrypted source conversion', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    h.markers.recordPendingKeytarCleanup(runtime.directory, h.envKey, 'active-keytar')
    const keytar = await import('keytar')
    vi.mocked(keytar.setPassword).mockRejectedValueOnce(new Error('fixture-transient Keytar write'))
    const entered = deferred()
    const release = deferred()
    const setEncrypted = h.tokenStore.setSafeStorageSessionToken.bind(h.tokenStore)
    vi.spyOn(h.tokenStore, 'setSafeStorageSessionToken').mockImplementation(async (...args) => {
      await setEncrypted(...args)
      entered.resolve()
      await release.promise
    })
    const switching = own(h.service.switchTeam('fixture-other'))
    const outcome = switching.then(
      () => null,
      error => error
    )
    await awaitPhase(entered.promise, switching, 'encrypted source write')
    const draining = own(h.service.prepareForQuit())
    await expect(h.service.logout()).rejects.toThrow('shutting down')
    const newer = h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)
    release.resolve()
    const error = await outcome
    await draining
    expect(h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)).toEqual(newer)
    expect(h.state.sessionToken).toBe(homeToken)
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalled()
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toMatch(/Pending logout intent changed|mutation was superseded/)
  })

  it.each([
    { operation: 'TEAM', safeStorageAvailable: true },
    { operation: 'HOP', safeStorageAvailable: true },
    { operation: 'TEAM', safeStorageAvailable: false },
    { operation: 'HOP', safeStorageAvailable: false },
  ])(
    '$operation-KA-TRANSIENT with safeStorage=$safeStorageAvailable',
    async ({ operation, safeStorageAvailable }) => {
      const h = await harness()
      await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
      h.markers.recordPendingKeytarCleanup(runtime.directory, h.envKey, 'active-keytar')
      const { safeStorage } = await import('electron')
      vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(safeStorageAvailable)
      const keytar = await import('keytar')
      vi.mocked(keytar.setPassword).mockRejectedValueOnce(
        new Error('fixture-transient Keytar write')
      )
      notifySessionChanged.mockClear()
      const execute = () =>
        operation === 'TEAM'
          ? h.service.switchTeam('fixture-other')
          : h.state.runWithTeamContext('fixture-other', async token => {
              expect(token).toBe('fixture-other-session')
              expect(h.state.me?.teamId).toBe('fixture-other')
              return 'fixture-operation-result'
            })
      if (safeStorageAvailable) {
        await expect(execute()).resolves.toEqual(
          operation === 'TEAM'
            ? { authenticated: true, me: { ...homeMe, teamId: 'fixture-other' } }
            : 'fixture-operation-result'
        )
        expect(h.markers.readPendingExternalLogoutIntent(runtime.directory, h.envKey)).toEqual({
          intent: 'keytar-cleanup-pending',
          credentialSource: 'safe-storage',
        })
        const expectedToken = operation === 'TEAM' ? 'fixture-other-session' : homeToken
        expect(await h.tokenStore.getSafeStorageSessionToken(h.envKey)).toBe(expectedToken)
        const restarted = await harness()
        await expect(restarted.service.initialize()).resolves.toEqual({
          authenticated: true,
          me: { ...homeMe, teamId: operation === 'TEAM' ? 'fixture-other' : homeMe.teamId },
        })
        expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(expectedToken)
      } else {
        await expect(execute()).rejects.toThrow(/Keytar|safeStorage/)
        expect(h.state.sessionToken).toBe(homeToken)
        expect(h.service.getCachedUserId()).toBe(homeMe.id)
        expect(h.state.me).toEqual(homeMe)
        expect(await h.tokenStore.getKeytarSessionToken(h.envKey)).toBe(homeToken)
        expect(notifySessionChanged).not.toHaveBeenCalledWith(false)
        expect(h.markers.readPendingExternalLogoutIntent(runtime.directory, h.envKey)).toEqual({
          intent: 'keytar-cleanup-pending',
          credentialSource: 'active-keytar',
        })
      }
    }
  )

  it('rejects a hop on transient marker EMFILE without deleting the existing credential', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    const markerPath = path.join(
      runtime.directory,
      `pending-external-logout-${createHash('sha256').update(h.envKey).digest('hex')}`
    )
    const open = fsSync.openSync.bind(fsSync)
    let failed = false
    vi.spyOn(fsSync, 'openSync').mockImplementation((file, flags, mode) => {
      if (!failed && String(file) === markerPath) {
        failed = true
        throw Object.assign(new Error('fixture-transient marker read'), { code: 'EMFILE' })
      }
      return open(file, flags, mode)
    })
    notifySessionChanged.mockClear()
    await expect(
      h.state.runWithTeamContext('fixture-other', async () => 'must-not-run')
    ).rejects.toThrow('fixture-transient marker read')
    expect(failed).toBe(true)
    expect(h.state.sessionToken).toBe(homeToken)
    expect(h.state.me).toEqual(homeMe)
    expect(h.service.getCachedUserId()).toBe(homeMe.id)
    expect(await h.tokenStore.getKeytarSessionToken(h.envKey)).toBe(homeToken)
    expect(h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)).toBeNull()
    expect(notifySessionChanged).not.toHaveBeenCalledWith(false)
    expect(h.reportFailure).toHaveBeenCalledWith(expect.objectContaining({ code: 'EMFILE' }))
  })
})

describe('persistence transaction ordering', () => {
  it('keeps a newer queued login authoritative after a paused restorative write', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    h.markers.recordPendingKeytarCleanup(runtime.directory, h.envKey, 'active-keytar')
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    const keytar = await import('keytar')
    const restoringEntered = deferred()
    const restoringRelease = deferred()
    vi.mocked(keytar.setPassword).mockImplementation(async (service, account, token) => {
      if (token === 'fixture-other-session') {
        runtime.keychain.set(keyOf(service, account), token)
        throw new Error('fixture-partial team write')
      }
      if (token === homeToken) {
        restoringEntered.resolve()
        await restoringRelease.promise
      }
      runtime.keychain.set(keyOf(service, account), token)
    })
    const switching = own(h.service.switchTeam('fixture-other'))
    const switchedResult = switching.then(
      () => undefined,
      () => undefined
    )
    await awaitPhase(restoringEntered.promise, switching, 'restorative native write')
    const queued = deferred()
    const persist = h.state.runSessionPersistence.bind(h.state)
    vi.spyOn(h.state, 'runSessionPersistence').mockImplementationOnce(operation => {
      queued.resolve()
      return persist(operation)
    })
    const newerMe = { ...homeMe, id: 'fixture-new-user' }
    const newer = own(
      h.state.installAuthenticatedLogin({
        token: 'fixture-new-user-session',
        me: newerMe,
      })
    )
    try {
      await awaitPhase(queued.promise, newer, 'new login behind restorative write')
    } finally {
      restoringRelease.resolve()
    }
    await Promise.all([switchedResult, newer])
    const restarted = await harness()
    vi.mocked(restarted.state.authClient.getMe).mockResolvedValue(newerMe)
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: newerMe,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith('fixture-new-user-session')
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(homeToken)
    expect(h.service.getCachedUserId()).toBe(newerMe.id)
  })

  it('retains the newer user when an older team identity refresh resolves later', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    const entered = deferred()
    const release = deferred()
    vi.mocked(h.state.authClient.getMe).mockImplementationOnce(async () => {
      entered.resolve()
      await release.promise
      return { ...homeMe, teamId: 'fixture-other' }
    })
    const switching = own(h.service.switchTeam('fixture-other'))
    const switchedResult = switching.then(
      () => undefined,
      () => undefined
    )
    await awaitPhase(entered.promise, switching, 'older team identity refresh')
    const newerMe = { ...homeMe, id: 'fixture-new-user' }
    await h.state.installAuthenticatedLogin({ token: 'fixture-new-user-session', me: newerMe })
    release.resolve()
    await switchedResult
    expect(h.service.getCachedUserId()).toBe(newerMe.id)
    expect(h.state.me).toEqual(newerMe)
    expect(h.state.sessionToken).toBe('fixture-new-user-session')
    expect(await h.tokenStore.getKeytarSessionToken(h.envKey)).toBe('fixture-new-user-session')
  })

  it('retains a newer login across an older paused native team write', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    h.markers.recordPendingKeytarCleanup(runtime.directory, h.envKey, 'active-keytar')
    const keytar = await import('keytar')
    const entered = deferred()
    const release = deferred()
    vi.mocked(keytar.setPassword).mockImplementationOnce(async (service, account, token) => {
      entered.resolve()
      await release.promise
      runtime.keychain.set(keyOf(service, account), token)
    })
    const switching = own(h.service.switchTeam('fixture-other'))
    // Attach rejection immediately: the buggy snapshot rejects after its stale write completes.
    const switchedResult = switching.then(
      () => undefined,
      () => undefined
    )
    await awaitPhase(entered.promise, switching, 'older native team write')
    const queued = deferred()
    const persist = h.state.runSessionPersistence.bind(h.state)
    vi.spyOn(h.state, 'runSessionPersistence').mockImplementationOnce(operation => {
      queued.resolve()
      return persist(operation)
    })
    const newerMe = { ...homeMe, id: 'fixture-new-user' }
    const newer = own(
      h.state.installAuthenticatedLogin({
        token: 'fixture-new-user-session',
        me: newerMe,
      })
    )
    try {
      await awaitPhase(queued.promise, newer, 'new login behind admitted native setter')
    } finally {
      release.resolve()
    }
    await Promise.all([switchedResult, newer])
    const restarted = await harness()
    vi.mocked(restarted.state.authClient.getMe).mockResolvedValue(newerMe)
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: newerMe,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith('fixture-new-user-session')
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith('fixture-other-session')
    expect(h.service.getCachedUserId()).toBe(newerMe.id)
  })
})

describe('R20-M4 ordinary partial-write recovery', () => {
  it.each(['absent', 'active-keytar'] as const)(
    'drains the admitted writer before logout clears an originally %s marker',
    async markerSource => {
      const h = await harness()
      await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
      if (markerSource === 'active-keytar')
        h.markers.recordPendingKeytarCleanup(runtime.directory, h.envKey, 'active-keytar')
      const keytar = await import('keytar')
      const entered = deferred()
      const release = deferred()
      vi.mocked(keytar.setPassword).mockImplementationOnce(async (service, account, token) => {
        entered.resolve()
        await release.promise
        runtime.keychain.set(keyOf(service, account), token)
      })
      const switching = own(h.service.switchTeam('fixture-other'))
      const rejection = switching.then(
        () => null,
        error => error
      )
      await awaitPhase(entered.promise, switching, 'admitted native writer')
      const logoutQueued = deferred()
      const persist = h.state.runSessionPersistence.bind(h.state)
      vi.spyOn(h.state, 'runSessionPersistence').mockImplementationOnce(operation => {
        logoutQueued.resolve()
        return persist(operation)
      })
      const clear = vi.spyOn(h.tokenStore, 'clearSessionTokenStrictly')
      const logout = own(h.service.logout())
      let logoutSettled = false
      void logout.then(
        () => {
          logoutSettled = true
        },
        () => {
          logoutSettled = true
        }
      )
      try {
        await awaitPhase(logoutQueued.promise, logout, 'queued logout storage transaction')
        expect(logoutSettled).toBe(false)
        expect(clear).not.toHaveBeenCalled()
      } finally {
        release.resolve()
      }
      await rejection
      await logout
      vi.mocked(h.state.authClient.getMe).mockClear()
      await expect(h.service.initialize()).resolves.toEqual({ authenticated: false, me: null })
      const restarted = await harness()
      await expect(restarted.service.initialize()).resolves.toEqual({
        authenticated: false,
        me: null,
      })
      expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith('fixture-other-session')
      expect(h.state.authClient.getMe).not.toHaveBeenCalledWith('fixture-other-session')
      expect(h.service.getCachedUserId()).toBeNull()
      expect(await h.tokenStore.getKeytarSessionToken(h.envKey)).toBeNull()
      expect(await h.tokenStore.getSafeStorageSessionToken(h.envKey)).toBeNull()
    }
  )

  it('retains home authentication across restart after an ordinary team write partially failed', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    const keytar = await import('keytar')
    vi.mocked(keytar.setPassword).mockImplementationOnce(async (service, account, token) => {
      runtime.keychain.set(keyOf(service, account), token)
      throw new Error('fixture-partial ordinary Keytar write')
    })
    const rename = fs.rename.bind(fs)
    let fileWriteFailed = false
    vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      if (!fileWriteFailed && String(destination).endsWith('.enc')) {
        fileWriteFailed = true
        throw new Error('fixture-encrypted rename failed')
      }
      return rename(source, destination)
    })
    const error = await h.service.switchTeam('fixture-other').then(
      () => null,
      error => error
    )
    expect(fileWriteFailed).toBe(true)
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: homeMe,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(homeToken)
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith('fixture-other-session')
    expect(h.state.sessionToken).toBe(homeToken)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe('fixture-encrypted rename failed')
  })
})

describe('R20-M5 rejected encrypted fallback residue', () => {
  it('keeps verified old Keytar authentication quarantined when encrypted disposal fails', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    h.markers.recordPendingKeytarCleanup(runtime.directory, h.envKey, 'active-keytar')
    const keytar = await import('keytar')
    vi.mocked(keytar.setPassword).mockRejectedValueOnce(new Error('fixture-transient Keytar write'))
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.decryptString).mockReturnValueOnce('')
    const unlink = fsSync.unlinkSync.bind(fsSync)
    vi.spyOn(fsSync, 'unlinkSync').mockImplementation(file => {
      if (String(file).endsWith('.enc')) throw new Error('fixture-encrypted disposal failed')
      return unlink(file)
    })
    const error = await h.service.switchTeam('fixture-other').then(
      () => null,
      error => error
    )
    const firstRestart = await harness()
    const firstState = await firstRestart.service.initialize()
    const firstMarker = firstRestart.markers.readPendingExternalLogoutIntent(
      runtime.directory,
      h.envKey
    )
    vi.doMock('keytar', () => ({}))
    const secondRestart = await harness()
    await expect(secondRestart.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(secondRestart.state.authClient.getMe).not.toHaveBeenCalledWith('fixture-other-session')
    expect(firstState).toEqual({ authenticated: true, me: homeMe })
    expect(firstMarker).toEqual({
      intent: 'keytar-cleanup-pending',
      credentialSource: 'active-keytar',
    })
    expect(h.state.sessionToken).toBe(homeToken)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain('could not be verified')
  })

  it('does not restore a rejected fallback after cleanup retired and Keytar subsequently disappeared', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    h.markers.recordPendingKeytarCleanup(runtime.directory, h.envKey, 'active-keytar')
    const keytar = await import('keytar')
    vi.mocked(keytar.setPassword).mockRejectedValueOnce(new Error('fixture-transient Keytar write'))
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.decryptString).mockReturnValueOnce('')
    const error = await h.service.switchTeam('fixture-other').then(
      () => null,
      error => error
    )
    const firstRestart = await harness()
    const firstState = await firstRestart.service.initialize()
    const firstMarker = firstRestart.markers.readPendingExternalLogoutMarker(
      runtime.directory,
      h.envKey
    )
    vi.doMock('keytar', () => ({}))
    const secondRestart = await harness()
    await expect(secondRestart.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(secondRestart.state.authClient.getMe).not.toHaveBeenCalledWith('fixture-other-session')
    expect(firstState).toEqual({ authenticated: true, me: homeMe })
    expect(firstMarker).toBeNull()
    expect(h.state.sessionToken).toBe(homeToken)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain('could not be verified')
  })
})

describe('explicit login transient marker inspection', () => {
  it('does not normalize a valid cleanup marker after one transient EMFILE', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    h.markers.recordPendingKeytarCleanup(runtime.directory, h.envKey, 'active-keytar')
    const observed = h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)
    const markerPath = path.join(
      runtime.directory,
      `pending-external-logout-${createHash('sha256').update(h.envKey).digest('hex')}`
    )
    const open = fsSync.openSync.bind(fsSync)
    let failed = false
    vi.spyOn(fsSync, 'openSync').mockImplementation((file, flags, mode) => {
      if (!failed && String(file) === markerPath) {
        failed = true
        throw Object.assign(new Error('fixture-transient login marker read'), { code: 'EMFILE' })
      }
      return open(file, flags, mode)
    })
    const keytar = await import('keytar')
    vi.mocked(keytar.setPassword).mockClear()
    await expect(
      h.state.installAuthenticatedLogin({ token: 'fixture-must-not-install', me: homeMe })
    ).rejects.toThrow('fixture-transient login marker read')
    expect(h.state.sessionToken).toBe(homeToken)
    expect(h.state.me).toEqual(homeMe)
    expect(await h.tokenStore.getKeytarSessionToken(h.envKey)).toBe(homeToken)
    expect(h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)).toEqual(observed)
    expect(keytar.setPassword).not.toHaveBeenCalled()
  })
})

describe('R18-M3 cleanup-only revision ownership', () => {
  it('completes a verified fallback despite an older startup cleanup failure', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    h.markers.recordPendingKeytarCleanup(runtime.directory, h.envKey, 'active-keytar')
    const keytar = await import('keytar')
    const cleanupEntered = deferred()
    const cleanupRelease = deferred()
    vi.mocked(keytar.deletePassword).mockImplementationOnce(async () => {
      cleanupEntered.resolve()
      await cleanupRelease.promise
      throw new Error('fixture-legacy cleanup temporarily failed')
    })
    const restoring = own(h.service.initialize())
    await awaitPhase(cleanupEntered.promise, restoring, 'startup native cleanup')
    vi.mocked(keytar.setPassword).mockRejectedValueOnce(new Error('fixture-transient Keytar write'))
    const encryptedEntered = deferred()
    const encryptedRelease = deferred()
    const writeEncrypted = h.tokenStore.setSafeStorageSessionToken.bind(h.tokenStore)
    vi.spyOn(h.tokenStore, 'setSafeStorageSessionToken').mockImplementation(async (...args) => {
      await writeEncrypted(...args)
      encryptedEntered.resolve()
      await encryptedRelease.promise
    })
    const switching = own(h.service.switchTeam('fixture-other'))
    await new Promise(resolve => setImmediate(resolve))
    cleanupRelease.resolve()
    await awaitPhase(encryptedEntered.promise, switching, 'team encrypted fallback')
    encryptedRelease.resolve()
    await expect(switching).resolves.toEqual({
      authenticated: true,
      me: { ...homeMe, teamId: 'fixture-other' },
    })
    await restoring
    expect(h.markers.readPendingExternalLogoutIntent(runtime.directory, h.envKey)).toEqual({
      intent: 'keytar-cleanup-pending',
      credentialSource: 'safe-storage',
    })
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: { ...homeMe, teamId: 'fixture-other' },
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith('fixture-other-session')
  })
})

describe('R20-M6 queued source-plan fencing', () => {
  it('does not persist a rejected team token after queued cleanup retires its observed marker', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    h.markers.recordPendingKeytarCleanup(runtime.directory, h.envKey, 'active-keytar')
    const entered = deferred()
    const release = deferred()
    const snapshot = h.tokenStore.snapshotSessionTokenFallbackFiles.bind(h.tokenStore)
    vi.spyOn(h.tokenStore, 'snapshotSessionTokenFallbackFiles').mockImplementationOnce(
      async (...args) => {
        const observed = await snapshot(...args)
        entered.resolve()
        await release.promise
        return observed
      }
    )
    const cleanup = own(h.service.applyPendingExternalLogoutIntent())
    await awaitPhase(entered.promise, cleanup, 'queued cleanup retirement')
    const teamQueued = deferred()
    const persist = h.state.runSessionPersistence.bind(h.state)
    vi.spyOn(h.state, 'runSessionPersistence').mockImplementationOnce(operation => {
      teamQueued.resolve()
      return persist(operation)
    })
    const switching = own(h.service.switchTeam('fixture-other'))
    const rejected = switching.then(
      () => null,
      error => error
    )
    try {
      await awaitPhase(teamQueued.promise, switching, 'team transaction queued behind cleanup')
    } finally {
      release.resolve()
    }
    await cleanup
    const error = await rejected
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: homeMe,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(homeToken)
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith('fixture-other-session')
    expect(h.state.sessionToken).toBe(homeToken)
    expect(h.state.me).toEqual(homeMe)
    expect(h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)).toBeNull()
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain('Pending logout intent changed')
  })
})

describe('R20-M7 restore response epoch fencing', () => {
  it('returns signed-out state when logout completes during awaited cleanup retirement', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    h.markers.recordPendingKeytarCleanup(runtime.directory, h.envKey, 'active-keytar')
    const entered = deferred()
    const release = deferred()
    const state = h.service as unknown as {
      retirePendingKeytarCleanupAfterRestore: (plan: unknown, envKey: string) => Promise<void>
    }
    const retire = state.retirePendingKeytarCleanupAfterRestore.bind(state)
    // Hold only the outer response after real retirement releases its storage
    // lane, so completed logout remains a reachable restore-epoch competitor.
    vi.spyOn(state, 'retirePendingKeytarCleanupAfterRestore').mockImplementationOnce(
      async (...args) => {
        await retire(...args)
        entered.resolve()
        await release.promise
      }
    )
    const restoring = own(h.service.initialize())
    await awaitPhase(entered.promise, restoring, 'restore cleanup retirement')
    try {
      await h.service.logout()
    } finally {
      release.resolve()
    }
    await expect(restoring).resolves.toEqual({ authenticated: false, me: null })
    expect(h.state.sessionToken).toBeNull()
    expect(h.state.me).toBeNull()
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalled()
  })
})
