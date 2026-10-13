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
    resolve = done
  })
  return { promise, resolve }
}

describe('failed login fences an already-admitted logout', () => {
  it('does not restore a rejected credential after the older logout finishes', async () => {
    const h = await harness()
    h.markers.recordPendingExternalLogout(runtime.directory, h.envKey)
    const entered = deferred()
    const release = deferred()
    const keytar = await import('keytar')
    const activeAccount = `session-token::${h.envKey}`
    let firstActiveDelete = true
    vi.mocked(keytar.deletePassword).mockImplementation(async (service, account) => {
      if (account === activeAccount && firstActiveDelete) {
        firstActiveDelete = false
        const deleted = runtime.keychain.delete(keyOf(service, account))
        entered.resolve()
        await release.promise
        return deleted
      }
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
    const oldLogout = h.service.logout()
    await entered.promise
    try {
      await expect(
        h.state.installAuthenticatedLogin({ token: 'fixture-rejected-session', me: homeMe })
      ).rejects.toThrow('Fresh session token could not be verified')
    } finally {
      release.resolve()
      await oldLogout
    }
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
  })
})

describe('team persistence preserves the existing secure session on transient failures', () => {
  it('preserves old CP-K authentication when native absence precedes a rejected encrypted fallback', async () => {
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
      credentialSource: 'active-keytar',
    })
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith('fixture-other-session')
  })

  it('keeps accepted cleanup eligibility inside the quit-drained producer lifetime', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    h.markers.recordPendingKeytarCleanup(runtime.directory, h.envKey, 'active-keytar')
    const entered = deferred()
    const release = deferred()
    const read = h.tokenStore.getSafeStorageSessionToken.bind(h.tokenStore)
    vi.spyOn(h.tokenStore, 'getSafeStorageSessionToken').mockImplementation(async (...args) => {
      const result = await read(...args)
      entered.resolve()
      await release.promise
      return result
    })
    const events: string[] = []
    const retry = h.service.applyPendingExternalLogoutIntent().then(result => {
      events.push('retry')
      return result
    })
    await entered.promise
    const quitting = h.service.prepareForQuit().then(() => {
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

  it('quarantines old encrypted credentials after a fresh Keytar login from CP-S', async () => {
    const h = await harness()
    await h.tokenStore.setSafeStorageSessionToken('fixture-previous-user-session', h.envKey)
    h.markers.recordPendingKeytarCleanup(runtime.directory, h.envKey, 'safe-storage')
    const freshMe = { ...homeMe, id: 'fixture-new-user' }
    await expect(
      h.state.installAuthenticatedLogin({ token: 'fixture-new-user-session', me: freshMe })
    ).resolves.toEqual({ authenticated: true, me: freshMe })
    expect(h.markers.readPendingExternalLogoutIntent(runtime.directory, h.envKey)).toEqual({
      intent: 'keytar-cleanup-pending',
      credentialSource: 'active-keytar',
    })
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

  it('fences a partial write when restoring the old authoritative credential also fails', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    h.markers.recordPendingKeytarCleanup(runtime.directory, h.envKey, 'active-keytar')
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    const keytar = await import('keytar')
    vi.mocked(keytar.setPassword).mockImplementation(async (service, account, token) => {
      if (token !== homeToken) runtime.keychain.set(keyOf(service, account), token)
      throw new Error('fixture-active write and restoration fail')
    })
    await expect(h.service.switchTeam('fixture-other')).rejects.toThrow(/Keytar|safeStorage/)
    expect(h.service.getCachedUserId()).toBeNull()
    expect(h.markers.readPendingExternalLogoutIntent(runtime.directory, h.envKey)).toEqual({
      intent: 'logout-pending',
    })
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
    const switching = h.service.switchTeam('fixture-other')
    await entered.promise
    const draining = h.service.prepareForQuit()
    await expect(h.service.logout()).rejects.toThrow('shutting down')
    const newer = h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)
    release.resolve()
    await expect(switching).rejects.toThrow('Pending logout intent changed')
    await draining
    expect(h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)).toEqual(newer)
    expect(h.state.sessionToken).toBe(homeToken)
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalled()
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
  it('does not let a paused restorative write overwrite a completed newer login', async () => {
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
    const switching = h.service.switchTeam('fixture-other')
    const switchedResult = switching.then(
      () => undefined,
      () => undefined
    )
    await restoringEntered.promise
    const newerMe = { ...homeMe, id: 'fixture-new-user' }
    const newer = h.state.installAuthenticatedLogin({
      token: 'fixture-new-user-session',
      me: newerMe,
    })
    await Promise.race([newer, new Promise(resolve => setTimeout(resolve, 250))])
    restoringRelease.resolve()
    await Promise.all([switchedResult, newer])
    expect(h.service.getCachedUserId()).toBe(newerMe.id)
    const restarted = await harness()
    vi.mocked(restarted.state.authClient.getMe).mockResolvedValue(newerMe)
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: newerMe,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith('fixture-new-user-session')
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(homeToken)
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
    const switching = h.service.switchTeam('fixture-other')
    const switchedResult = switching.then(
      () => undefined,
      () => undefined
    )
    await entered.promise
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
    const switching = h.service.switchTeam('fixture-other')
    // Attach rejection immediately: the buggy snapshot rejects after its stale write completes.
    const switchedResult = switching.then(
      () => undefined,
      () => undefined
    )
    await entered.promise
    const newerMe = { ...homeMe, id: 'fixture-new-user' }
    const newer = h.state.installAuthenticatedLogin({
      token: 'fixture-new-user-session',
      me: newerMe,
    })
    // A bounded scheduling window lets the buggy ungated login actually finish;
    // the fixed gate holds it until the admitted older native setter settles.
    await Promise.race([newer, new Promise(resolve => setTimeout(resolve, 250))])
    release.resolve()
    await Promise.all([switchedResult, newer])
    expect(h.service.getCachedUserId()).toBe(newerMe.id)
    const restarted = await harness()
    vi.mocked(restarted.state.authClient.getMe).mockResolvedValue(newerMe)
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: newerMe,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith('fixture-new-user-session')
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith('fixture-other-session')
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
    const restoring = h.service.initialize()
    await cleanupEntered.promise
    vi.mocked(keytar.setPassword).mockRejectedValueOnce(new Error('fixture-transient Keytar write'))
    const encryptedEntered = deferred()
    const encryptedRelease = deferred()
    const writeEncrypted = h.tokenStore.setSafeStorageSessionToken.bind(h.tokenStore)
    vi.spyOn(h.tokenStore, 'setSafeStorageSessionToken').mockImplementation(async (...args) => {
      await writeEncrypted(...args)
      encryptedEntered.resolve()
      await encryptedRelease.promise
    })
    const switching = h.service.switchTeam('fixture-other')
    await new Promise(resolve => setImmediate(resolve))
    cleanupRelease.resolve()
    await Promise.race([encryptedEntered.promise, switching.catch(() => undefined)])
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
