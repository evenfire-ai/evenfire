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

const homeToken = validSessionToken('fixture-r21-home-session')
const teamToken = validSessionToken('fixture-r21-team-session')
const homeMe = {
  id: 'fixture-r21-user',
  email: 'fixture-r21@example.com',
  name: null,
  picture: null,
  teamId: 'fixture-home',
  teamName: 'Fixture home',
  role: 'member',
}

function validSessionToken(subject = 'fixture-session'): string {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, sub: subject })
  ).toString('base64url')
  return `header.${payload}.signature`
}

function tokenFromKeytarValue(value: string): string {
  try {
    const envelope = JSON.parse(value) as { sessionToken?: unknown }
    return typeof envelope.sessionToken === 'string' ? envelope.sessionToken : value
  } catch {
    return value
  }
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
  await config.saveDesktopRuntimeConfig({
    externalRestApiBaseUrl: 'http://127.0.0.1:8091',
    rpcProxyBaseUrl: 'http://127.0.0.1:8094',
    appName: 'Evenfire',
  })
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
      passwordLogin: (
        email: string,
        password: string
      ) => Promise<{ token: string; me: typeof homeMe }>
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

async function newProcessHarness() {
  vi.resetModules()
  vi.doMock('keytar', () => boundary)
  return harness()
}

async function readAcceptedSession(tokenStore: unknown, envKey: string) {
  const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
  const selection = await readSessionAuthoritySourceSelection({
    tokenStore: tokenStore as InstanceType<typeof import('../tokenStore.js').TokenStore>,
    envKey,
  })
  if (selection.status !== 'accepted') throw new Error('Expected an accepted source receipt')
  return selection.session
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

async function enteredWithin(promise: Promise<void>, label: string, producer?: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const outcome = await Promise.race([
      promise.then(() => 'entered'),
      ...(producer
        ? [
            producer.then(
              () => 'producer completed before barrier',
              error =>
                `producer rejected before barrier: ${error instanceof Error ? error.message : String(error)}`
            ),
          ]
        : []),
      new Promise<string>(resolve => {
        timer = setTimeout(() => resolve('deadline expired'), 2000)
      }),
    ])
    expect(outcome, `producer reached ${label}`).toBe('entered')
  } finally {
    clearTimeout(timer)
  }
}

describe('R21-M1 partial publication with unavailable repair', () => {
  it('never restores a rejected native candidate while both repair and marker inspection are unavailable', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
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
    await h.service.initialize()
    expect(rejectedReads).toBeGreaterThanOrEqual(3)
    vi.restoreAllMocks()
    boundary.getPassword.mockImplementation(
      async (service, account) => runtime.keychain.get(keyOf(service, account)) ?? null
    )
    const restarted = await newProcessHarness()
    const result = await restarted.service.initialize()
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(teamToken)
    expect(result).toEqual({ authenticated: true, me: homeMe })
    expect(h.state.sessionToken).toBe(homeToken)
    expect(error).toBeInstanceOf(Error)
  })
})

