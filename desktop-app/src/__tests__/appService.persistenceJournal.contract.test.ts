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
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
    decryptString: (value: Buffer) => value.toString().replace(/^encrypted:/, ''),
  },
}))
vi.mock('../chatStoreBinding.js', async () => {
  const { createChatStoreBindingMock } = await import('../../testSupport/chatStoreBindingMock.js')
  return createChatStoreBindingMock()
})
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
  await config.saveDesktopRuntimeConfig({
    externalRestApiBaseUrl: 'https://auth.journal-fixture.test/api',
    rpcProxyBaseUrl: 'https://rpc.journal-fixture.test',
    appName: 'Journal Fixture',
  })
  const reportFailure = vi.fn()
  const service = new AppService({
    tokenStore,
    getUserDataDirectory: () => boundary.directory,
    reportDeferredLogoutFailure: reportFailure,
  })
  const state = service as unknown as {
    sessionToken: string | null
    me: typeof homeMe | null
    authClient: {
      getMe: (token: string) => Promise<typeof homeMe>
      passwordLogin: (
        email: string,
        password: string
      ) => Promise<{ token: string; me: typeof homeMe }>
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

async function passwordLogin(
  h: Awaited<ReturnType<typeof harness>>,
  token: string,
  me: typeof homeMe
) {
  vi.spyOn(h.state.authClient, 'passwordLogin').mockResolvedValueOnce({ token, me })
  return h.service.passwordLogin(me.email, 'synthetic-password')
}

describe('actual AppService write-ahead acceptance and migration', () => {
  it('requires fresh authentication for a historical plaintext credential', async () => {
    const h = await harness()
    const { TokenStore } = await import('../tokenStore.js')
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    const historicalWriter = new TokenStore({ isolatedUserDataPath: boundary.directory })
    await historicalWriter.setSessionToken(homeToken, h.envKey)
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
    const legacyFile = path.join(boundary.directory, `session-token-${h.envKey}.json`)
    const originalBytes = await fs.readFile(legacyFile)
    boundary.setPassword.mockClear()

    await expect(h.service.initialize()).resolves.toEqual({ authenticated: false, me: null })

    expect(h.state.authClient.getMe).not.toHaveBeenCalled()
    expect(boundary.setPassword).not.toHaveBeenCalled()
    expect(h.service.getCachedUserId()).toBeNull()
    await expect(fs.readFile(legacyFile)).resolves.toEqual(originalBytes)
    expect(h.journal.readSessionPersistenceJournal(boundary.directory, h.envKey)).toBeNull()
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
    await expect(passwordLogin(h, freshToken, freshMe)).resolves.toEqual({
      authenticated: true,
      me: freshMe,
    })
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: freshMe,
    })
    expect(
      h.journal.isSessionPersistenceCandidateDenied(
        h.journal.readSessionPersistenceJournal(boundary.directory, h.envKey),
        homeToken
      )
    ).toBe(true)
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(freshToken)
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(homeToken)
  })

  it('rejects authority admission before native publication without Home loss', async () => {
    const h = await harness()
    await passwordLogin(h, homeToken, homeMe)
    boundary.setPassword.mockClear()
    const rename = vi.spyOn(fs, 'rename')
    const authorityScope = await h.tokenStore.createSessionAuthorityStorageScope()
    const authorityDirectory = h.tokenStore.resolveSessionAuthorityStorageDirectory(authorityScope)
    const authorityPath = path.join(
      authorityDirectory,
      `session-authority-${createHash('sha256').update(h.envKey).digest('hex')}`
    )
    const open = fsSync.openSync.bind(fsSync)
    const sync = fsSync.fsyncSync.bind(fsSync)
    const authorityDescriptors = new Set<number>()
    let faultReached = false
    vi.spyOn(fsSync, 'openSync').mockImplementation((file, flags, mode) => {
      const descriptor = open(file, flags, mode)
      if (String(file).startsWith(`${authorityPath}.`)) authorityDescriptors.add(descriptor)
      return descriptor
    })
    const fault = vi.spyOn(fsSync, 'fsyncSync').mockImplementation(descriptor => {
      if (!faultReached && authorityDescriptors.has(descriptor)) {
        faultReached = true
        throw Object.assign(new Error('fixture authority record sync'), { code: 'EIO' })
      }
      return sync(descriptor)
    })

    const error = await passwordLogin(h, freshToken, freshMe).then(
      () => null,
      caught => caught
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
    const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
    const preserved = await readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(preserved.status).toBe('accepted')
    if (preserved.status !== 'accepted') throw new Error('Expected the accepted Home source')
    expect(preserved.session.token).toBe(homeToken)
    expect(preserved.session.accepted.record.frame.source).toMatchObject({
      format: 'v1',
      kind: 'keytar',
      accountId: homeMe.id,
    })
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: homeMe,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(freshToken)
    expect(error).toBeInstanceOf(Error)
  })

  it('keeps the exact accepted safeStorage source after a candidate directory sync failure', async () => {
    const h = await harness()
    const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
    vi.spyOn(h.state.authClient, 'passwordLogin').mockResolvedValueOnce({
      token: homeToken,
      me: homeMe,
    })
    vi.spyOn(h.tokenStore, 'inspectVersionedKeytarCapability').mockResolvedValueOnce('unavailable')
    await expect(h.service.passwordLogin(homeMe.email, 'fixture-password')).resolves.toMatchObject({
      authenticated: true,
      me: homeMe,
    })

    const prior = await readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(prior.status).toBe('accepted')
    if (prior.status !== 'accepted') throw new Error('Expected accepted safeStorage source')
    expect(prior.session.token).toBe(homeToken)
    expect(prior.session.accepted.record.frame.source).toMatchObject({
      kind: 'safe-storage',
      format: 'v1',
    })

    const rejectedToken = 'fixture-journal-team-after-sync-failure'
    const rejectedMe = { ...homeMe, teamId: 'fixture-team-after-sync-failure' }
    vi.mocked(h.state.authClient.switchTeam).mockResolvedValueOnce({ token: rejectedToken })
    vi.mocked(h.state.authClient.getMe).mockResolvedValueOnce(rejectedMe)

    const sessionDirectory = path.join(await fs.realpath(boundary.directory), 'sessions')
    const rename = fs.rename.bind(fs)
    let candidateRenamed = false
    let publishedCandidatePath: string | null = null
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      const result = await rename(from, to)
      if (String(to).startsWith(`${sessionDirectory}${path.sep}session-v1-`)) {
        candidateRenamed = true
        publishedCandidatePath = String(to)
      }
      return result
    })
    const open = fs.open.bind(fs)
    let directorySyncFailed = false
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args)
      if (candidateRenamed && String(args[0]) === sessionDirectory) {
        candidateRenamed = false
        vi.spyOn(handle, 'sync').mockImplementation(async () => {
          directorySyncFailed = true
          throw Object.assign(new Error('fixture candidate directory sync failed'), {
            code: 'EIO',
          })
        })
      }
      return handle
    })

    const error = await h.service.switchTeam('fixture-team-after-sync-failure').then(
      () => null,
      caught => caught
    )

    expect(directorySyncFailed).toBe(true)
    expect(error).toBeInstanceOf(Error)
    expect(h.service.getCachedUserId()).toBe(homeMe.id)
    expect(h.state.sessionToken).toBe(homeToken)
    expect(h.state.me).toEqual(homeMe)
    expect(h.state.authClient.getMe).not.toHaveBeenCalledWith(rejectedToken)
    expect(publishedCandidatePath).not.toBeNull()
    if (!publishedCandidatePath)
      throw new Error('Expected a published candidate before sync failed')
    await expect(fs.access(publishedCandidatePath)).rejects.toThrow()
    const after = await readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(after.status).toBe('accepted')
    if (after.status !== 'accepted') throw new Error('Rejected candidate displaced accepted source')
    expect(after.session.token).toBe(homeToken)
    expect(after.session.accepted.record.frame.source).toEqual(
      prior.session.accepted.record.frame.source
    )

    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toMatchObject({
      authenticated: true,
      me: homeMe,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(homeToken)
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(rejectedToken)
  })

  it('retains the exact legacy denial snapshot through accepted login and restart', async () => {
    const h = await harness()
    const deniedToken = 'fixture-unresolved-legacy-denial'
    const producer = new h.journal.SessionPersistenceProducer(
      boundary.directory,
      h.envKey,
      null,
      () => {},
      () => {}
    )
    producer.prepare('keytar', deniedToken)
    const journalBytes = await fs.readFile(h.journalPath)

    await expect(passwordLogin(h, freshToken, freshMe)).resolves.toEqual({
      authenticated: true,
      me: freshMe,
    })

    expect(h.service.getCachedUserId()).toBe(freshMe.id)
    const selected = await (
      await import('../sessionAuthorityAcceptance.js')
    ).readSessionAuthoritySourceSelection({ tokenStore: h.tokenStore, envKey: h.envKey })
    expect(selected.status).toBe('accepted')
    if (selected.status !== 'accepted') throw new Error('Expected accepted V1 source')
    expect(selected.session.token).toBe(freshToken)
    expect(
      h.journal.isSessionPersistenceCandidateDenied(
        h.journal.readSessionPersistenceJournal(boundary.directory, h.envKey),
        deniedToken
      )
    ).toBe(true)
    await expect(fs.readFile(h.journalPath)).resolves.toEqual(journalBytes)
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: freshMe,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(freshToken)
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(deniedToken)
  })

  it('does not reject accepted team persistence when the SDK notification throws', async () => {
    const h = await harness()
    await passwordLogin(h, homeToken, homeMe)
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
    const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
    const selected = await readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(selected.status).toBe('accepted')
    if (selected.status !== 'accepted') throw new Error('Expected accepted candidate authority')
    expect(selected.session.token).toBe(teamToken)
    expect(selected.session.accepted.record.frame.source).toMatchObject({
      kind: 'keytar',
      format: 'v1',
    })
    expect(h.journal.readSessionPersistenceJournal(boundary.directory, h.envKey)).toBeNull()
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: userFor(teamToken),
    })
  })

  it('preserves a full legacy denial journal while public V1 login uses its authority record', async () => {
    const h = await harness()
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
    await passwordLogin(h, homeToken, homeMe)
    const firstAccepted = await (
      await import('../sessionAuthorityAcceptance.js')
    ).readSessionAuthoritySourceSelection({ tokenStore: h.tokenStore, envKey: h.envKey })
    expect(firstAccepted.status).toBe('accepted')
    if (firstAccepted.status !== 'accepted') throw new Error('Expected first V1 acceptance')
    const legacySnapshot = h.journal.observeSessionPersistenceLegacySnapshot(
      boundary.directory,
      h.envKey
    )
    expect(legacySnapshot.status).toBe('observed')
    if (legacySnapshot.status !== 'observed') throw new Error('Expected valid legacy snapshot')
    expect(firstAccepted.session.accepted.record.projectionReceipt?.legacyJournalReceipt).toEqual(
      legacySnapshot.receipt
    )
    const previousDenials = h.journal.readSessionPersistenceJournal(
      boundary.directory,
      h.envKey
    )!.pending
    boundary.setPassword.mockClear()

    await expect(passwordLogin(h, freshToken, freshMe)).resolves.toEqual({
      authenticated: true,
      me: freshMe,
    })

    expect(boundary.setPassword).toHaveBeenCalledTimes(1)
    expect(boundary.setPassword.mock.calls[0]?.[1]).toMatch(/^session-v1:/)
    expect(h.journal.readSessionPersistenceJournal(boundary.directory, h.envKey)?.pending).toEqual(
      previousDenials
    )
    expect(h.service.getCachedUserId()).toBe(freshMe.id)
    const selected = await (
      await import('../sessionAuthorityAcceptance.js')
    ).readSessionAuthoritySourceSelection({ tokenStore: h.tokenStore, envKey: h.envKey })
    expect(selected.status).toBe('accepted')
    if (selected.status !== 'accepted') throw new Error('Expected the new V1 source to be accepted')
    expect(selected.session.token).toBe(freshToken)
    expect(selected.session.accepted.record.frame.source).toMatchObject({
      format: 'v1',
      kind: 'keytar',
      accountId: freshMe.id,
    })
    const beforeLogoutRestart = await harness()
    await expect(beforeLogoutRestart.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: freshMe,
    })
    expect(beforeLogoutRestart.state.authClient.getMe).toHaveBeenCalledWith(freshToken)
    expect(beforeLogoutRestart.state.authClient.getMe).not.toHaveBeenCalledWith(homeToken)

    await expect(beforeLogoutRestart.service.logout()).resolves.toMatchObject({
      kind: 'committed',
    })

    expect(beforeLogoutRestart.service.getCachedUserId()).toBeNull()
    expect(await beforeLogoutRestart.tokenStore.getKeytarSessionToken(h.envKey)).toBeNull()
    expect(h.journal.readSessionPersistenceJournal(boundary.directory, h.envKey)?.pending).toEqual(
      previousDenials
    )
    await expect(passwordLogin(beforeLogoutRestart, freshToken, freshMe)).resolves.toEqual({
      authenticated: true,
      me: freshMe,
    })
    expect(h.journal.readSessionPersistenceJournal(boundary.directory, h.envKey)?.pending).toEqual(
      previousDenials
    )
    expect(beforeLogoutRestart.service.getCachedUserId()).toBe(freshMe.id)
    const recovered = await harness()
    await expect(recovered.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: freshMe,
    })
    expect(recovered.state.authClient.getMe).not.toHaveBeenCalledWith(homeToken)
  })
})
