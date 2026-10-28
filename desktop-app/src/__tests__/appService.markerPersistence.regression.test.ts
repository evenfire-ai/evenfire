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

function validSessionToken(): string {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })
  ).toString('base64url')
  return `header.${payload}.signature`
}

async function useLockedKeytarAndUnavailableSafeStorage(
  h: Awaited<ReturnType<typeof harness>>
): Promise<void> {
  const keytar = await import('keytar')
  const getPassword = vi.mocked(keytar.getPassword)
  const originalGetPassword = getPassword.getMockImplementation()
  if (!originalGetPassword) throw new Error('Expected the Keytar fixture to have a read producer')
  getPassword.mockImplementation(async (service, account) => {
    if (account.startsWith('session-v1-capability-probe:'))
      throw Object.assign(new Error('fixture Keytar access denied'), { code: 'EACCES' })
    return originalGetPassword(service, account)
  })
  const { safeStorage } = await import('electron')
  vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
  await expect(h.tokenStore.inspectVersionedKeytarCapability()).resolves.toBe('unavailable')
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
  await config.saveDesktopRuntimeConfig({
    externalRestApiBaseUrl: 'https://auth.marker-persistence.test/api',
    rpcProxyBaseUrl: 'https://rpc.marker-persistence.test',
  })
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
    withNativeAuthEnvironmentCommit: <T>(operation: () => Promise<T>) => Promise<T>
    suspendDesktopGfsUploadsForAuthBoundary: (...args: unknown[]) => Promise<void>
    runWithTeamContext: <T>(team: string, operation: (token: string) => Promise<T>) => Promise<T>
    authClient: {
      passwordLogin: (
        email: string,
        password: string
      ) => Promise<{ token: string; me: typeof homeMe }>
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

async function authenticateHome(h: Awaited<ReturnType<typeof harness>>) {
  vi.spyOn(h.state.authClient, 'passwordLogin').mockResolvedValueOnce({
    token: homeToken,
    me: homeMe,
  })
  await expect(h.service.passwordLogin(homeMe.email, 'fixture-password')).resolves.toMatchObject({
    authenticated: true,
    me: homeMe,
  })
}

async function authenticateAcceptedKeytarHome(h: Awaited<ReturnType<typeof harness>>) {
  await authenticateHome(h)
  const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
  const selected = await readSessionAuthoritySourceSelection({
    tokenStore: h.tokenStore,
    envKey: h.envKey,
  })
  expect(selected.status).toBe('accepted')
  if (selected.status !== 'accepted') throw new Error('Expected the accepted Keytar source')
  expect(selected.session.token).toBe(homeToken)
  expect(selected.session.accepted.record.frame.source).toMatchObject({
    format: 'v1',
    kind: 'keytar',
    accountId: homeMe.id,
  })
}

async function expectV2AcceptanceMarker(h: Awaited<ReturnType<typeof harness>>) {
  const scope = await h.tokenStore.createSessionAuthorityStorageScope()
  const { SessionAuthorityRecordRepository } = await import('../sessionAuthorityRecord.js')
  const observed = new SessionAuthorityRecordRepository(scope, h.envKey, h.tokenStore).observe()
  const record = observed.status === 'observed' ? observed.record : null
  expect(record).not.toBeNull()
  expect(record?.projectionReceipt).not.toBeNull()
  const expected = h.markers.acceptancePendingExternalMarker(record!.projectionReceipt!.marker)
  expect(h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)).toEqual(expected)
  return expected
}

async function acceptedKeytarAccount(h: Awaited<ReturnType<typeof harness>>) {
  const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
  const selection = await readSessionAuthoritySourceSelection({
    tokenStore: h.tokenStore,
    envKey: h.envKey,
  })
  expect(selection.status).toBe('accepted')
  if (selection.status !== 'accepted') throw new Error('Expected accepted persistent source')
  expect(selection.session.accepted.record.frame.source).toMatchObject({
    format: 'v1',
    kind: 'keytar',
  })
  const source = selection.session.accepted.record.frame.source
  if (!source || source.format !== 'v1' || source.kind !== 'keytar')
    throw new Error('Expected accepted V1 Keytar source')
  return `session-v1:${source.sourceRef}`
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
        () => 'settled (fulfilled)',
        error => `settled (rejected: ${error instanceof Error ? error.message : String(error)})`
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
  it('queues public password login behind logout and restores only the fresh accepted source', async () => {
    const h = await harness()
    const priorToken = validSessionToken()
    const replacementToken = validSessionToken()
    vi.spyOn(h.state.authClient, 'passwordLogin').mockResolvedValueOnce({
      token: priorToken,
      me: homeMe,
    })
    vi.mocked(h.state.authClient.getMe).mockResolvedValue(homeMe)
    await expect(h.service.passwordLogin(homeMe.email, 'fixture-password')).resolves.toMatchObject({
      authenticated: true,
      me: homeMe,
    })

    const entered = deferred()
    const release = deferred()
    const suspend = h.state.suspendDesktopGfsUploadsForAuthBoundary.bind(h.state)
    vi.spyOn(h.state, 'suspendDesktopGfsUploadsForAuthBoundary').mockImplementationOnce(
      async (...args) => {
        entered.resolve()
        await release.promise
        return suspend(...args)
      }
    )
    const oldLogout = own(h.service.logout())
    await awaitPhase(entered.promise, oldLogout, 'logout consumer fence')

    // A is already represented by its accepted V1 source. Make the provider unavailable only
    // after logout has admitted and captured its exact authority, so the queued password login
    // exercises the approved M fallback rather than altering A's logout observation.
    await useLockedKeytarAndUnavailableSafeStorage(h)
    vi.spyOn(h.state.authClient, 'passwordLogin').mockResolvedValueOnce({
      token: replacementToken,
      me: homeMe,
    })
    const loginQueued = deferred()
    const commit = h.state.withNativeAuthEnvironmentCommit.bind(h.state)
    vi.spyOn(h.state, 'withNativeAuthEnvironmentCommit').mockImplementationOnce(operation => {
      loginQueued.resolve()
      return commit(operation)
    })
    const login = own(h.service.passwordLogin(homeMe.email, 'fixture-password'))
    void login.catch(() => undefined)
    try {
      await awaitPhase(loginQueued.promise, login, 'queued public password login')
      // Logout fences the in-memory lease before durable publication or exact source cleanup.
      expect(h.state.sessionToken).toBeNull()
    } finally {
      release.resolve()
      await oldLogout
    }
    const loginResult = await login
    expect(loginResult).toMatchObject({
      authenticated: true,
      me: homeMe,
      sessionMode: 'temporary',
    })
    expect(h.service.getCachedUserId()).toBe(homeMe.id)
    await expectV2AcceptanceMarker(h)
    expect(h.state.sessionToken).toBe(replacementToken)
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(replacementToken)
    expect(restarted.service.getCachedUserId()).toBeNull()
  })
})