describe('R21-M2 newer independent source authority during logout cleanup', () => {
  it('preserves journal entries appended after the verified logout cleanup snapshot', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    const accepted = await readAcceptedSession(h.tokenStore, h.envKey)
    const acceptedSource = accepted.accepted.record.frame.source
    expect(acceptedSource?.kind).toBe('keytar')
    if (acceptedSource?.kind !== 'keytar') throw new Error('Expected a Keytar source receipt')
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
      if (account === `session-v1:${acceptedSource.sourceRef}`) {
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

  it('preserves a newer accepted login after older exact-source logout cleanup fails', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    const accepted = await readAcceptedSession(h.tokenStore, h.envKey)
    const acceptedSource = accepted.accepted.record.frame.source
    expect(acceptedSource?.kind).toBe('keytar')
    if (acceptedSource?.kind !== 'keytar') throw new Error('Expected a Keytar source receipt')
    const entered = deferred()
    const release = deferred()
    const cleanupFinished = deferred()
    vi.spyOn(h.tokenStore, 'deleteSessionCredentialSourceIfUnselectedWithProof').mockImplementation(
      async (...args) => {
        expect(args[0]).toEqual(acceptedSource)
        entered.resolve()
        await release.promise
        cleanupFinished.resolve()
        throw new Error('fixture-older exact-source cleanup failed')
      }
    )
    const logout = h.service.logout()
    const freshToken = validSessionToken('fixture-independent-new-user-session')
    const freshMe = { ...homeMe, id: 'fixture-independent-new-user' }
    vi.spyOn(h.state.authClient, 'passwordLogin').mockResolvedValue({
      token: freshToken,
      me: freshMe,
    })
    vi.mocked(h.state.authClient.getMe).mockImplementation(async token =>
      token === freshToken ? freshMe : homeMe
    )
    try {
      await enteredWithin(entered.promise, 'older exact-source cleanup')
      await expect(logout).resolves.toMatchObject({ kind: 'committed' })
    } finally {
      release.resolve()
      await Promise.allSettled([logout])
      await cleanupFinished.promise
      vi.mocked(h.tokenStore.deleteSessionCredentialSourceIfUnselectedWithProof).mockRestore()
    }
    expect(await h.service.passwordLogin('fresh@example.test', 'fixture-password')).toEqual({
      authenticated: true,
      me: freshMe,
    })
    const selected = await readAcceptedSession(h.tokenStore, h.envKey)
    expect(selected.token).toBe(freshToken)
    expect(selected.accepted.record.frame.source).not.toEqual(acceptedSource)
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
    expect((await readAcceptedSession(restarted.tokenStore, h.envKey)).token).toBe(freshToken)
  })
})

describe('independent no-dispatch transient probe', () => {
  it('preserves a locked previous source when marker inspection rejects before any candidate write', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
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
    const selected = await readAcceptedSession(h.tokenStore, h.envKey)
    expect(selected.token).toBe(homeToken)
    expect(selected.accepted.record.frame.source?.kind).toBe('keytar')
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
    await h.service.switchTeam('fixture-other')
    await h.service.switchTeam('fixture-home')
    const paused = deferred()
    const release = deferred()
    const writeCandidate = h.tokenStore.writeSessionTokenCandidate.bind(h.tokenStore)
    boundary.setPassword.mockRejectedValueOnce(new Error('fixture-known-unpublished native outage'))
    vi.spyOn(h.tokenStore, 'writeSessionTokenCandidate').mockImplementationOnce(async input => {
      const outcome = await writeCandidate(input).then(
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
    const markerBefore = await fs.readFile(h.markerPath, 'utf8')
    boundary.setPassword.mockClear()
    const open = fsSync.openSync.bind(fsSync)
    let injected = false
    const spy = vi.spyOn(fsSync, 'openSync').mockImplementation((file, flags, mode) => {
      if (String(file) === h.markerPath && !injected) {
        injected = true
        throw Object.assign(new Error('fixture-login before-dispatch EMFILE'), { code: 'EMFILE' })
      }
      return open(file, flags, mode)
    })
    const error = await h.state.installAuthenticatedLogin({ token: teamToken, me: homeMe }).then(
      () => null,
      error => error
    )
    spy.mockRestore()
    expect(injected).toBe(true)
    expect(boundary.setPassword).not.toHaveBeenCalled()
    expect(h.state.sessionToken).toBe(homeToken)
    expect(h.state.me).toEqual(homeMe)
    expectHomeDispatchScope(h.service)
    expect(await fs.readFile(h.markerPath, 'utf8')).toBe(markerBefore)
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
    const corrupt = '{fixture-confirmed-marker-corruption'
    await fs.writeFile(h.markerPath, corrupt)
    const candidateWrite = vi.spyOn(h.tokenStore, 'writeSessionTokenCandidate')
    const error = await h.state.installAuthenticatedLogin({ token: teamToken, me: homeMe }).then(
      () => null,
      error => error
    )
    expect(boundary.setPassword).not.toHaveBeenCalled()
    expect(candidateWrite).not.toHaveBeenCalled()
    expect(h.state.sessionToken).toBeNull()
    expect(h.state.me).toBeNull()
    expect(await fs.readFile(h.markerPath, 'utf8')).toBe(corrupt)
    expect(
      [...runtime.keychain.values()].some(value => tokenFromKeytarValue(value) === homeToken)
    ).toBe(true)
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalled()
    expect(error).toBeInstanceOf(Error)
  })

  it('fails closed when a team producer observes a broken accepted projection', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    const priorCredentialEntries = [...runtime.keychain.entries()]
    const corrupt = '{fixture-team-projection-corruption'
    await fs.writeFile(h.markerPath, corrupt)

    const error = await h.service.switchTeam('fixture-other').then(
      () => null,
      failure => failure
    )

    expect(error).toBeInstanceOf(Error)
    expect(h.state.authClient.switchTeam).not.toHaveBeenCalled()
    expect(h.service.getCachedUserId()).toBeNull()
    expect(h.state.sessionToken).toBeNull()
    expect(h.state.me).toBeNull()
    expect(await fs.readFile(h.markerPath, 'utf8')).toBe(corrupt)
    expect([...runtime.keychain.entries()]).toEqual(priorCredentialEntries)

    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalled()
  })

  it('preserves an accepted session when projection reconciliation gets a transient marker read', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
    const before = await readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(before).toMatchObject({ status: 'accepted', session: { token: homeToken } })
    const markerBefore = await fs.readFile(h.markerPath, 'utf8')

    const open = fsSync.openSync.bind(fsSync)
    let injected = false
    const spy = vi.spyOn(fsSync, 'openSync').mockImplementation((file, flags, mode) => {
      if (String(file) === h.markerPath && !injected) {
        injected = true
        throw Object.assign(new Error('fixture-projection-marker EMFILE'), { code: 'EMFILE' })
      }
      return open(file, flags, mode)
    })
    boundary.notifySessionChanged.mockClear()
    const error = await h.service.switchTeam('fixture-other').then(
      () => null,
      failure => failure
    )
    spy.mockRestore()

    expect(injected).toBe(true)
    expect(error).toBeInstanceOf(Error)
    expect(h.state.authClient.switchTeam).not.toHaveBeenCalled()
    expect(h.state.sessionToken).toBe(homeToken)
    expect(h.state.me).toEqual(homeMe)
    expect(boundary.notifySessionChanged).not.toHaveBeenCalledWith(false)
    expect(await fs.readFile(h.markerPath, 'utf8')).toBe(markerBefore)
    const after = await readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(after).toMatchObject({ status: 'accepted', session: { token: homeToken } })

    const restarted = await newProcessHarness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: homeMe,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(homeToken)
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(teamToken)
  })

  it('recovers LP staged before an uncertain authority logout CAS without restoring the source', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    const accepted = await readAcceptedSession(h.tokenStore, h.envKey)
    const source = accepted.accepted.record.frame.source
    if (!source || source.format !== 'v1') throw new Error('Expected exact V1 accepted source')
    const deletion = vi
      .spyOn(h.tokenStore, 'deleteSessionCredentialSourceIfUnselectedWithProof')
      .mockRejectedValue(new Error('fixture exact-source cleanup remains pending'))
    const { SessionAuthorityRecordRepository } = await import('../sessionAuthorityRecord.js')
    const commit = vi
      .spyOn(SessionAuthorityRecordRepository.prototype, 'commitLogout')
      .mockImplementationOnce(() => {
        throw new Error('fixture authority logout publication uncertainty')
      })

    const logoutResult = await h.service.logout().then(
      value => ({ value, error: null }),
      error => ({ value: null, error })
    )
    commit.mockRestore()
    expect(logoutResult.value).toMatchObject({ kind: 'committed' })
    expect(logoutResult.error).toBeNull()
    expect(h.state.sessionToken).toBeNull()
    expect(h.state.me).toBeNull()
    expect(h.markers.readPendingExternalLogoutIntent(runtime.directory, h.envKey)).toEqual({
      intent: 'logout-pending',
    })
    const pending = h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)
    expect(pending?.revision).toMatch(/^[0-9a-f-]{36}$/i)
    const authorityBeforeCleanup = new SessionAuthorityRecordRepository(
      await h.tokenStore.createSessionAuthorityStorageScope(),
      h.envKey,
      h.tokenStore
    ).observe()
    expect(authorityBeforeCleanup.status).toBe('observed')
    if (authorityBeforeCleanup.status !== 'observed')
      throw new Error('Expected reconciled logout authority before cleanup')
    expect(authorityBeforeCleanup.record.frame.mode).toBe('logged-out')
    expect(authorityBeforeCleanup.record.cleanupDebts.map(debt => debt.source)).toContainEqual(
      source
    )
    await vi.waitFor(() =>
      expect(deletion).toHaveBeenCalledWith(source, expect.anything(), expect.anything())
    )

    const authority = new SessionAuthorityRecordRepository(
      await h.tokenStore.createSessionAuthorityStorageScope(),
      h.envKey,
      h.tokenStore
    ).observe()
    expect(authority.status).toBe('observed')
    if (authority.status !== 'observed') throw new Error('Expected reconciled logout authority')
    expect(authority.record.frame.mode).toBe('logged-out')
    expect(authority.record.cleanupDebts.map(debt => debt.source)).toContainEqual(source)

    const restarted = await newProcessHarness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(homeToken)
    const selection = await import('../sessionAuthorityAcceptance.js').then(module =>
      module.readSessionAuthoritySourceSelection({
        tokenStore: restarted.tokenStore,
        envKey: restarted.envKey,
      })
    )
    expect(selection).toEqual({ status: 'denied', frameMode: 'logged-out' })
  })

  it.each(['active-keytar', 'safe-storage', 'absent'] as const)(
    'repairs rejected login publication without changing %s marker bytes after transient inspection',
    async source => {
      const h = await harness()
      await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
      if (source === 'safe-storage') vi.doMock('keytar', () => boundary)
      const original = h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)
      const fresh = validSessionToken('fixture-rejected-login-after-transient-read')
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
      if (source === 'safe-storage') {
        vi.spyOn(h.tokenStore, 'inspectVersionedKeytarCapability').mockResolvedValue('unavailable')
      }
      await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
      const priorAccepted = await readAcceptedSession(h.tokenStore, h.envKey)
      expect(priorAccepted.accepted.record.frame.source?.kind).toBe(
        source === 'safe-storage' ? 'safe-storage' : 'keytar'
      )
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
        boundary.setPassword.mockImplementation(async (service, account, token) => {
          runtime.keychain.set(keyOf(service, account), token)
          if (tokenFromKeytarValue(token) === teamToken) candidateWritten = true
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
      const restarted = await newProcessHarness()
      const { readSessionAuthoritySourceSelection } =
        await import('../sessionAuthorityAcceptance.js')
      await expect(
        readSessionAuthoritySourceSelection({
          tokenStore: restarted.tokenStore,
          envKey: restarted.envKey,
        })
      ).resolves.toMatchObject({ status: 'accepted', session: { token: homeToken } })
      await expect(restarted.service.initialize()).resolves.toEqual({
        authenticated: true,
        me: homeMe,
      })
      expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(teamToken)
      expect(error).toBeInstanceOf(Error)
    }
  )

  it('retains the accepted receipt and marker after transient candidate ownership inspection', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    const markerBefore = await fs.readFile(h.markerPath, 'utf8')
    let candidateWritten = false
    boundary.setPassword.mockImplementation(async (service, account, token) => {
      const sessionToken = tokenFromKeytarValue(token)
      runtime.keychain.set(keyOf(service, account), token)
      if (sessionToken === teamToken) candidateWritten = true
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
    expect(await fs.readFile(h.markerPath, 'utf8')).toBe(markerBefore)
    expect(h.state.sessionToken).toBe(homeToken)
    expect(h.state.me).toEqual(homeMe)
    const restarted = await newProcessHarness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: homeMe,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(teamToken)
    expect(h.state.sessionToken).toBe(homeToken)
    expect(error).toBeInstanceOf(Error)
  })

  it.each(['switch', 'hop'] as const)(
    'preserves the verified source after third/fourth-read EMFILE during %s',
    async operation => {
      const h = await harness()
      await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
      const original = await fs.readFile(h.markerPath, 'utf8')
      let candidateWritten = false
      boundary.setPassword.mockImplementation(async (service, account, token) => {
        runtime.keychain.set(keyOf(service, account), token)
        if (tokenFromKeytarValue(token) === teamToken) candidateWritten = true
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
      const selected = await readAcceptedSession(h.tokenStore, h.envKey)
      expect(selected.token).toBe(homeToken)
      expect(selected.accepted.record.frame.source?.kind).toBe('keytar')
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
    const original = await fs.readFile(h.markerPath, 'utf8')
    let candidateWritten = false
    boundary.setPassword.mockImplementation(async (service, account, token) => {
      runtime.keychain.set(keyOf(service, account), token)
      if (tokenFromKeytarValue(token) === teamToken) candidateWritten = true
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
    const priorAuthority = await readAcceptedSession(h.tokenStore, h.envKey)
    expect(priorAuthority.token).toBe(homeToken)
    expect(await fs.readFile(h.markerPath, 'utf8')).toBe(original)
    const restarted = await newProcessHarness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: homeMe,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(teamToken)
    expect(h.state.sessionToken).toBe(homeToken)
    expect(priorAuthority.token).toBe(homeToken)
    expect(error).toBeInstanceOf(Error)
    // The exact receipt-bound accepted marker remains the witness until recovery resolves it.
    expect(original).toContain('acceptance-pending')
  })

  it('does not report a false external logout for transient canceled-quit inspection', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
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
    expect((await readAcceptedSession(h.tokenStore, h.envKey)).token).toBe(homeToken)
    expect(h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)).toEqual(observed)
    expect(boundary.notifySessionChanged).not.toHaveBeenCalledWith(false)
  })
})

describe('R21-M2 stale native producer fencing', () => {
  it('uses qualified V1 safeStorage while Keytar is unavailable, then accepts V1 Keytar', async () => {
    const h = await harness()
    const fresh = validSessionToken('fixture-selected-encrypted-user')
    const freshMe = { ...homeMe, id: 'fixture-selected-user' }
    const rejected = validSessionToken('fixture-unobserved-keytar-candidate')
    boundary.getPassword.mockRejectedValue(
      Object.assign(new Error('fixture-native read temporarily unavailable'), { code: 'EACCES' })
    )
    const passwordLogin = vi
      .spyOn(h.state.authClient, 'passwordLogin')
      .mockResolvedValueOnce({ token: rejected, me: freshMe })
      .mockResolvedValueOnce({ token: fresh, me: freshMe })
    vi.mocked(h.state.authClient.getMe).mockImplementation(async token =>
      token === fresh || token === rejected ? freshMe : homeMe
    )
    await expect(
      h.service.passwordLogin('fresh@example.test', 'fixture-password')
    ).resolves.toEqual({ authenticated: true, me: freshMe })
    expect(passwordLogin).toHaveBeenCalledTimes(1)
    expect(h.state.sessionToken).toBe(rejected)
    expect(h.service.getCachedUserId()).toBe(freshMe.id)
    expect(boundary.setPassword).not.toHaveBeenCalled()
    const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
    const firstAcceptedCandidate = await readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(firstAcceptedCandidate.status).toBe('accepted')
    if (firstAcceptedCandidate.status !== 'accepted')
      throw new Error('Expected selected safeStorage source')
    expect(firstAcceptedCandidate.session.accepted.record.frame.source).toMatchObject({
      format: 'v1',
      kind: 'safe-storage',
    })
    expect(firstAcceptedCandidate.session.token).toBe(rejected)

    // Once Keytar becomes available, fresh authentication may select its exact V1 account.
    boundary.getPassword.mockImplementation(
      async (service, account) => runtime.keychain.get(keyOf(service, account)) ?? null
    )
    boundary.setPassword.mockClear()
    await expect(
      h.service.passwordLogin('fresh@example.test', 'fixture-password')
    ).resolves.toEqual({ authenticated: true, me: freshMe })
    const selected = await readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(selected.status).toBe('accepted')
    if (selected.status !== 'accepted') throw new Error('Expected selected Keytar source')
    expect(selected.session.accepted.record.frame.source?.kind).toBe('keytar')
    expect(selected.session.token).toBe(fresh)
    expect(boundary.setPassword).toHaveBeenCalledTimes(1)
    boundary.setPassword.mockClear()
    const initial = await harness()
    vi.mocked(initial.state.authClient.getMe).mockImplementation(async token =>
      token === fresh ? freshMe : homeMe
    )
    await expect(initial.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: freshMe,
    })
    expect(boundary.setPassword).not.toHaveBeenCalled()
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
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(fresh)
    const recovered = await readSessionAuthoritySourceSelection({
      tokenStore: restarted.tokenStore,
      envKey: restarted.envKey,
    })
    expect(recovered.status).toBe('accepted')
    if (recovered.status !== 'accepted') throw new Error('Expected recovered Keytar source')
    expect(recovered.session.accepted.record.frame.source?.kind).toBe('keytar')
    expect(recovered.session.token).toBe(fresh)
    expect(boundary.setPassword).not.toHaveBeenCalled()
  })

  it('does not select an unframed legacy encrypted source after transient Keytar read failure', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    const fresh = 'fixture-unframed-legacy-encrypted-user'
    const { safeStorage } = await import('electron')
    await h.tokenStore.setSafeStorageSessionToken(fresh, h.envKey)
    const scopedEncryptedPath = path.join(runtime.directory, `session-token-${h.envKey}.enc`)
    const legacyEncryptedPath = path.join(runtime.directory, 'session-token.enc')
    await fs.rename(scopedEncryptedPath, legacyEncryptedPath)
    const legacyBytes = await fs.readFile(legacyEncryptedPath)
    boundary.setPassword.mockClear()
    boundary.getPassword.mockRejectedValue(new Error('fixture-Keytar EMFILE'))
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(fresh)
    expect(boundary.setPassword).not.toHaveBeenCalled()
    expect(await fs.readFile(legacyEncryptedPath)).toEqual(legacyBytes)
    expect(safeStorage.decryptString(legacyBytes)).toBe(fresh)
  })

  it('does not restore a lower-precedence safeStorage credential after transient Keytar failure', async () => {
    const h = await harness()
    const staleFallback = 'fixture-stale-safe-storage-session'
    await h.tokenStore.setSafeStorageSessionToken(staleFallback, h.envKey)
    boundary.getPassword.mockRejectedValueOnce(
      Object.assign(new Error('fixture-Keytar EMFILE'), {
        code: 'EMFILE',
      })
    )

    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })

    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(staleFallback)
    expect(await restarted.tokenStore.getSafeStorageSessionToken(h.envKey)).toBe(staleFallback)
  })

  it.each(['login', 'team'] as const)(
    'applies the approved memory-only policy when a %s write has no secure provider',
    async producer => {
      const h = await harness()
      await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
      if (producer === 'team') {
        // Establish a durable, source-bound Home authority through the public team
        // producer before simulating a provider outage. A private in-memory install
        // alone is not restart authority and cannot support the assertion below.
        await h.service.switchTeam('fixture-other')
        await h.service.switchTeam('fixture-home')
        const { readSessionAuthoritySourceSelection } =
          await import('../sessionAuthorityAcceptance.js')
        const selected = await readSessionAuthoritySourceSelection({
          tokenStore: h.tokenStore,
          envKey: h.envKey,
        })
        expect(selected.status).toBe('accepted')
        if (selected.status === 'accepted') expect(selected.session.token).toBe(homeToken)
      }
      const { readSessionAuthoritySourceSelection } =
        await import('../sessionAuthorityAcceptance.js')
      const priorAuthority = await readSessionAuthoritySourceSelection({
        tokenStore: h.tokenStore,
        envKey: h.envKey,
      })
      expect(priorAuthority.status).toBe('accepted')
      if (priorAuthority.status !== 'accepted')
        throw new Error('Expected the exact accepted Home source before provider failure')
      expect(priorAuthority.session.token).toBe(homeToken)
      const priorSource = priorAuthority.session.accepted.record.frame.source
      const { safeStorage } = await import('electron')
      vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
      boundary.getPassword.mockRejectedValue(
        Object.assign(new Error('fixture keyring access denied'), { code: 'EACCES' })
      )
      const priorMarker = h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)
      boundary.setPassword.mockClear()
      const attempted =
        producer === 'login'
          ? h.state.installAuthenticatedLogin({
              token: teamToken,
              me: { ...homeMe, teamId: 'fixture-other' },
            })
          : h.service.switchTeam('fixture-other')
      const outcome = await attempted.then(
        result => ({ result, error: null }),
        error => ({ result: null, error })
      )
      expect(boundary.setPassword).not.toHaveBeenCalled()
      if (producer === 'team') {
        // Keytar is intentionally unreadable at this point. Verify the durable selected
        // descriptor and exact slot bytes without treating EACCES as absence or attempting
        // to authenticate from the native source.
        const storageScope = await h.tokenStore.createSessionAuthorityStorageScope()
        const { SessionAuthorityRecordRepository } = await import('../sessionAuthorityRecord.js')
        const repository = new SessionAuthorityRecordRepository(
          storageScope,
          h.envKey,
          h.tokenStore
        )
        const observed = repository.observe()
        expect(observed.status).toBe('observed')
        if (observed.status !== 'observed')
          throw new Error('Expected the prior authority to remain readable')
        expect(observed.record.frame.source).toEqual(priorSource)
        const exactSlot = runtime.keychain.get(
          keyOf('Evenfire', `session-v1:${priorSource.sourceRef}`)
        )
        expect(exactSlot).toContain(homeToken)
      }
      const marker = h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)
      expect(await fs.readdir(runtime.directory)).not.toContain(`session-token-${h.envKey}.json`)
      if (producer === 'login') {
        expect(outcome.error).toBeNull()
        expect(outcome.result).toMatchObject({ authenticated: true, sessionMode: 'temporary' })
        expect(h.state.sessionToken).toBe(teamToken)
        expect(h.state.me).toEqual({ ...homeMe, teamId: 'fixture-other' })
        expect(marker?.intent.intent).toBe('acceptance-pending')
        await expect(
          readSessionAuthoritySourceSelection({ tokenStore: h.tokenStore, envKey: h.envKey })
        ).resolves.toMatchObject({ status: 'denied', frameMode: 'memory-only' })
        const scope = await h.tokenStore.createSessionAuthorityStorageScope()
        const { SessionAuthorityRecordRepository } = await import('../sessionAuthorityRecord.js')
        const repository = new SessionAuthorityRecordRepository(scope, h.envKey, h.tokenStore)
        const acceptedMemoryFrame = repository.observe()
        expect(acceptedMemoryFrame.status).toBe('observed')
        if (acceptedMemoryFrame.status !== 'observed')
          throw new Error('Expected the durable memory-only acceptance frame')
        expect(acceptedMemoryFrame.record.frame).toMatchObject({
          mode: 'memory-only',
          source: null,
          transactionId: expect.any(String),
        })
        if (priorSource) {
          expect(
            acceptedMemoryFrame.record.cleanupDebts.some(
              debt => JSON.stringify(debt.source) === JSON.stringify(priorSource)
            )
          ).toBe(true)
        }
        vi.doMock('keytar', () => boundary)
        expect([...runtime.keychain.values()].some(value => value.includes(homeToken))).toBe(true)
        expect(await h.tokenStore.getSafeStorageSessionToken(h.envKey)).toBeNull()
      } else {
        expect(outcome.error).toBeInstanceOf(Error)
        expect(h.state.sessionToken).toBe(homeToken)
        expect(h.state.me).toEqual(homeMe)
        expect(marker).toEqual(priorMarker)
      }
      vi.doMock('keytar', () => boundary)
      boundary.getPassword.mockImplementation(
        async (service, account) => runtime.keychain.get(keyOf(service, account)) ?? null
      )
      const restarted = await newProcessHarness()
      if (producer === 'team') {
        const restartedAuthority = await import('../sessionAuthorityAcceptance.js')
        await expect(
          restartedAuthority.readSessionAuthoritySourceSelection({
            tokenStore: restarted.tokenStore,
            envKey: restarted.envKey,
          })
        ).resolves.toMatchObject({ status: 'accepted', session: { token: homeToken } })
      }
      await expect(restarted.service.initialize()).resolves.toEqual({
        authenticated: producer === 'team',
        me: producer === 'team' ? homeMe : null,
      })
      expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(teamToken)
      if (producer === 'login')
        expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(homeToken)
      expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(teamToken)
    }
  )

  it('rejects a team transition when its current secure source cannot accept the replacement', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    const markerBefore = await fs.readFile(h.markerPath, 'utf8')
    boundary.setPassword.mockRejectedValueOnce(new Error('fixture-one native setter rejection'))
    await expect(h.service.switchTeam('fixture-other')).rejects.toBeInstanceOf(Error)
    expect(h.state.sessionToken).toBe(homeToken)
    expect(h.state.me).toEqual(homeMe)
    const selected = await readAcceptedSession(h.tokenStore, h.envKey)
    expect(selected.token).toBe(homeToken)
    expect(selected.accepted.record.frame.source?.kind).toBe('keytar')
    expect(await h.tokenStore.getSafeStorageSessionToken(h.envKey)).toBeNull()
    expect(await fs.readFile(h.markerPath, 'utf8')).toBe(markerBefore)
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: homeMe,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(homeToken)
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(teamToken)
  })

  it('fences a rejected native write with memory-only authority after native recovery', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    boundary.setPassword.mockRejectedValueOnce(new Error('fixture-native setter unavailable'))
    boundary.getPassword.mockRejectedValue(new Error('fixture-native getter unavailable'))
    const fresh = validSessionToken('fixture-new-user-encrypted-session')
    const freshMe = { ...homeMe, id: 'fixture-new-user' }
    await expect(h.state.installAuthenticatedLogin({ token: fresh, me: freshMe })).rejects.toThrow(
      'fixture-native getter unavailable'
    )
    expect(h.state.sessionToken).toBe(homeToken)
    expect(h.state.me).toEqual(homeMe)
    const bound = h.markers.readPendingExternalLogoutIntent(runtime.directory, h.envKey)
    expect(bound?.intent).toBe('acceptance-pending')
    expect(await h.tokenStore.getSafeStorageSessionToken(h.envKey)).toBeNull()
    boundary.getPassword.mockImplementation(
      async (service, account) => runtime.keychain.get(keyOf(service, account)) ?? null
    )
    const restarted = await harness()
    vi.mocked(restarted.state.authClient.getMe).mockImplementation(async token =>
      token === fresh ? freshMe : homeMe
    )
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: homeMe,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(homeToken)
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(fresh)
    expect(bound?.intent).toBe('acceptance-pending')
  })

  it('admits first production login in memory without either secure store or plaintext', async () => {
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    const keychainDenied = Object.assign(new Error('fixture keyring access denied'), {
      code: 'EACCES',
    })
    boundary.getPassword.mockRejectedValue(keychainDenied)
    const h = await harness()
    vi.spyOn(h.state.authClient, 'passwordLogin').mockResolvedValueOnce({
      token: homeToken,
      me: homeMe,
    })
    const result = await h.service.passwordLogin(homeMe.email, 'fixture-password')
    expect(result).toMatchObject({ authenticated: true, sessionMode: 'temporary', me: homeMe })
    expect(h.state.sessionToken).toBe(homeToken)
    expect(h.state.me).toEqual(homeMe)
    expect(h.state.authClient.getMe).toHaveBeenCalledWith(homeToken)
    expect(boundary.setPassword).not.toHaveBeenCalled()
    expect(h.markers.readPendingExternalLogoutIntent(runtime.directory, h.envKey)?.intent).toBe(
      'acceptance-pending'
    )
    const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
    await expect(
      readSessionAuthoritySourceSelection({ tokenStore: h.tokenStore, envKey: h.envKey })
    ).resolves.toEqual({ status: 'denied', frameMode: 'memory-only' })
    expect(await fs.readdir(runtime.directory)).not.toContain(`session-token-${h.envKey}.json`)
    // The denied provider cannot be read back, but the empty producer-backed native fixture and
    // absence of any setPassword dispatch prove this temporary login wrote no Keytar credential.
    expect(runtime.keychain.size).toBe(0)
    expect(await h.tokenStore.getSafeStorageSessionToken(h.envKey)).toBeNull()
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalled()
  })

  it('preserves a newer public password login after an older team GFS fence rejects', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    await h.service.switchTeam('fixture-other')
    await h.service.switchTeam('fixture-home')
    const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
    const selectedHome = await readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(selectedHome.status).toBe('accepted')
    if (selectedHome.status !== 'accepted') throw new Error('Expected a V1 prior Home source')
    expect(selectedHome.session.token).toBe(homeToken)
    expect(selectedHome.session.accepted.record.frame.source?.format).toBe('v1')
    const entered = deferred()
    const release = deferred()
    const actor = h.service as unknown as {
      suspendDesktopGfsUploadsForAuthBoundary: () => Promise<void>
      authClient: {
        passwordLogin: (
          email: string,
          password: string
        ) => Promise<{ token: string; me: typeof homeMe }>
      }
    }
    const suspend = actor.suspendDesktopGfsUploadsForAuthBoundary.bind(actor)
    vi.spyOn(actor, 'suspendDesktopGfsUploadsForAuthBoundary')
      .mockImplementationOnce(async () => {
        entered.resolve()
        await release.promise
        throw new Error('fixture-older GFS fence failed')
      })
      .mockImplementation(suspend)
    const switching = h.service.switchTeam('fixture-other').then(
      () => null,
      error => error
    )
    const fresh = 'fixture-newer-public-password-session'
    const freshUser = { ...homeMe, id: 'fixture-newer-public-password-user' }
    const getMe = vi.mocked(h.state.authClient.getMe)
    const getMeImplementation = getMe.getMockImplementation()
    getMe.mockImplementation(async token =>
      token === fresh ? freshUser : await getMeImplementation!(token)
    )
    vi.spyOn(actor.authClient, 'passwordLogin').mockResolvedValue({ token: fresh, me: freshUser })
    const login = h.service.passwordLogin('fresh@example.test', 'fixture-password')
    try {
      await enteredWithin(entered.promise, 'older team GFS boundary', switching)
      await Promise.resolve()
      expect(actor.authClient.passwordLogin).not.toHaveBeenCalled()
    } finally {
      release.resolve()
    }
    const switchError = await switching
    await expect(login).resolves.toMatchObject({ authenticated: true, me: freshUser })
    expect(h.state.sessionToken).toBe(fresh)
    expect(h.state.me).toEqual(freshUser)
    const restarted = await newProcessHarness()
    vi.mocked(restarted.state.authClient.getMe).mockResolvedValue(freshUser)
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: freshUser,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(fresh)
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(teamToken)
    expect(switchError).toBeInstanceOf(Error)
  })

  it('preserves the prior session when a team candidate identity refresh is rejected', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    vi.mocked(h.state.authClient.getMe).mockRejectedValueOnce(
      new Error('fixture-team identity refresh failed')
    )
    await expect(h.service.switchTeam('fixture-other')).rejects.toThrow(
      'fixture-team identity refresh failed'
    )
    expect(h.state.sessionToken).toBe(homeToken)
    expect(h.state.me).toEqual(homeMe)
    const restarted = await newProcessHarness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: homeMe,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(teamToken)
  })

  it('never reads a legacy saved token into the new authentication protocol', async () => {
    const h = await harness()
    await h.tokenStore.setSessionToken(homeToken, h.envKey)
    const legacySourceRead = vi.spyOn(h.tokenStore, 'observeSessionTokenSource')
    await expect(h.service.initialize()).resolves.toEqual({ authenticated: false, me: null })
    expect(legacySourceRead).not.toHaveBeenCalled()
    expect(h.state.authClient.getMe).not.toHaveBeenCalledWith(homeToken)
    expect(h.service.getCachedUserId()).toBeNull()
    expect(await h.tokenStore.getSessionToken(h.envKey)).toBe(homeToken)
  })

  it('keeps confirmed marker corruption dominant over a younger login after GFS fencing', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    const priorCredentialEntries = [...runtime.keychain.entries()]
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
    const fresh = validSessionToken('fixture-younger-user-session')
    const freshMe = { ...homeMe, id: 'fixture-younger-user' }
    let loginOutcome: unknown = null
    try {
      await enteredWithin(entered.promise, 'real older corruption GFS fence')
      loginOutcome = await h.state.installAuthenticatedLogin({ token: fresh, me: freshMe }).then(
        () => null,
        error => error
      )
    } finally {
      release.resolve()
      await settled
    }
    expect(loginOutcome).toBeInstanceOf(Error)
    expect(h.state.sessionToken).toBeNull()
    expect(h.state.me).toBeNull()
    expect([...runtime.keychain.entries()]).toEqual(priorCredentialEntries)
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(fresh)
    expect(await settled).toBeInstanceOf(Error)
  })

  it('orders a held login transaction before the complete queued logout', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    const { prepareChatStoreBindingForUser } = await import('../chatStoreBinding.js')
    const prepareCurrent = vi.mocked(prepareChatStoreBindingForUser).getMockImplementation()
    const entered = deferred()
    const release = deferred()
    vi.mocked(prepareChatStoreBindingForUser).mockImplementationOnce(
      async (userId, envKey, options) => {
        entered.resolve()
        await release.promise
        return prepareCurrent!(userId, envKey, options)
      }
    )
    const login = h.state.installAuthenticatedLogin({
      token: 'fixture-late-login-session',
      me: { ...homeMe, id: 'fixture-new-user' },
    })
    vi.mocked(h.state.authClient.getMe).mockImplementation(async token =>
      token === 'fixture-late-login-session' ? { ...homeMe, id: 'fixture-new-user' } : homeMe
    )
    const settled = login.then(
      () => null,
      error => error
    )
    let logout: Promise<void> | undefined
    try {
      await enteredWithin(entered.promise, 'real staged chat binding')
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
    expect(error).toBeInstanceOf(Error)
  })

  it('keeps logout dominant over a staged V1 team candidate', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    await h.service.switchTeam('fixture-other')
    await h.service.switchTeam('fixture-home')
    const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
    const priorAuthority = await readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(priorAuthority.status).toBe('accepted')
    if (priorAuthority.status !== 'accepted') throw new Error('Fixture did not accept Home source')
    const priorSource = priorAuthority.session.accepted.record.frame.source
    expect(priorSource).not.toBeNull()

    const candidateEntered = deferred()
    const candidateRelease = deferred()
    const cleanupEntered = deferred()
    const cleanupRelease = deferred()
    const cleanupCompleted = deferred()
    const publishCandidate = h.tokenStore.writeSessionTokenCandidate.bind(h.tokenStore)
    vi.spyOn(h.tokenStore, 'writeSessionTokenCandidate').mockImplementation(async input => {
      const receipt = await publishCandidate(input)
      if (input.token === teamToken) {
        candidateEntered.resolve()
        await candidateRelease.promise
      }
      return receipt
    })
    const deleteSource = h.tokenStore.deleteSessionCredentialSourceIfUnselectedWithProof.bind(
      h.tokenStore
    )
    vi.spyOn(h.tokenStore, 'deleteSessionCredentialSourceIfUnselectedWithProof').mockImplementation(
      async (...args) => {
        cleanupEntered.resolve()
        await cleanupRelease.promise
        const result = await deleteSource(...args)
        cleanupCompleted.resolve()
        return result
      }
    )

    vi.mocked(h.state.authClient.getMe).mockImplementation(async token => {
      if (token === teamToken) return { ...homeMe, id: 'fixture-rejected-team-owner' }
      return { ...homeMe }
    })

    const switching = h.service.switchTeam('fixture-other')
    const settledSwitch = switching.then(
      () => null,
      error => error
    )
    let logout: Promise<void> | undefined
    let logoutCompleted = false
    try {
      await enteredWithin(candidateEntered.promise, 'V1 candidate publication')
      logout = h.service.logout().then(() => {
        logoutCompleted = true
      })
      await new Promise(resolve => setImmediate(resolve))
      expect(logoutCompleted).toBe(false)
      candidateRelease.resolve()
      expect(await settledSwitch).toBeInstanceOf(Error)
      await enteredWithin(cleanupEntered.promise, 'durable logout cleanup debt')

      const logoutOutcome = await Promise.race([
        logout.then(
          () => 'completed',
          () => 'rejected'
        ),
        new Promise<string>(resolve => setTimeout(() => resolve('still-pending'), 500)),
      ])
      expect(logoutOutcome).toBe('completed')
      expect(logoutCompleted).toBe(true)
      expect(h.state.sessionToken).toBeNull()
      expect(h.service.getCachedUserId()).toBeNull()

      const storageScope = await h.tokenStore.createSessionAuthorityStorageScope()
      const { SessionAuthorityRecordRepository } = await import('../sessionAuthorityRecord.js')
      const repository = new SessionAuthorityRecordRepository(storageScope, h.envKey, h.tokenStore)
      const observed = repository.observe()
      expect(observed.status).toBe('observed')
      if (observed.status !== 'observed') throw new Error('Logout authority was not readable')
      expect(observed.record.frame.mode).toBe('logged-out')
      expect(observed.record.marker?.intent).toBe('logout-pending')
      expect(observed.record.cleanupDebts).toContainEqual(
        expect.objectContaining({
          source: priorSource,
          supersedingFrameRevision: observed.record.frame.revision,
        })
      )
    } finally {
      candidateRelease.resolve()
      cleanupRelease.resolve()
      await Promise.allSettled([settledSwitch, ...(logout ? [logout] : [])])
    }

    await cleanupCompleted.promise
    await new Promise(resolve => setImmediate(resolve))
    const cleanupScope = await h.tokenStore.createSessionAuthorityStorageScope()
    const { SessionAuthorityRecordRepository } = await import('../sessionAuthorityRecord.js')
    const cleanedRepository = new SessionAuthorityRecordRepository(
      cleanupScope,
      h.envKey,
      h.tokenStore
    )
    const cleanedRecord = cleanedRepository.observe()
    expect(cleanedRecord.status).toBe('observed')
    if (cleanedRecord.status !== 'observed')
      throw new Error('Cleaned logout authority was not readable')
    expect(cleanedRecord.record.frame.mode).toBe('logged-out')
    expect(cleanedRecord.record.cleanupDebts).toEqual([])

    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(homeToken)
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(teamToken)
    await expect(
      readSessionAuthoritySourceSelection({
        tokenStore: restarted.tokenStore,
        envKey: restarted.envKey,
      })
    ).resolves.not.toMatchObject({ status: 'accepted' })
  })
})

