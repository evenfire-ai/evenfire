import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import fsSync from 'node:fs'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const boundary = vi.hoisted(() => ({
  directory: '',
  credentials: new Map<string, string>(),
  getPassword: vi.fn(),
  setPassword: vi.fn(),
  deletePassword: vi.fn(),
  notifySessionChanged: vi.fn(),
}))
const accountKey = (service: string, account: string) => `${service}::${account}`
vi.mock('keytar', () => ({
  getPassword: boundary.getPassword,
  setPassword: boundary.setPassword,
  deletePassword: boundary.deletePassword,
}))
vi.mock('electron', () => ({
  app: { getPath: () => boundary.directory, isReady: () => true },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
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

const homeToken = 'fixture-home-session'
const otherToken = 'fixture-other-session'
const freshToken = 'fixture-new-user-session'
const homeMe = {
  id: 'fixture-user',
  email: 'fixture@example.com',
  name: null,
  picture: null,
  teamId: 'fixture-home',
  teamName: 'Fixture home',
  role: 'member',
}
const releases = new Set<() => void>()
const operations = new Set<Promise<unknown>>()

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  boundary.credentials.clear()
  boundary.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-persistence-contract-'))
  vi.doMock('keytar', () => ({
    getPassword: boundary.getPassword,
    setPassword: boundary.setPassword,
    deletePassword: boundary.deletePassword,
  }))
  boundary.getPassword
    .mockReset()
    .mockImplementation(
      async (service, account) => boundary.credentials.get(accountKey(service, account)) ?? null
    )
  boundary.setPassword.mockReset().mockImplementation(async (service, account, token) => {
    boundary.credentials.set(accountKey(service, account), token)
  })
  boundary.deletePassword
    .mockReset()
    .mockImplementation(async (service, account) =>
      boundary.credentials.delete(accountKey(service, account))
    )
  const { safeStorage } = await import('electron')
  vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
  vi.mocked(safeStorage.decryptString).mockImplementation(value =>
    value.toString().replace(/^encrypted:/, '')
  )
})

afterEach(async () => {
  for (const release of releases) release()
  await Promise.allSettled([...operations])
  releases.clear()
  vi.restoreAllMocks()
  await fs.rm(boundary.directory, { recursive: true, force: true })
  boundary.credentials.clear()
  vi.resetModules()
})

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = () => {
      releases.delete(resolve)
      done()
    }
  })
  releases.add(resolve)
  return { promise, resolve }
}

function own<T>(operation: Promise<T>): Promise<T> {
  operations.add(operation)
  void operation.then(
    () => operations.delete(operation),
    () => operations.delete(operation)
  )
  return operation
}