describe('team persistence preserves the existing secure session on transient failures', () => {
  it('keeps the accepted Keytar source pinned when Keytar becomes unavailable during a team change', async () => {
    const h = await harness()
    const acceptedHomeToken = validSessionToken()
    vi.spyOn(h.state.authClient, 'getMe').mockResolvedValue(homeMe)
    vi.spyOn(h.state.authClient, 'passwordLogin').mockResolvedValueOnce({
      token: acceptedHomeToken,
      me: homeMe,
    })
    const loginState = await h.service.passwordLogin(homeMe.email, 'fixture-password')
    expect(loginState).toMatchObject({
      authenticated: true,
      me: homeMe,
    })
    expect(loginState.sessionMode).toBeUndefined()
    vi.doMock('keytar', () => ({}))
    await expect(h.service.switchTeam('fixture-other')).rejects.toBeInstanceOf(Error)
    expect(h.state.sessionToken).toBe(acceptedHomeToken)
    expect(h.state.me).toEqual(homeMe)
    expect(await h.tokenStore.getSafeStorageSessionToken(h.envKey)).toBeNull()
    await expectV2AcceptanceMarker(h)
    vi.doMock('keytar', () => keytarBoundary)
    vi.resetModules()
    const recoveredRestart = await harness()
    vi.mocked(recoveredRestart.state.authClient.getMe).mockResolvedValue(homeMe)
    const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
    const recoveredSelection = await readSessionAuthoritySourceSelection({
      tokenStore: recoveredRestart.tokenStore,
      envKey: recoveredRestart.envKey,
    })
    expect(
      recoveredSelection.status,
      recoveredSelection.status === 'denied' ? recoveredSelection.frameMode : undefined
    ).toBe('accepted')
    if (recoveredSelection.status === 'accepted') {
      expect(recoveredSelection.session.token).toBe(acceptedHomeToken)
      expect(recoveredSelection.session.accepted.record.frame.source).toMatchObject({
        format: 'v1',
        kind: 'keytar',
        accountId: homeMe.id,
      })
    }
    await expect(recoveredRestart.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: homeMe,
    })
    expect(recoveredRestart.state.authClient.getMe).toHaveBeenCalledWith(acceptedHomeToken)
    expect(recoveredRestart.state.authClient.getMe).not.toHaveBeenCalledWith(
      'fixture-other-session'
    )
  })

  it('returns from durable logout while one exact credential deletion is blocked', async () => {
    const h = await harness()
    await authenticateAcceptedKeytarHome(h)
    const entered = deferred()
    const release = deferred()
    const deletionFinished = deferred()
    const deleteSource = h.tokenStore.deleteSessionCredentialSourceIfUnselectedWithProof.bind(
      h.tokenStore
    )
    const deleteAttempt = vi
      .spyOn(h.tokenStore, 'deleteSessionCredentialSourceIfUnselectedWithProof')
      .mockImplementationOnce(async (...args) => {
        entered.resolve()
        await release.promise
        const result = await deleteSource(...args)
        deletionFinished.resolve()
        return result
      })
    const logout = own(h.service.logout())
    expect(h.state.sessionToken).toBeNull()
    await entered.promise
    await expect(logout).resolves.toMatchObject({ kind: 'committed' })
    expect(h.state.me).toBeNull()
    expect(deleteAttempt).toHaveBeenCalledOnce()
    release.resolve()
    await deletionFinished.promise
    const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
    await expect(
      readSessionAuthoritySourceSelection({ tokenStore: h.tokenStore, envKey: h.envKey })
    ).resolves.toMatchObject({ status: 'denied', frameMode: 'logged-out' })
  })

  it('preserves legacy encrypted credential bytes after accepting a fresh Keytar session', async () => {
    const h = await harness()
    const oldToken = 'fixture-previous-user-session'
    const freshToken = 'fixture-new-user-session'
    const freshMe = { ...homeMe, id: 'fixture-new-user' }
    await h.tokenStore.setSafeStorageSessionToken(oldToken, h.envKey)
    vi.spyOn(h.state.authClient, 'passwordLogin').mockResolvedValueOnce({
      token: freshToken,
      me: freshMe,
    })
    vi.spyOn(h.state.authClient, 'getMe').mockImplementation(async token => {
      if (token === freshToken) return freshMe
      if (token === oldToken) return homeMe
      throw new Error('Unexpected session identity validation')
    })
    await expect(h.service.passwordLogin(freshMe.email, 'fixture-password')).resolves.toEqual({
      authenticated: true,
      me: freshMe,
    })
    await expectV2AcceptanceMarker(h)
    expect(await h.tokenStore.getSafeStorageSessionToken(h.envKey)).toBe(oldToken)
    const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
    const selected = await readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(selected.status).toBe('accepted')
    if (selected.status !== 'accepted') throw new Error('Expected fresh accepted Keytar source')
    expect(selected.session.token).toBe(freshToken)
    expect(selected.session.accepted.record.frame.source).toMatchObject({
      format: 'v1',
      kind: 'keytar',
      accountId: freshMe.id,
    })
    const restarted = await harness()
    vi.spyOn(restarted.state.authClient, 'getMe').mockImplementation(async token => {
      if (token === freshToken) return freshMe
      if (token === oldToken) return homeMe
      throw new Error('Unexpected restart identity validation')
    })
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: freshMe,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(freshToken)
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(oldToken)
  })

  it('keeps the accepted source after a partial candidate write rejects', async () => {
    const h = await harness()
    await authenticateHome(h)
    const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
    const prior = await readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(prior.status).toBe('accepted')
    if (prior.status !== 'accepted') throw new Error('Expected accepted Home source')
    const keytar = await import('keytar')
    vi.mocked(keytar.setPassword).mockImplementationOnce(async (service, account, token) => {
      runtime.keychain.set(keyOf(service, account), token)
      throw new Error('fixture-partial active write')
    })
    await expect(h.service.switchTeam('fixture-other')).rejects.toThrow(
      'fixture-partial active write'
    )
    expect(h.state.sessionToken).toBe(homeToken)
    const current = await readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(current.status).toBe('accepted')
    if (current.status !== 'accepted') throw new Error('Expected prior source to remain selected')
    expect(current.session.token).toBe(homeToken)
    expect(current.session.accepted.record.frame.source).toEqual(
      prior.session.accepted.record.frame.source
    )
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: homeMe,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(homeToken)
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith('fixture-other-session')
  })

  it('keeps the accepted source when candidate read-back cannot verify', async () => {
    const h = await harness()
    await authenticateHome(h)
    const acceptedAccount = await acceptedKeytarAccount(h)
    const keytar = await import('keytar')
    const originalGet = vi.mocked(keytar.getPassword).getMockImplementation()!
    const originalSet = vi.mocked(keytar.setPassword).getMockImplementation()!
    let candidateAccount: string | null = null
    vi.mocked(keytar.setPassword).mockImplementation(async (service, account, token) => {
      if (account !== acceptedAccount) candidateAccount = account
      await originalSet(service, account, token)
    })
    vi.mocked(keytar.getPassword).mockImplementation(async (service, account) => {
      if (candidateAccount === account) return null
      return originalGet(service, account)
    })
    await expect(h.service.switchTeam('fixture-other')).rejects.toThrow('read-back')
    expect(h.state.sessionToken).toBe(homeToken)
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: homeMe,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(homeToken)
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith('fixture-other-session')
  })

  it('retains the accepted source when exact rejected-candidate cleanup fails', async () => {
    const h = await harness()
    await authenticateHome(h)
    const acceptedAccount = await acceptedKeytarAccount(h)
    const keytar = await import('keytar')
    const originalSet = vi.mocked(keytar.setPassword).getMockImplementation()!
    let candidateAccount: string | null = null
    vi.mocked(keytar.setPassword).mockImplementation(async (service, account, token) => {
      if (account !== acceptedAccount) {
        candidateAccount = account
        runtime.keychain.set(keyOf(service, account), token)
        throw new Error('fixture-partial candidate write')
      }
      await originalSet(service, account, token)
    })
    vi.mocked(keytar.deletePassword).mockImplementation(async (service, account) => {
      if (candidateAccount === account) throw new Error('fixture-candidate cleanup unavailable')
      return runtime.keychain.delete(keyOf(service, account))
    })
    await expect(h.service.switchTeam('fixture-other')).rejects.toThrow(
      'fixture-partial candidate write'
    )
    expect(h.state.sessionToken).toBe(homeToken)
    expect(h.state.me).toEqual(homeMe)
    const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
    const selected = await readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(selected.status).toBe('accepted')
    if (selected.status !== 'accepted') throw new Error('Expected Home source to remain accepted')
    expect(selected.session.token).toBe(homeToken)
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: homeMe,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(homeToken)
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith('fixture-other-session')
  })

  it('drains an admitted V1 candidate write before quit without converting providers', async () => {
    const h = await harness()
    await authenticateHome(h)
    const acceptedAccount = await acceptedKeytarAccount(h)
    const keytar = await import('keytar')
    const entered = deferred()
    const release = deferred()
    const setPassword = vi.mocked(keytar.setPassword).getMockImplementation()!
    vi.mocked(keytar.setPassword).mockImplementation(async (service, account, token) => {
      await setPassword(service, account, token)
      if (account !== acceptedAccount) {
        entered.resolve()
        await release.promise
      }
    })
    const switching = own(h.service.switchTeam('fixture-other'))
    await awaitPhase(entered.promise, switching, 'V1 candidate source write')
    expect(await h.tokenStore.getSafeStorageSessionToken(h.envKey)).toBeNull()
    const draining = own(h.service.prepareForQuit())
    let quitSettled = false
    void draining.then(() => {
      quitSettled = true
    })
    await new Promise(resolve => setImmediate(resolve))
    expect(quitSettled).toBe(false)
    release.resolve()
    await draining
    await expect(switching).resolves.toMatchObject({
      authenticated: true,
      me: { ...homeMe, teamId: 'fixture-other' },
    })
    expect(h.state.sessionToken).toBe('fixture-other-session')
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: { ...homeMe, teamId: 'fixture-other' },
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith('fixture-other-session')
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
      await authenticateHome(h)
      const acceptedAccount = await acceptedKeytarAccount(h)
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
              return 'fixture-operation-result'
            })
      await expect(execute()).rejects.toThrow('fixture-transient Keytar write')
      expect(h.state.sessionToken).toBe(homeToken)
      expect(h.service.getCachedUserId()).toBe(homeMe.id)
      expect(h.state.me).toEqual(homeMe)
      expect(await h.tokenStore.getSafeStorageSessionToken(h.envKey)).toBeNull()
      expect(notifySessionChanged).not.toHaveBeenCalledWith(false)
      const { readSessionAuthoritySourceSelection } =
        await import('../sessionAuthorityAcceptance.js')
      const selected = await readSessionAuthoritySourceSelection({
        tokenStore: h.tokenStore,
        envKey: h.envKey,
      })
      expect(selected.status).toBe('accepted')
      if (selected.status !== 'accepted') throw new Error('Expected pinned Home source')
      expect(selected.session.token).toBe(homeToken)
      expect(selected.session.accepted.record.frame.source).toMatchObject({
        format: 'v1',
        kind: 'keytar',
      })
      expect(
        selected.session.accepted.record.frame.source?.format === 'v1' &&
          selected.session.accepted.record.frame.source.sourceRef
      ).toBe(acceptedAccount.slice('session-v1:'.length))
      const restarted = await harness()
      await expect(restarted.service.initialize()).resolves.toEqual({
        authenticated: true,
        me: homeMe,
      })
      expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(homeToken)
      expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith('fixture-other-session')
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
    const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
    const selected = await readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(selected.status).toBe('accepted')
    if (selected.status !== 'accepted') throw new Error('Expected the accepted Keytar source')
    expect(selected.session.token).toBe(homeToken)
    expect(selected.session.accepted.record.frame.source).toMatchObject({
      format: 'v1',
      kind: 'keytar',
    })
    await expectV2AcceptanceMarker(h)
    expect(notifySessionChanged).not.toHaveBeenCalledWith(false)
    expect(h.reportFailure).toHaveBeenCalledWith(expect.objectContaining({ code: 'EMFILE' }))
  })

  it('logout preempts a delayed temporary team candidate and denies restore', async () => {
    const h = await harness()
    await useLockedKeytarAndUnavailableSafeStorage(h)
    const makeToken = (jti: string) => {
      const payload = Buffer.from(
        JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, jti })
      ).toString('base64url')
      return `header.${payload}.signature`
    }
    const priorToken = makeToken('prior-temporary-session')
    const teamToken = makeToken('rejected-team-session')
    await h.state.installAuthenticatedLogin({ token: priorToken, me: homeMe })
    expect(h.service.getCachedUserId()).toBe(homeMe.id)
    await expectV2AcceptanceMarker(h)

    vi.spyOn(h.state.authClient, 'switchTeam').mockResolvedValue({ token: teamToken })
    const refreshEntered = deferred()
    const releaseRefresh = deferred()
    vi.spyOn(h.state.authClient, 'getMe').mockImplementation(async token => {
      if (token !== teamToken) return homeMe
      refreshEntered.resolve()
      await releaseRefresh.promise
      throw new Error('fixture team identity refresh failed')
    })
    const switching = own(h.service.switchTeam('fixture-other'))
    await awaitPhase(refreshEntered.promise, switching, 'temporary team identity refresh')
    const logout = h.service.logout()
    releaseRefresh.resolve()

    await expect(switching).rejects.toBeInstanceOf(Error)
    await expect(logout).resolves.toMatchObject({ kind: 'committed' })

    expect(h.state.sessionToken).toBeNull()
    expect(h.state.me).toBeNull()
    expect(h.markers.readPendingExternalLogoutIntent(runtime.directory, h.envKey)).toEqual({
      intent: 'logout-pending',
    })
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(priorToken)
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(teamToken)
  })
})