describe('temporary session when production Keytar access is unavailable', () => {
  it('admits memory auth after ordinary logout and requires fresh auth after restart', async () => {
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    const h = await harness()
    vi.spyOn(h.state.authClient, 'passwordLogin').mockResolvedValueOnce({
      token: homeToken,
      me: homeMe,
    })
    await expect(h.service.passwordLogin(homeMe.email, 'fixture-password')).resolves.toMatchObject({
      authenticated: true,
      me: homeMe,
    })
    await h.service.logout()
    expect(h.state.sessionToken).toBeNull()
    expect(h.markers.readPendingExternalLogoutIntent(runtime.directory, h.envKey)).toEqual({
      intent: 'logout-pending',
    })
    boundary.getPassword.mockRejectedValue(
      Object.assign(new Error('fixture keyring access denied'), { code: 'EACCES' })
    )
    const temporaryToken = validSessionToken()
    await expect(
      h.state.installAuthenticatedLogin({ token: temporaryToken, me: homeMe })
    ).resolves.toMatchObject({
      authenticated: true,
      me: homeMe,
      sessionMode: 'temporary',
    })
    expect(h.state.sessionToken).toBe(temporaryToken)
    expect(h.markers.readPendingExternalLogoutIntent(runtime.directory, h.envKey)).toMatchObject({
      intent: 'acceptance-pending',
    })
    expect(await fs.readdir(runtime.directory)).not.toContain(`session-token-${h.envKey}.json`)
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalled()
    boundary.getPassword.mockImplementation(
      async (service, account) => runtime.keychain.get(keyOf(service, account)) ?? null
    )
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
    expect(h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)).toMatchObject({
      intent: { intent: 'logout-pending' },
    })
    const freshToken = validSessionToken('fixture-isolated-fresh-session')
    await expect(
      h.state.installAuthenticatedLogin({ token: freshToken, me: homeMe })
    ).resolves.toMatchObject({ sessionMode: 'temporary' })
    expect(h.service.getCachedUserId()).toBe(homeMe.id)
    expect(await h.tokenStore.getSessionToken(h.envKey)).toBeNull()
    expect(await fs.readdir(runtime.directory)).not.toContain(`session-token-${h.envKey}.json`)
    expect(h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)).toMatchObject({
      intent: { intent: 'acceptance-pending' },
    })

    const { TokenStore } = await import('../tokenStore.js')
    const isolatedStore = new TokenStore({ isolatedUserDataPath: runtime.directory })
    await isolatedStore.setSessionToken('fixture-isolated-plaintext-exception', h.envKey)
    await expect(isolatedStore.getSessionToken(h.envKey)).resolves.toBe(
      'fixture-isolated-plaintext-exception'
    )
  })
})