async function entered(phase: Promise<void>, producer: Promise<unknown>, label: string) {
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
    expect(result, `Expected admitted producer to reach ${label}`).toBe('entered')
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function harness() {
  const [{ AppService }, { TokenStore }, markers, config] = await Promise.all([
    import('../appService.js'),
    import('../tokenStore.js'),
    import('../pendingExternalLogout.js'),
    import('../config.js'),
  ])
  const tokenStore = new TokenStore()
  const service = new AppService({
    tokenStore,
    getUserDataDirectory: () => boundary.directory,
    reportDeferredLogoutFailure: vi.fn(),
  })
  const state = service as unknown as {
    sessionToken: string | null
    me: typeof homeMe | null
    installAuthenticatedLogin: (value: { token: string; me: typeof homeMe }) => Promise<unknown>
    runSessionPersistence: <T>(operation: () => Promise<T>) => Promise<T>
    authClient: {
      getMe: (token: string) => Promise<typeof homeMe>
      switchTeam: (token: string, teamId: string) => Promise<{ token: string }>
    }
  }
  vi.spyOn(state.authClient, 'getMe').mockImplementation(async token => ({
    ...homeMe,
    teamId: token === otherToken ? 'fixture-other' : homeMe.teamId,
  }))
  vi.spyOn(state.authClient, 'switchTeam').mockResolvedValue({ token: otherToken })
  return { service, tokenStore, state, markers, envKey: config.getActiveEnvKey() }
}

describe('source persistence mutation-sensitive contracts', () => {
  it('fences canceled-quit native cleanup after the admitted outer check when Fresh independently wins', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    await h.tokenStore.setSafeStorageSessionToken(homeToken, h.envKey)
    h.markers.recordPendingKeytarCleanup(boundary.directory, h.envKey, 'safe-storage')
    await h.service.prepareForQuit()
    h.service.cancelQuitPreparation()
    const reachedDispatch = gate()
    const releaseDispatch = gate()
    const clear = h.tokenStore.clearKeytarSessionTokensStrictly.bind(h.tokenStore)
    vi.spyOn(h.tokenStore, 'clearKeytarSessionTokensStrictly').mockImplementationOnce(
      async (...args) => {
        reachedDispatch.resolve()
        await releaseDispatch.promise
        return clear(...args)
      }
    )
    const cleanup = own(h.service.applyPendingExternalLogoutIntent())
    await entered(reachedDispatch.promise, cleanup, 'accepted canceled-quit native cleanup')
    const freshMe = { ...homeMe, id: 'fixture-canceled-new-user' }
    try {
      const freshProducer = await harness()
      await expect(
        freshProducer.state.installAuthenticatedLogin({ token: freshToken, me: freshMe })
      ).resolves.toEqual({ authenticated: true, me: freshMe })
      expect(await h.tokenStore.getKeytarSessionToken(h.envKey)).toBe(freshToken)
    } finally {
      releaseDispatch.resolve()
    }
    await expect(cleanup).resolves.toBe(false)
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
    expect(await h.tokenStore.getKeytarSessionToken(h.envKey)).toBe(freshToken)
    expect(h.markers.readPendingExternalLogoutMarker(boundary.directory, h.envKey)).toBeNull()
  })

  it('M12 binds an encrypted ordinary rollback so rejected native bytes cannot restore', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    boundary.setPassword.mockImplementation(async (service, account, token) => {
      if (token === otherToken) boundary.credentials.set(accountKey(service, account), token)
      throw new Error('fixture-native partial write or rollback failure')
    })
    const rename = fs.rename.bind(fs)
    let attemptedFileRejected = false
    vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      if (!attemptedFileRejected && String(destination).endsWith('.enc')) {
        attemptedFileRejected = true
        throw new Error('fixture-first encrypted rename failed')
      }
      return rename(source, destination)
    })
    const error = await h.service.switchTeam('fixture-other').then(
      () => null,
      error => error
    )
    const rollbackMarker = h.markers.readPendingExternalLogoutIntent(boundary.directory, h.envKey)
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: homeMe,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(homeToken)
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(otherToken)
    expect(h.state.sessionToken).toBe(homeToken)
    expect(await h.tokenStore.getSafeStorageSessionToken(h.envKey)).toBe(homeToken)
    expect(rollbackMarker).toEqual({
      intent: 'keytar-cleanup-pending',
      credentialSource: 'safe-storage',
    })
    expect(attemptedFileRejected).toBe(true)
    expect(error).toBeInstanceOf(Error)
  })

  it('M13 quarantines unremoved rejected encrypted bytes beside a verified ordinary native source', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    boundary.setPassword.mockRejectedValueOnce(new Error('fixture-native temporarily locked'))
    const open = fs.open.bind(fs)
    let writeSyncFailed = false
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args)
      if (!writeSyncFailed && String(args[0]) === boundary.directory) {
        vi.spyOn(handle, 'sync').mockImplementationOnce(async () => {
          writeSyncFailed = true
          throw new Error('fixture-encrypted directory sync failed')
        })
      }
      return handle
    })
    const unlink = fsSync.unlinkSync.bind(fsSync)
    vi.spyOn(fsSync, 'unlinkSync').mockImplementation(file => {
      if (String(file).endsWith('.enc')) throw new Error('fixture-encrypted discard failed')
      return unlink(file)
    })
    const error = await h.service.switchTeam('fixture-other').then(
      () => null,
      error => error
    )
    // No healthy startup may manufacture the source fence before this check:
    // rollback itself must keep rejected encrypted bytes non-authoritative.
    vi.doMock('keytar', () => ({}))
    const unavailableFirstRestart = await harness()
    await expect(unavailableFirstRestart.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(unavailableFirstRestart.state.authClient.getMe).not.toHaveBeenCalledWith(otherToken)
    vi.doMock('keytar', () => boundary)
    const firstRestart = await harness()
    await expect(firstRestart.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: homeMe,
    })
    vi.doMock('keytar', () => ({}))
    const secondRestart = await harness()
    await expect(secondRestart.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(secondRestart.state.authClient.getMe).not.toHaveBeenCalledWith(otherToken)
    expect(h.state.sessionToken).toBe(homeToken)
    expect(h.markers.readPendingExternalLogoutIntent(boundary.directory, h.envKey)).toEqual({
      intent: 'keytar-cleanup-pending',
      credentialSource: 'active-keytar',
    })
    expect(writeSyncFailed).toBe(true)
    expect(error).toBeInstanceOf(Error)
  })

  it('M14 retains the verified old source after conversion renamed but directory sync failed', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    h.markers.recordPendingKeytarCleanup(boundary.directory, h.envKey, 'active-keytar')
    boundary.setPassword.mockRejectedValueOnce(new Error('fixture-native temporarily locked'))
    const markerPath = path.join(
      boundary.directory,
      `pending-external-logout-${createHash('sha256').update(h.envKey).digest('hex')}`
    )
    const rename = fsSync.renameSync.bind(fsSync)
    const fsync = fsSync.fsyncSync.bind(fsSync)
    let conversionRenamed = false
    let conversionSyncFailed = false
    vi.spyOn(fsSync, 'renameSync').mockImplementation((from, to) => {
      rename(from, to)
      if (String(to) === markerPath) conversionRenamed = true
    })
    vi.spyOn(fsSync, 'fsyncSync').mockImplementation(descriptor => {
      if (
        !conversionSyncFailed &&
        conversionRenamed &&
        fsSync.fstatSync(descriptor).isDirectory()
      ) {
        conversionSyncFailed = true
        throw new Error('fixture-conversion directory sync failed')
      }
      return fsync(descriptor)
    })
    const error = await h.service.switchTeam('fixture-other').then(
      () => null,
      error => error
    )
    const restarted = await harness()
    const firstRestart = await restarted.service.initialize()
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    const secondRestart = await harness()
    // The rejected conversion must not let CP-S cleanup delete the old native
    // authority: it remains usable if only encrypted storage later disappears.
    await expect(secondRestart.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: homeMe,
    })
    expect(firstRestart).toEqual({ authenticated: true, me: homeMe })
    expect(secondRestart.state.authClient.getMe).toHaveBeenCalledWith(homeToken)
    expect(secondRestart.state.authClient.getMe).not.toHaveBeenCalledWith(otherToken)
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(homeToken)
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(otherToken)
    expect(h.state.sessionToken).toBe(homeToken)
    expect(conversionSyncFailed).toBe(true)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain('directory sync failed')
  })

  it('preserves restart authority after conversion sync failure and a transient rollback read', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    h.markers.recordPendingKeytarCleanup(boundary.directory, h.envKey, 'active-keytar')
    boundary.setPassword.mockRejectedValueOnce(new Error('fixture-native temporarily locked'))
    const markerPath = path.join(
      boundary.directory,
      `pending-external-logout-${createHash('sha256').update(h.envKey).digest('hex')}`
    )
    const fsync = fsSync.fsyncSync.bind(fsSync)
    const open = fsSync.openSync.bind(fsSync)
    const rename = fsSync.renameSync.bind(fsSync)
    let conversionRenamed = false
    let conversionSyncFailed = false
    let transientReadFailed = false
    let readsAfterConversion = 0
    vi.spyOn(fsSync, 'renameSync').mockImplementation((from, to) => {
      rename(from, to)
      if (String(to) === markerPath) conversionRenamed = true
    })
    vi.spyOn(fsSync, 'fsyncSync').mockImplementation(descriptor => {
      if (
        !conversionSyncFailed &&
        conversionRenamed &&
        fsSync.fstatSync(descriptor).isDirectory()
      ) {
        conversionSyncFailed = true
        throw new Error('fixture-conversion directory sync failed')
      }
      return fsync(descriptor)
    })
    vi.spyOn(fsSync, 'openSync').mockImplementation((file, flags, mode) => {
      if (
        conversionSyncFailed &&
        String(file) === markerPath &&
        !transientReadFailed &&
        ++readsAfterConversion === 2
      ) {
        transientReadFailed = true
        throw Object.assign(new Error('fixture-transient rollback marker read'), { code: 'EMFILE' })
      }
      return open(file, flags, mode)
    })
    const error = await h.service.switchTeam('fixture-other').then(
      () => null,
      error => error
    )
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: homeMe,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(homeToken)
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(otherToken)
    expect(h.state.sessionToken).toBe(homeToken)
    expect(h.state.me).toEqual(homeMe)
    expect(conversionSyncFailed).toBe(true)
    expect(transientReadFailed).toBe(true)
    expect(error).toBeInstanceOf(Error)
  })

  it.each(['canceled-retry', 'startup'] as const)(
    '%s rechecks the source plan queued behind a fresh Keytar login (M24-apply / M23)',
    async operation => {
      const h = await harness()
      await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
      await h.tokenStore.setSafeStorageSessionToken(homeToken, h.envKey)
      h.markers.recordPendingKeytarCleanup(boundary.directory, h.envKey, 'safe-storage')
      if (operation === 'canceled-retry') {
        await h.service.prepareForQuit()
        h.service.cancelQuitPreparation()
      }
      const nativeEntered = gate()
      const nativeRelease = gate()
      boundary.setPassword.mockImplementationOnce(async (service, account, token) => {
        nativeEntered.resolve()
        await nativeRelease.promise
        boundary.credentials.set(accountKey(service, account), token)
      })
      const freshMe = { ...homeMe, id: 'fixture-new-user' }
      const login = own(h.state.installAuthenticatedLogin({ token: freshToken, me: freshMe }))
      await entered(nativeEntered.promise, login, 'fresh login native setter')
      const queued = gate()
      const persist = h.state.runSessionPersistence.bind(h.state)
      vi.spyOn(h.state, 'runSessionPersistence').mockImplementationOnce(callback => {
        const pending = persist(callback)
        queued.resolve()
        return pending
      })
      const cleanup = own<unknown>(
        operation === 'canceled-retry'
          ? h.service.applyPendingExternalLogoutIntent()
          : h.service.initialize()
      )
      await entered(queued.promise, cleanup, 'actual queued cleanup transaction')
      nativeRelease.resolve()
      await Promise.all([login, cleanup])
      const restarted = await harness()
      vi.mocked(restarted.state.authClient.getMe).mockResolvedValue(freshMe)
      await expect(restarted.service.initialize()).resolves.toEqual({
        authenticated: true,
        me: freshMe,
      })
      expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(freshToken)
      expect(h.state.sessionToken).toBe(freshToken)
      expect(h.state.me).toEqual(freshMe)
      expect(await h.tokenStore.getKeytarSessionToken(h.envKey)).toBe(freshToken)
      expect(boundary.notifySessionChanged).not.toHaveBeenCalledWith(false)
    }
  )

  it('M21 refuses a CP-S replacement whose encrypted read-back cannot be verified', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    await h.tokenStore.setSafeStorageSessionToken(homeToken, h.envKey)
    h.markers.recordPendingKeytarCleanup(boundary.directory, h.envKey, 'safe-storage')
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.decryptString).mockReturnValueOnce('')
    const error = await h.service.switchTeam('fixture-other').then(
      () => null,
      error => error
    )
    vi.mocked(safeStorage.decryptString)
      .mockReset()
      .mockImplementation(value => value.toString().replace(/^encrypted:/, ''))
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: homeMe,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(homeToken)
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(otherToken)
    expect(h.state.sessionToken).toBe(homeToken)
    expect(await h.tokenStore.getSafeStorageSessionToken(h.envKey)).toBe(homeToken)
    expect(error).toBeInstanceOf(Error)
  })

  it('preserves a newer encrypted producer when a stale login cannot authorize fallback (M28)', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    h.markers.recordPendingKeytarCleanup(boundary.directory, h.envKey, 'active-keytar')
    const nativeEntered = gate()
    const nativeRelease = gate()
    boundary.setPassword.mockImplementationOnce(async () => {
      nativeEntered.resolve()
      await nativeRelease.promise
      throw new Error('fixture-stale login native write rejected')
    })
    const login = own(
      h.state.installAuthenticatedLogin({
        token: otherToken,
        me: { ...homeMe, id: 'rejected-user' },
      })
    )
    const outcome = login.then(
      () => null,
      error => error
    )
    let newerMarker: ReturnType<typeof h.markers.readPendingExternalLogoutMarker> | undefined
    try {
      await entered(nativeEntered.promise, login, 'older login native setter')
      // Use the actual independent source and revision producers. No marker or
      // TokenStore observation is fabricated to impersonate the newer winner.
      await h.tokenStore.setSafeStorageSessionToken(freshToken, h.envKey)
      h.markers.recordPendingKeytarCleanup(boundary.directory, h.envKey, 'safe-storage')
      newerMarker = h.markers.readPendingExternalLogoutMarker(boundary.directory, h.envKey)
    } finally {
      nativeRelease.resolve()
    }
    const error = await outcome
    const markerAfterFailure = h.markers.readPendingExternalLogoutMarker(
      boundary.directory,
      h.envKey
    )
    const restarted = await harness()
    const freshMe = { ...homeMe, id: 'fixture-new-user' }
    vi.mocked(restarted.state.authClient.getMe).mockImplementation(async token =>
      token === freshToken
        ? freshMe
        : { ...homeMe, id: token === otherToken ? 'rejected-user' : homeMe.id }
    )
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: freshMe,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(freshToken)
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(otherToken)
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(homeToken)
    expect(await h.tokenStore.getSafeStorageSessionToken(h.envKey)).toBe(freshToken)
    expect(markerAfterFailure).toEqual(newerMarker)
    expect(newerMarker?.intent).toEqual({
      intent: 'keytar-cleanup-pending',
      credentialSource: 'safe-storage',
    })
    expect(error).toBeInstanceOf(Error)
  })

  it.each(['team', 'login'] as const)(
    '%s cannot authorize fallback after an independent durable logout supersedes its write',
    async operation => {
      const h = await harness()
      await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
      h.markers.recordPendingKeytarCleanup(boundary.directory, h.envKey, 'active-keytar')
      const nativeEntered = gate()
      const nativeRelease = gate()
      boundary.setPassword.mockImplementationOnce(async () => {
        nativeEntered.resolve()
        await nativeRelease.promise
        throw new Error('fixture-native setter rejected after durable logout intent')
      })
      const replacement = own(
        operation === 'team'
          ? h.service.switchTeam('fixture-other')
          : h.state.installAuthenticatedLogin({
              token: freshToken,
              me: { ...homeMe, id: 'fixture-new-user' },
            })
      )
      const outcome = replacement.then(
        () => null,
        error => error
      )
      await entered(nativeEntered.promise, replacement, 'replacement native setter')
      // An independent quit-time producer can advance the durable revision while
      // the session queue is occupied. UI logout itself intentionally cannot.
      try {
        h.markers.recordPendingExternalLogout(boundary.directory, h.envKey)
      } finally {
        nativeRelease.resolve()
      }
      const error = await outcome
      expect(await h.tokenStore.getSafeStorageSessionToken(h.envKey)).toBeNull()
      expect(h.markers.readPendingExternalLogoutIntent(boundary.directory, h.envKey)).toEqual({
        intent: 'logout-pending',
      })
      const restarted = await harness()
      await expect(restarted.service.initialize()).resolves.toEqual({
        authenticated: false,
        me: null,
      })
      expect(restarted.state.authClient.getMe).not.toHaveBeenCalled()
      expect(await h.tokenStore.getKeytarSessionToken(h.envKey)).toBeNull()
      expect(await h.tokenStore.getSafeStorageSessionToken(h.envKey)).toBeNull()
      expect(error).toBeInstanceOf(Error)
    }
  )
})