describe('persistence transaction ordering', () => {
  it('keeps a newer public login authoritative after a paused partial V1 candidate write', async () => {
    const h = await harness()
    await authenticateHome(h)
    const acceptedAccount = await acceptedKeytarAccount(h)
    const keytar = await import('keytar')
    const candidateEntered = deferred()
    const candidateRelease = deferred()
    let firstCandidate = true
    vi.mocked(keytar.setPassword).mockImplementation(async (service, account, token) => {
      if (account !== acceptedAccount && firstCandidate) {
        firstCandidate = false
        runtime.keychain.set(keyOf(service, account), token)
        candidateEntered.resolve()
        await candidateRelease.promise
        throw new Error('fixture-partial candidate write')
      }
      runtime.keychain.set(keyOf(service, account), token)
    })
    const switching = own(h.service.switchTeam('fixture-other'))
    const switchedResult = switching.then(
      () => undefined,
      () => undefined
    )
    await awaitPhase(candidateEntered.promise, switching, 'partial V1 candidate write')
    const newerMe = { ...homeMe, id: 'fixture-new-user' }
    vi.spyOn(h.state.authClient, 'getMe').mockImplementation(async token =>
      token === 'fixture-new-user-session' ? newerMe : homeMe
    )
    vi.spyOn(h.state.authClient, 'passwordLogin').mockResolvedValue({
      token: 'fixture-new-user-session',
      me: newerMe,
    })
    const newer = own(h.service.passwordLogin('fixture-new-user@example.test', 'fixture-password'))
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(h.state.authClient.passwordLogin).not.toHaveBeenCalledWith(
      'fixture-new-user@example.test',
      'fixture-password'
    )
    candidateRelease.resolve()
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

  it('keeps a public login authoritative after a staged team identity check settles', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    const entered = deferred()
    const release = deferred()
    const getMe = vi.mocked(h.state.authClient.getMe).getMockImplementation()!
    vi.mocked(h.state.authClient.getMe).mockImplementation(async token => {
      if (token === 'fixture-other-session') {
        entered.resolve()
        await release.promise
        return { ...homeMe, teamId: 'fixture-other' }
      }
      if (token === 'fixture-new-user-session') return { ...homeMe, id: 'fixture-new-user' }
      return getMe(token)
    })
    vi.spyOn(h.state.authClient, 'switchTeam').mockResolvedValue({
      token: 'fixture-other-session',
    })
    const newerMe = { ...homeMe, id: 'fixture-new-user' }
    const newPasswordLogin = vi
      .spyOn(h.state.authClient, 'passwordLogin')
      .mockResolvedValue({ token: 'fixture-new-user-session', me: newerMe })
    const switching = own(h.service.switchTeam('fixture-other'))
    const switchedResult = switching.then(
      () => null,
      error => error
    )
    await awaitPhase(entered.promise, switching, 'older team identity refresh')
    const newer = own(h.service.passwordLogin('fixture-new-user@example.test', 'fixture-password'))
    expect(newPasswordLogin).not.toHaveBeenCalled()
    try {
      release.resolve()
      await Promise.all([switchedResult, newer])
    } finally {
      release.resolve()
    }
    expect(newPasswordLogin).toHaveBeenCalledOnce()
    expect(h.service.getCachedUserId()).toBe(newerMe.id)
    expect(h.state.me).toEqual(newerMe)
    expect(h.state.sessionToken).toBe('fixture-new-user-session')
    const restarted = await harness()
    vi.mocked(restarted.state.authClient.getMe).mockResolvedValue(newerMe)
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: newerMe,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith('fixture-new-user-session')
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith('fixture-other-session')
  })

  it('retains a newer login across an older paused native team write', async () => {
    const h = await harness()
    await authenticateAcceptedKeytarHome(h)
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
    const newerMe = { ...homeMe, id: 'fixture-new-user' }
    const getMe = vi.mocked(h.state.authClient.getMe).getMockImplementation()!
    vi.mocked(h.state.authClient.getMe).mockImplementation(async token =>
      token === 'fixture-new-user-session' ? newerMe : getMe(token)
    )
    const newPasswordLogin = vi
      .spyOn(h.state.authClient, 'passwordLogin')
      .mockResolvedValue({ token: 'fixture-new-user-session', me: newerMe })
    const newer = own(h.service.passwordLogin('fixture-new-user@example.test', 'fixture-password'))
    try {
      expect(newPasswordLogin).toHaveBeenCalledOnce()
      expect(h.state.sessionToken).toBe(homeToken)
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
  it('drains an admitted write, then lets LP logout supersede its candidate', async () => {
    const h = await harness()
    await authenticateHome(h)
    const clear = vi.spyOn(h.tokenStore, 'clearSessionTokenStrictly')
    const keytar = await import('keytar')
    const acceptedAccount = await acceptedKeytarAccount(h)
    const setPassword = vi.mocked(keytar.setPassword).getMockImplementation()!
    const entered = deferred()
    const release = deferred()
    vi.mocked(keytar.setPassword).mockImplementation(async (service, account, token) => {
      await setPassword(service, account, token)
      if (account !== acceptedAccount) {
        entered.resolve()
        await release.promise
      }
    })
    const switching = own(h.service.switchTeam('fixture-other'))
    await awaitPhase(entered.promise, switching, 'admitted V1 candidate write')
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
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(logoutSettled).toBe(false)
      expect(clear).not.toHaveBeenCalled()
    } finally {
      release.resolve()
    }
    await expect(switching).rejects.toThrow('superseded')
    await logout
    expect(clear).not.toHaveBeenCalled()
    expect(h.state.sessionToken).toBeNull()
    expect(h.service.getCachedUserId()).toBeNull()
    const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
    const loggedOut = await readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(loggedOut).toEqual({ status: 'denied', frameMode: 'logged-out' })
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalled()
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith('fixture-other-session')
  })

  it('keeps a pinned Keytar session after a partial team candidate without S migration', async () => {
    const h = await harness()
    await authenticateHome(h)
    const acceptedAccount = await acceptedKeytarAccount(h)
    const keytar = await import('keytar')
    vi.mocked(keytar.setPassword).mockImplementationOnce(async (service, account, token) => {
      runtime.keychain.set(keyOf(service, account), token)
      throw new Error('fixture-partial ordinary Keytar write')
    })
    let safeStorageRenameAttempted = false
    const rename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      if (String(destination).endsWith('.enc')) safeStorageRenameAttempted = true
      return rename(source, destination)
    })
    await expect(h.service.switchTeam('fixture-other')).rejects.toThrow(
      'fixture-partial ordinary Keytar write'
    )
    expect(safeStorageRenameAttempted).toBe(false)
    expect(h.state.sessionToken).toBe(homeToken)
    expect(await h.tokenStore.getSafeStorageSessionToken(h.envKey)).toBeNull()
    const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
    const selected = await readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(selected.status).toBe('accepted')
    if (selected.status !== 'accepted') throw new Error('Expected Home authority')
    expect(selected.session.token).toBe(homeToken)
    expect(selected.session.accepted.record.frame.source).toMatchObject({
      format: 'v1',
      kind: 'keytar',
      sourceRef: acceptedAccount.slice('session-v1:'.length),
    })
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: homeMe,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(homeToken)
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith('fixture-other-session')
  })
})

describe('R20-M5 rejected encrypted fallback residue', () => {
  it('keeps the accepted Keytar source when a team write fails beside legacy residue', async () => {
    const h = await harness()
    await authenticateAcceptedKeytarHome(h)
    const legacyToken = 'fixture-unselected-encrypted-residue'
    await h.tokenStore.setSafeStorageSessionToken(legacyToken, h.envKey)
    const keytar = await import('keytar')
    vi.mocked(keytar.setPassword).mockRejectedValueOnce(new Error('fixture-transient Keytar write'))
    const error = await h.service.switchTeam('fixture-other').then(
      () => null,
      error => error
    )
    const firstRestart = await harness()
    const firstState = await firstRestart.service.initialize()
    vi.doMock('keytar', () => ({}))
    const secondRestart = await harness()
    await expect(secondRestart.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(secondRestart.state.authClient.getMe).not.toHaveBeenCalledWith('fixture-other-session')
    expect(firstState).toEqual({ authenticated: true, me: homeMe })
    await expect(firstRestart.tokenStore.getSafeStorageSessionToken(h.envKey)).resolves.toBe(
      legacyToken
    )
    expect(secondRestart.state.authClient.getMe).not.toHaveBeenCalledWith(legacyToken)
    expect(h.state.sessionToken).toBe(homeToken)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe('fixture-transient Keytar write')
  })

  it('keeps accepted V1 Keytar authority when Keytar disappears without falling back to residue', async () => {
    const h = await harness()
    await authenticateAcceptedKeytarHome(h)
    const legacyToken = 'fixture-unselected-encrypted-residue'
    await h.tokenStore.setSafeStorageSessionToken(legacyToken, h.envKey)
    const keytar = await import('keytar')
    vi.mocked(keytar.setPassword).mockRejectedValueOnce(new Error('fixture-transient Keytar write'))
    const error = await h.service.switchTeam('fixture-other').then(
      () => null,
      error => error
    )
    const firstRestart = await harness()
    const firstState = await firstRestart.service.initialize()
    const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
    const firstSelection = await readSessionAuthoritySourceSelection({
      tokenStore: firstRestart.tokenStore,
      envKey: h.envKey,
    })
    expect(firstSelection.status).toBe('accepted')
    if (firstSelection.status !== 'accepted')
      throw new Error('Expected the exact pinned Keytar source after restart')
    expect(firstSelection.session.token).toBe(homeToken)
    expect(firstSelection.session.accepted.record.frame.source).toMatchObject({
      format: 'v1',
      kind: 'keytar',
      envKey: h.envKey,
    })
    await expect(firstRestart.tokenStore.getSafeStorageSessionToken(h.envKey)).resolves.toBe(
      legacyToken
    )
    vi.doMock('keytar', () => ({}))
    const secondRestart = await harness()
    await expect(secondRestart.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(secondRestart.state.authClient.getMe).not.toHaveBeenCalled()
    expect(secondRestart.state.authClient.getMe).not.toHaveBeenCalledWith('fixture-other-session')
    expect(secondRestart.state.authClient.getMe).not.toHaveBeenCalledWith(
      'fixture-unselected-encrypted-residue'
    )
    expect(firstState).toEqual({ authenticated: true, me: homeMe })
    expect(secondRestart.state.authClient.getMe).not.toHaveBeenCalledWith(legacyToken)
    expect(h.state.sessionToken).toBe(homeToken)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe('fixture-transient Keytar write')
  })
})

describe('explicit login transient marker inspection', () => {
  it('preserves accepted authority when its acceptance marker is transiently unreadable', async () => {
    const h = await harness()
    await authenticateAcceptedKeytarHome(h)
    const observed = h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)
    const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
    const before = await readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(before.status).toBe('accepted')
    if (before.status !== 'accepted') throw new Error('Expected pinned V1 Keytar authority')
    const sourceBefore = before.session.accepted.record.frame.source
    expect(sourceBefore).toMatchObject({ format: 'v1', kind: 'keytar' })
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
    const selected = await readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(selected.status).toBe('accepted')
    if (selected.status !== 'accepted') throw new Error('Expected the accepted Keytar source')
    expect(selected.session.token).toBe(homeToken)
    expect(selected.session.accepted.record.frame.source).toEqual(sourceBefore)
    expect(h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)).toEqual(observed)
    expect(keytar.setPassword).not.toHaveBeenCalled()
  })
})

describe('R18-M3 cleanup-only revision ownership', () => {
  it('carries exact cleanup debt across a newer accepted source after cleanup failure', async () => {
    const h = await harness()
    await authenticateHome(h)
    const oldAccount = await acceptedKeytarAccount(h)
    const keytar = await import('keytar')
    const cleanupEntered = deferred()
    const cleanupRelease = deferred()
    vi.mocked(keytar.deletePassword).mockImplementationOnce(async (service, account) => {
      expect(account).toBe(oldAccount)
      cleanupEntered.resolve()
      await cleanupRelease.promise
      throw new Error('fixture-exact prior-source cleanup temporarily failed')
    })
    const switching = own(h.service.switchTeam('fixture-other'))
    const switched = switching.then(
      () => null,
      error => error
    )
    await awaitPhase(cleanupEntered.promise, switching, 'exact selected-source cleanup')
    expect(h.state.sessionToken).toBe('fixture-other-session')

    const newerMe = { ...homeMe, id: 'fixture-new-user' }
    vi.spyOn(h.state.authClient, 'getMe').mockImplementation(async token =>
      token === 'fixture-new-user-session' ? newerMe : homeMe
    )
    vi.spyOn(h.state.authClient, 'passwordLogin').mockResolvedValue({
      token: 'fixture-new-user-session',
      me: newerMe,
    })
    const newer = own(h.service.passwordLogin('fixture-new-user@example.test', 'fixture-password'))
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(h.state.authClient.passwordLogin).not.toHaveBeenCalledWith(
      'fixture-new-user@example.test',
      'fixture-password'
    )
    cleanupRelease.resolve()
    const switchError = await switched
    await expect(newer).resolves.toMatchObject({ authenticated: true, me: newerMe })
    expect(switchError).toBeNull()
    expect(
      vi.mocked(keytar.deletePassword).mock.calls.some(([, account]) => account === oldAccount)
    ).toBe(true)
    expect(h.state.sessionToken).toBe('fixture-new-user-session')
    const restarted = await harness()
    vi.mocked(restarted.state.authClient.getMe).mockResolvedValue(newerMe)
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: newerMe,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith('fixture-new-user-session')
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(homeToken)
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith('fixture-other-session')
  })
})

describe('accepted marker ownership', () => {
  it('rejects an unowned cleanup-marker write over the accepted projection', async () => {
    const h = await harness()
    await authenticateAcceptedKeytarHome(h)
    const before = h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)
    expect(before?.intent.intent).toBe('acceptance-pending')
    expect(() =>
      h.markers.recordPendingKeytarCleanup(runtime.directory, h.envKey, 'active-keytar')
    ).toThrow('Pending acceptance marker requires an exact compare-and-swap transition')
    expect(h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)).toEqual(before)
    const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
    await expect(
      readSessionAuthoritySourceSelection({ tokenStore: h.tokenStore, envKey: h.envKey })
    ).resolves.toMatchObject({ status: 'accepted', session: { token: homeToken } })
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: homeMe,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(homeToken)
  })
})

describe('R20-M7 restore response epoch fencing', () => {
  it('does not publish an in-flight restore after a newer logout commits', async () => {
    const h = await harness()
    await authenticateAcceptedKeytarHome(h)
    const restoringService = await harness()
    const getMeStarted = deferred<void>()
    const releaseGetMe = deferred<typeof homeMe>()
    vi.mocked(restoringService.state.authClient.getMe).mockImplementation(async token => {
      if (token !== homeToken) throw new Error('Unexpected restore token')
      getMeStarted.resolve()
      return releaseGetMe.promise
    })
    const restoring = own(restoringService.service.initialize())
    await awaitPhase(getMeStarted.promise, restoring, 'saved-source identity verification')
    const logout = own(h.service.logout())
    expect(h.state.sessionToken).toBeNull()
    try {
      await expect(logout).resolves.toMatchObject({ kind: 'committed' })
    } finally {
      releaseGetMe.resolve(homeMe)
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