describe('R21-M1 confirmed-invalid asynchronous cleanup', () => {
  it('keeps logout deny-only when exact source cleanup overlaps marker corruption', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    const { deleteSessionCredentialSourceIfUnselectedWithProof } = h.tokenStore
    const remove = deleteSessionCredentialSourceIfUnselectedWithProof.bind(h.tokenStore)
    const cleanupFinished = deferred()
    let corrupted = false
    vi.spyOn(
      h.tokenStore,
      'deleteSessionCredentialSourceIfUnselectedWithProof'
    ).mockImplementationOnce(async (...args) => {
      await fs.writeFile(h.markerPath, '{fixture-new-marker-corruption')
      corrupted = true
      const deleted = await remove(...args)
      cleanupFinished.resolve()
      return deleted
    })
    await expect(h.service.logout()).resolves.toMatchObject({
      kind: 'committed',
      sessionGeneration: expect.any(Number),
    })
    await cleanupFinished.promise
    expect(corrupted).toBe(true)
    expect(h.state.sessionToken).toBeNull()
    expect(h.state.me).toBeNull()
    await expect(h.service.applyPendingExternalLogoutIntent()).rejects.toThrow(
      'Session authority marker projection is missing, changed, or unverifiable'
    )
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalled()
  })
})

describe('R21-L1 exact stale encrypted disposal', () => {
  it('preserves legacy encrypted bytes without restoring them into the accepted V1 session', async () => {
    const h = await harness()
    const previous = 'fixture-previous-user-session'
    const fresh = 'fixture-new-user-session'
    await h.tokenStore.setSafeStorageSessionToken(previous, h.envKey)
    await h.state.installAuthenticatedLogin({ token: fresh, me: homeMe })
    expect(await h.tokenStore.getSafeStorageSessionToken(h.envKey)).toBe(previous)
    const accepted = await readAcceptedSession(h.tokenStore, h.envKey)
    const acceptanceMarker = accepted.accepted.record.projectionReceipt?.marker
    expect(acceptanceMarker).toBeDefined()
    expect(await fs.readFile(h.markerPath, 'utf8')).toBe(JSON.stringify(acceptanceMarker))
    for (let restart = 0; restart < 3; restart += 1) {
      const next = await harness()
      await expect(next.service.initialize()).resolves.toEqual({ authenticated: true, me: homeMe })
      expect(next.state.authClient.getMe).toHaveBeenCalledWith(fresh)
      expect(next.state.authClient.getMe).not.toHaveBeenCalledWith(previous)
      expect(await fs.readFile(h.markerPath, 'utf8')).toBe(JSON.stringify(acceptanceMarker))
    }
    const unavailable = await harness()
    boundary.getPassword.mockRejectedValue(
      Object.assign(new Error('fixture-native provider temporarily unavailable'), {
        code: 'EACCES',
      })
    )
    await expect(unavailable.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(unavailable.state.authClient.getMe).not.toHaveBeenCalledWith(previous)
    expect(unavailable.state.authClient.getMe).not.toHaveBeenCalledWith(fresh)
  })
})
