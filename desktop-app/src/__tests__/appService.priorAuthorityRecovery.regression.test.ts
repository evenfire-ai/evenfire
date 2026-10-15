import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import fsSync from 'node:fs'
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

describe('R21-M11 verified prior authority survives secure-source repair failure', () => {
  it.each(['none', 'active-keytar'] as const)(
    'recovers verified encrypted Home after partial native failure from %s authority',
    async source => {
      const h = await harness()
      await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
      if (source === 'active-keytar')
        h.markers.recordPendingKeytarCleanup(boundary.directory, h.envKey, source)
      boundary.setPassword.mockImplementation(async (service, account, token) => {
        if (token === teamToken) boundary.keychain.set(keyOf(service, account), token)
        throw new Error('fixture-native replacement and Home repair rejected')
      })
      const rename = fs.rename.bind(fs)
      let candidateRenameRejected = false
      vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        if (!candidateRenameRejected && String(to) === h.encryptedPath) {
          candidateRenameRejected = true
          throw new Error('fixture-encrypted candidate rename rejected')
        }
        return rename(from, to)
      })
      boundary.notifySessionChanged.mockClear()
      const error = await h.service.switchTeam('fixture-team').then(
        () => null,
        error => error
      )
      const recoveryMarker = h.markers.readPendingExternalLogoutMarker(boundary.directory, h.envKey)
      const restarted = await harness()
      await expect(restarted.service.initialize()).resolves.toEqual({
        authenticated: true,
        me: homeMe,
      })
      expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(homeToken)
      expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(teamToken)
      expect(h.service.getCachedUserId()).toBe(homeMe.id)
      expect(h.state.sessionToken).toBe(homeToken)
      expect(await h.tokenStore.getSafeStorageSessionToken(h.envKey)).toBe(homeToken)
      expect(recoveryMarker?.intent).toEqual({
        intent: 'keytar-cleanup-pending',
        credentialSource: 'safe-storage',
      })
      expect(h.journal.readSessionPersistenceJournal(boundary.directory, h.envKey)).toBeNull()
      expect(boundary.notifySessionChanged).not.toHaveBeenCalledWith(false)
      expect(candidateRenameRejected).toBe(true)
      expect(error).toBeInstanceOf(Error)
    }
  )

  async function encryptedSource(options: { nativeValue?: string } = {}) {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    await h.tokenStore.setSafeStorageSessionToken(homeToken, h.envKey)
    h.markers.recordPendingKeytarCleanup(boundary.directory, h.envKey, 'safe-storage')
    if (options.nativeValue)
      await h.tokenStore.setSessionToken(options.nativeValue, h.envKey, { requireKeytar: true })
    const { safeStorage } = await import('electron')
    const rename = fs.rename.bind(fs)
    let candidateRenamed = false
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      await rename(from, to)
      if (!candidateRenamed && String(to) === h.encryptedPath) {
        candidateRenamed = true
        vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
      }
    })
    boundary.setPassword.mockClear()
    return { ...h, candidateRenamed: () => candidateRenamed, safeStorage }
  }

  it('source-transfers only exact verified native Home when CP-S becomes unavailable after publication', async () => {
    const h = await encryptedSource()
    boundary.notifySessionChanged.mockClear()
    const error = await h.service.switchTeam('fixture-team').then(
      () => null,
      error => error
    )
    const recoveryMarker = h.markers.readPendingExternalLogoutMarker(boundary.directory, h.envKey)
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: homeMe,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(teamToken)
    expect(h.service.getCachedUserId()).toBe(homeMe.id)
    expect(await h.tokenStore.getKeytarSessionToken(h.envKey)).toBe(homeToken)
    expect(recoveryMarker?.intent).toEqual({
      intent: 'keytar-cleanup-pending',
      credentialSource: 'active-keytar',
    })
    expect(h.journal.readSessionPersistenceJournal(boundary.directory, h.envKey)).toBeNull()
    expect(boundary.setPassword).not.toHaveBeenCalled()
    expect(boundary.notifySessionChanged).not.toHaveBeenCalledWith(false)
    expect(h.candidateRenamed()).toBe(true)
    expect(error).toBeInstanceOf(Error)
  })

  it('does not source-transfer another native value or overwrite that producer with Home', async () => {
    const different = 'fixture-independent-native-value'
    const h = await encryptedSource({ nativeValue: different })
    const error = await h.service.switchTeam('fixture-team').then(
      () => null,
      error => error
    )
    expect(h.candidateRenamed()).toBe(true)
    expect(await h.tokenStore.getKeytarSessionToken(h.envKey)).toBe(different)
    expect(boundary.setPassword).not.toHaveBeenCalled()
    expect(h.service.getCachedUserId()).toBeNull()
    expect(h.markers.readPendingExternalLogoutMarker(boundary.directory, h.envKey)?.intent).toEqual(
      { intent: 'keytar-cleanup-pending', credentialSource: 'safe-storage' }
    )
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalled()
    expect(error).toBeInstanceOf(Error)
  })

  it('retains Home denial when its accepting native source frame renames but fsync fails', async () => {
    const h = await encryptedSource()
    const rename = fsSync.renameSync.bind(fsSync)
    const sync = fsSync.fsyncSync.bind(fsSync)
    let transferRenamed = false
    let transferSyncFailed = false
    vi.spyOn(fsSync, 'renameSync').mockImplementation((from, to) => {
      rename(from, to)
      if (String(to) === h.markerPath) transferRenamed = true
    })
    vi.spyOn(fsSync, 'fsyncSync').mockImplementation(descriptor => {
      if (transferRenamed && !transferSyncFailed && fsSync.fstatSync(descriptor).isDirectory()) {
        transferSyncFailed = true
        throw Object.assign(new Error('fixture-native source-transfer fsync failed'), {
          code: 'EIO',
        })
      }
      return sync(descriptor)
    })
    const error = await h.service.switchTeam('fixture-team').then(
      () => null,
      error => error
    )
    expect(transferRenamed && transferSyncFailed).toBe(true)
    expect(
      h.journal.isSessionPersistenceCandidateDenied(
        h.journal.readSessionPersistenceJournal(boundary.directory, h.envKey),
        homeToken
      )
    ).toBe(true)
    expect(h.markers.readPendingExternalLogoutMarker(boundary.directory, h.envKey)?.intent).toEqual(
      { intent: 'keytar-cleanup-pending', credentialSource: 'active-keytar' }
    )
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(teamToken)
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(homeToken)
    expect(error).toBeInstanceOf(Error)
  })

  it('preserves an independent newer source admitted while prior native verification awaits', async () => {
    const h = await encryptedSource()
    const reachedNative = gate()
    const releaseNative = gate()
    const native = h.tokenStore.getKeytarSessionToken.bind(h.tokenStore)
    vi.spyOn(h.tokenStore, 'getKeytarSessionToken').mockImplementationOnce(async (...args) => {
      const result = await native(...args)
      reachedNative.resolve()
      await releaseNative.promise
      return result
    })
    const replacement = own(h.service.switchTeam('fixture-team'))
    const outcome = replacement.then(
      () => null,
      error => error
    )
    await entered(reachedNative.promise, replacement)
    try {
      vi.mocked(h.safeStorage.isEncryptionAvailable).mockReturnValue(true)
      const winner = await harness()
      await expect(
        winner.state.installAuthenticatedLogin({ token: freshToken, me: freshMe })
      ).resolves.toEqual({ authenticated: true, me: freshMe })
    } finally {
      releaseNative.resolve()
    }
    const error = await outcome
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: freshMe,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(homeToken)
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(teamToken)
    expect(await h.tokenStore.getKeytarSessionToken(h.envKey)).toBe(freshToken)
    expect(h.markers.readPendingExternalLogoutMarker(boundary.directory, h.envKey)).toBeNull()
    expect(error).toBeInstanceOf(Error)
  })

  it('repairs an available CP-S partial publication inside its named source without native fallback', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    await h.tokenStore.setSafeStorageSessionToken(homeToken, h.envKey)
    h.markers.recordPendingKeytarCleanup(boundary.directory, h.envKey, 'safe-storage')
    boundary.setPassword.mockClear()
    const rename = fs.rename.bind(fs)
    let candidateRenamed = false
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      await rename(from, to)
      if (!candidateRenamed && String(to) === h.encryptedPath) {
        candidateRenamed = true
        throw new Error('fixture-encrypted candidate renamed then rejected')
      }
    })
    const error = await h.service.switchTeam('fixture-team').then(
      () => null,
      error => error
    )
    expect(candidateRenamed).toBe(true)
    expect(await h.tokenStore.getSafeStorageSessionToken(h.envKey)).toBe(homeToken)
    expect(boundary.setPassword).not.toHaveBeenCalled()
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: homeMe,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(teamToken)
    expect(h.service.getCachedUserId()).toBe(homeMe.id)
    expect(error).toBeInstanceOf(Error)
  })
})
