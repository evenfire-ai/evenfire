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
const releases = new Set<() => void>()
const operations = new Set<Promise<unknown>>()

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

async function entered(phase: Promise<void>, producer: Promise<unknown>) {
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
    expect(result, 'The real migration must reach authentication validation').toBe('entered')
  } finally {
    if (timer) clearTimeout(timer)
  }
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
  for (const release of releases) release()
  await Promise.allSettled([...operations])
  releases.clear()
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

describe('R21-M13 selected-source ownership after asynchronous cleanup', () => {
  it('preserves accepted Fresh when the older native source changes during cleanup', async () => {
    const older = await harness()
    const cleanupEntered = gate()
    const releaseCleanup = gate()
    const clear = older.tokenStore.clearKeytarSessionTokensStrictly.bind(older.tokenStore)
    vi.spyOn(older.tokenStore, 'clearKeytarSessionTokensStrictly').mockImplementationOnce(
      async (...args) => {
        const result = await clear(...args)
        cleanupEntered.resolve()
        await releaseCleanup.promise
        return result
      }
    )
    const installing = own(older.state.installAuthenticatedLogin({ token: homeToken, me: homeMe }))
    const outcome = installing.then(
      value => ({ status: 'fulfilled' as const, value }),
      error => ({ status: 'rejected' as const, error })
    )
    await entered(cleanupEntered.promise, installing)
    const fresh = await harness()
    try {
      await expect(
        fresh.state.installAuthenticatedLogin({ token: freshToken, me: freshMe })
      ).resolves.toEqual({ authenticated: true, me: freshMe })
      expect(await fresh.tokenStore.getKeytarSessionToken(fresh.envKey)).toBe(freshToken)
      expect(
        fresh.markers.readPendingExternalLogoutMarker(boundary.directory, fresh.envKey)
      ).toBeNull()
    } finally {
      releaseCleanup.resolve()
    }
    const completed = await outcome
    const markerAfterOlderCompletion = older.markers.readPendingExternalLogoutMarker(
      boundary.directory,
      older.envKey
    )
    const restart = await harness()
    await expect(restart.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: freshMe,
    })
    expect(restart.state.authClient.getMe).toHaveBeenCalledWith(freshToken)
    expect(restart.state.authClient.getMe).not.toHaveBeenCalledWith(homeToken)
    expect(await fresh.tokenStore.getKeytarSessionToken(fresh.envKey)).toBe(freshToken)
    expect(fresh.state.sessionToken).toBe(freshToken)
    expect(fresh.state.me).toEqual(freshMe)
    expect(older.state.sessionToken).toBeNull()
    expect(older.state.me).toBeNull()
    expect(completed.status).toBe('rejected')
    expect(markerAfterOlderCompletion).toBeNull()
  })
})

describe('R21-M13 original publication cannot adopt a newer identical accepted source', () => {
  it('keeps the accepted same-token publisher through an older required binding failure', async () => {
    const older = await harness()
    const firstSetterEntered = gate()
    const releaseFirstSetter = gate()
    const newerSetterAdmitted = gate()
    const releaseOlderBinding = gate()
    let nativeWrites = 0
    boundary.setPassword.mockImplementation(async (service, account, token) => {
      boundary.keychain.set(keyOf(service, account), token)
      if (token === homeToken && ++nativeWrites === 1) {
        firstSetterEntered.resolve()
        await releaseFirstSetter.promise
      }
    })
    const olderBinding = older.state as unknown as {
      bindCurrentChatStore: (userId: string) => Promise<void>
    }
    const bind = olderBinding.bindCurrentChatStore.bind(olderBinding)
    let olderBindingDispatch = false
    const { bindChatStoreForUser } = await import('../chatStoreBinding.js')
    vi.mocked(bindChatStoreForUser).mockImplementation(async () => {
      if (olderBindingDispatch) throw new Error('fixture-older required chat binding failed')
    })
    vi.spyOn(olderBinding, 'bindCurrentChatStore').mockImplementation(async (...args) => {
      await releaseOlderBinding.promise
      olderBindingDispatch = true
      try {
        return await bind(...args)
      } finally {
        olderBindingDispatch = false
      }
    })
    const oldInstall = own(older.state.installAuthenticatedLogin({ token: homeToken, me: homeMe }))
    const oldOutcome = oldInstall.then(
      value => ({ status: 'fulfilled' as const, value }),
      error => ({ status: 'rejected' as const, error })
    )
    await entered(firstSetterEntered.promise, oldInstall)
    const fresh = await harness()
    const setFresh = fresh.tokenStore.setSessionToken.bind(fresh.tokenStore)
    vi.spyOn(fresh.tokenStore, 'setSessionToken').mockImplementationOnce((...args) => {
      const pending = setFresh(...args)
      newerSetterAdmitted.resolve()
      return pending
    })
    const newInstall = own(fresh.state.installAuthenticatedLogin({ token: homeToken, me: homeMe }))
    try {
      await entered(newerSetterAdmitted.promise, newInstall)
      // Drain one event-loop turn while the real first account operation remains held:
      // the second accepted leaf call has joined that same account's actual FIFO.
      await new Promise<void>(resolve => setImmediate(resolve))
      releaseFirstSetter.resolve()
      await expect(newInstall).resolves.toEqual({ authenticated: true, me: homeMe })
      expect(nativeWrites).toBe(2)
      expect(await fresh.tokenStore.getKeytarSessionToken(fresh.envKey)).toBe(homeToken)
      expect(fresh.state.sessionToken).toBe(homeToken)
      expect(fresh.state.me).toEqual(homeMe)
      expect(
        fresh.markers.readPendingExternalLogoutMarker(boundary.directory, fresh.envKey)
      ).toBeNull()
    } finally {
      releaseFirstSetter.resolve()
      releaseOlderBinding.resolve()
    }
    const rejected = await oldOutcome
    const restart = await harness()
    await expect(restart.service.initialize()).resolves.toEqual({ authenticated: true, me: homeMe })
    expect(restart.state.authClient.getMe).toHaveBeenCalledWith(homeToken)
    expect(await fresh.tokenStore.getKeytarSessionToken(fresh.envKey)).toBe(homeToken)
    expect(fresh.state.sessionToken).toBe(homeToken)
    expect(fresh.state.me).toEqual(homeMe)
    expect(rejected.status).toBe('rejected')
    expect(older.state.sessionToken).toBeNull()
  })
})
