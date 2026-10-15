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

describe('actual AppService write-ahead acceptance and migration', () => {
  it('accepts its own real secure legacy migration only after restart authentication', async () => {
    const h = await harness()
    const legacyFile = path.join(boundary.directory, 'session-token.json')
    await fs.writeFile(legacyFile, JSON.stringify({ token: homeToken }), { mode: 0o600 })

    const reachedAuthentication = gate()
    const releaseAuthentication = gate()
    vi.mocked(h.state.authClient.getMe).mockImplementationOnce(async () => {
      reachedAuthentication.resolve()
      await releaseAuthentication.promise
      return homeMe
    })
    const restoration = own(h.service.initialize())
    await entered(reachedAuthentication.promise, restoration)
    expect(await h.tokenStore.getKeytarSessionToken(h.envKey)).toBe(homeToken)
    expect(
      h.journal.isSessionPersistenceCandidateDenied(
        h.journal.readSessionPersistenceJournal(boundary.directory, h.envKey),
        homeToken
      )
    ).toBe(true)
    expect(h.service.getCachedUserId()).toBeNull()
    releaseAuthentication.resolve()
    await expect(restoration).resolves.toEqual({ authenticated: true, me: homeMe })

    expect(h.state.authClient.getMe).toHaveBeenCalledWith(homeToken)
    expect(await h.tokenStore.getKeytarSessionToken(h.envKey)).toBe(homeToken)
    await expect(fs.access(legacyFile)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(h.journal.readSessionPersistenceJournal(boundary.directory, h.envKey)).toBeNull()
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: homeMe,
    })
  })

  it('does not launder an older denied same hash through automatic legacy migration', async () => {
    const h = await harness()
    const older = new h.journal.SessionPersistenceProducer(
      boundary.directory,
      h.envKey,
      null,
      () => {},
      () => {}
    )
    older.prepare('keytar', homeToken)
    const legacyFile = path.join(boundary.directory, 'session-token.json')
    await fs.writeFile(legacyFile, JSON.stringify({ token: homeToken }), { mode: 0o600 })

    await expect(h.service.initialize()).resolves.toEqual({ authenticated: false, me: null })

    expect(h.state.authClient.getMe).not.toHaveBeenCalledWith(homeToken)
    expect(boundary.setPassword).not.toHaveBeenCalled()
    expect(await h.tokenStore.getKeytarSessionToken(h.envKey)).toBeNull()
    expect(JSON.parse(await fs.readFile(legacyFile, 'utf8')).token).toBe(homeToken)
    expect(
      h.journal.isSessionPersistenceCandidateDenied(
        h.journal.readSessionPersistenceJournal(boundary.directory, h.envKey),
        homeToken
      )
    ).toBe(true)
    await expect(
      h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    ).resolves.toEqual({ authenticated: true, me: homeMe })
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: homeMe,
    })
    expect(h.journal.readSessionPersistenceJournal(boundary.directory, h.envKey)).toBeNull()
  })

  it('rejects journal admission before native publication without encrypted fallback or Home loss', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    boundary.setPassword.mockClear()
    const rename = vi.spyOn(fs, 'rename')
    const open = fsSync.openSync.bind(fsSync)
    const sync = fsSync.fsyncSync.bind(fsSync)
    const journalDescriptors = new Set<number>()
    let faultReached = false
    vi.spyOn(fsSync, 'openSync').mockImplementation((file, flags, mode) => {
      const descriptor = open(file, flags, mode)
      if (String(file).startsWith(`${h.journalPath}.`)) journalDescriptors.add(descriptor)
      return descriptor
    })
    const fault = vi.spyOn(fsSync, 'fsyncSync').mockImplementation(descriptor => {
      if (!faultReached && journalDescriptors.has(descriptor)) {
        faultReached = true
        throw Object.assign(new Error('fixture-prepare journal file sync'), { code: 'EIO' })
      }
      return sync(descriptor)
    })

    const error = await h.state.installAuthenticatedLogin({ token: freshToken, me: freshMe }).then(
      () => null,
      error => error
    )

    fault.mockRestore()
    expect(faultReached).toBe(true)
    expect(boundary.setPassword).not.toHaveBeenCalled()
    expect(rename).not.toHaveBeenCalledWith(expect.anything(), h.encryptedPath)
    expect(h.service.getCachedUserId()).toBe(homeMe.id)
    expect(
      (
        h.service as unknown as {
          currentDesktopGfsUploadScope: (drive: undefined) => { ownerId: string; teamId: string }
        }
      ).currentDesktopGfsUploadScope(undefined)
    ).toMatchObject({
      ownerId: homeMe.id,
      teamId: homeMe.teamId,
    })
    expect(await h.tokenStore.getKeytarSessionToken(h.envKey)).toBe(homeToken)
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: homeMe,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(freshToken)
    expect(error).toBeInstanceOf(Error)
  })

  it('denies a rejected candidate despite a visible accepting CP-S rename with failed directory sync', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    h.markers.recordPendingKeytarCleanup(boundary.directory, h.envKey, 'active-keytar')
    let locked = false
    boundary.setPassword.mockImplementation(async (service, account, token) => {
      boundary.keychain.set(keyOf(service, account), token)
      if (token === teamToken) {
        locked = true
        throw new Error('fixture-native candidate published then rejected')
      }
    })
    boundary.getPassword.mockImplementation(async (service, account) => {
      if (locked) throw new Error('fixture-native source locked during rejected repair')
      return boundary.keychain.get(keyOf(service, account)) ?? null
    })
    const rename = fsSync.renameSync.bind(fsSync)
    const sync = fsSync.fsyncSync.bind(fsSync)
    const unlink = fsSync.unlinkSync.bind(fsSync)
    let conversionLanded = false
    let syncFailed = false
    let priorEncryptedPublicationRejected = false
    const renameEncrypted = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (
        locked &&
        String(to) === h.encryptedPath &&
        (await fs.readFile(from)).equals(Buffer.from(`encrypted:${homeToken}`))
      ) {
        priorEncryptedPublicationRejected = true
        throw Object.assign(new Error('fixture-prior encrypted repair publication failed'), {
          code: 'EIO',
        })
      }
      return renameEncrypted(from, to)
    })
    vi.spyOn(fsSync, 'renameSync').mockImplementation((from, to) => {
      rename(from, to)
      if (String(to) === h.markerPath) conversionLanded = true
    })
    vi.spyOn(fsSync, 'fsyncSync').mockImplementation(descriptor => {
      if (conversionLanded && !syncFailed && fsSync.fstatSync(descriptor).isDirectory()) {
        syncFailed = true
        throw Object.assign(new Error('fixture-conversion directory sync'), { code: 'EIO' })
      }
      return sync(descriptor)
    })
    vi.spyOn(fsSync, 'unlinkSync').mockImplementation(file => {
      if (locked && String(file) === h.encryptedPath)
        throw Object.assign(new Error('fixture-rejected encrypted cleanup'), { code: 'EIO' })
      return unlink(file)
    })

    const error = await h.service.switchTeam('fixture-team').then(
      () => null,
      error => error
    )

    expect(conversionLanded && syncFailed).toBe(true)
    expect(priorEncryptedPublicationRejected).toBe(true)
    expect(await h.tokenStore.getSafeStorageSessionToken(h.envKey)).toBe(teamToken)
    expect(h.markers.readPendingExternalLogoutMarker(boundary.directory, h.envKey)?.intent).toEqual(
      { intent: 'keytar-cleanup-pending', credentialSource: 'safe-storage' }
    )
    expect(
      h.journal.isSessionPersistenceCandidateDenied(
        h.journal.readSessionPersistenceJournal(boundary.directory, h.envKey),
        teamToken
      )
    ).toBe(true)
    expect(
      h.journal
        .readSessionPersistenceJournal(boundary.directory, h.envKey)
        ?.pending.find(
          entry => entry.candidateHash === h.journal.sessionPersistenceCandidateHash(teamToken)
        )?.sources
    ).toEqual(['keytar', 'safe-storage'])
    locked = false
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(teamToken)
    expect(h.state.authClient.getMe).not.toHaveBeenCalledWith(teamToken)
    expect(error).toBeInstanceOf(Error)
  })

  it('keeps accepted login live after retirement failure and denies restart until fresh recovery', async () => {
    const h = await harness()
    const unlink = fsSync.unlinkSync.bind(fsSync)
    let faultReached = false
    const fault = vi.spyOn(fsSync, 'unlinkSync').mockImplementation(file => {
      if (!faultReached && String(file) === h.journalPath) {
        faultReached = true
        throw Object.assign(new Error('fixture-accepted journal retirement'), { code: 'EIO' })
      }
      return unlink(file)
    })

    await expect(
      h.state.installAuthenticatedLogin({ token: freshToken, me: freshMe })
    ).resolves.toEqual({ authenticated: true, me: freshMe })

    fault.mockRestore()
    expect(faultReached).toBe(true)
    expect(h.service.getCachedUserId()).toBe(freshMe.id)
    expect(await h.tokenStore.getKeytarSessionToken(h.envKey)).toBe(freshToken)
    expect(h.reportFailure).toHaveBeenCalled()
    expect(
      h.journal.isSessionPersistenceCandidateDenied(
        h.journal.readSessionPersistenceJournal(boundary.directory, h.envKey),
        freshToken
      )
    ).toBe(true)
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(freshToken)
    await expect(
      restarted.state.installAuthenticatedLogin({ token: freshToken, me: freshMe })
    ).resolves.toEqual({ authenticated: true, me: freshMe })
    const recovered = await harness()
    await expect(recovered.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: freshMe,
    })
    expect(h.journal.readSessionPersistenceJournal(boundary.directory, h.envKey)).toBeNull()
  })

  it('does not reject accepted team persistence when the SDK notification throws', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    boundary.notifySessionChanged.mockImplementation(authenticated => {
      if (authenticated) throw new Error('fixture-dead SDK surface')
    })

    await expect(h.service.switchTeam('fixture-team')).resolves.toEqual({
      authenticated: true,
      me: userFor(teamToken),
    })

    expect(boundary.notifySessionChanged).toHaveBeenCalledWith(true)
    expect(h.service.getCachedUserId()).toBe(homeMe.id)
    expect(h.state.sessionToken).toBe(teamToken)
    expect(await h.tokenStore.getKeytarSessionToken(h.envKey)).toBe(teamToken)
    expect(h.journal.readSessionPersistenceJournal(boundary.directory, h.envKey)).toBeNull()
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: userFor(teamToken),
    })
  })

  it('never evicts full-journal denials and recovers quota only after verified logout cleanup', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    for (let index = 0; index < 128; index += 1) {
      const pending = new h.journal.SessionPersistenceProducer(
        boundary.directory,
        h.envKey,
        null,
        () => {},
        () => {}
      )
      pending.prepare('keytar', `fixture-unaccepted-quota-${index}`)
    }
    const previousDenials = h.journal.readSessionPersistenceJournal(
      boundary.directory,
      h.envKey
    )!.pending
    boundary.setPassword.mockClear()

    const error = await h.state.installAuthenticatedLogin({ token: freshToken, me: freshMe }).then(
      () => null,
      error => error
    )

    expect(boundary.setPassword).not.toHaveBeenCalled()
    expect(h.journal.readSessionPersistenceJournal(boundary.directory, h.envKey)?.pending).toEqual(
      previousDenials
    )
    expect(h.service.getCachedUserId()).toBe(homeMe.id)
    expect(await h.tokenStore.getKeytarSessionToken(h.envKey)).toBe(homeToken)
    const beforeLogoutRestart = await harness()
    await expect(beforeLogoutRestart.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: homeMe,
    })
    expect(beforeLogoutRestart.state.authClient.getMe).not.toHaveBeenCalledWith(freshToken)
    expect(error).toBeInstanceOf(Error)

    await h.service.logout()

    expect(h.service.getCachedUserId()).toBeNull()
    expect(await h.tokenStore.getKeytarSessionToken(h.envKey)).toBeNull()
    expect(h.journal.readSessionPersistenceJournal(boundary.directory, h.envKey)).toBeNull()
    await expect(
      h.state.installAuthenticatedLogin({ token: freshToken, me: freshMe })
    ).resolves.toEqual({ authenticated: true, me: freshMe })
    const recovered = await harness()
    await expect(recovered.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: freshMe,
    })
    expect(recovered.state.authClient.getMe).not.toHaveBeenCalledWith(homeToken)
  })
})
