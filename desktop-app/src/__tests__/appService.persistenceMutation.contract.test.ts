import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
vi.mock('../windowsSessionAuthorityAcl.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../windowsSessionAuthorityAcl.js')>()
  const { createWindowsSessionAuthorityAclUnitFixture } =
    await import('../../testSupport/windowsSessionAuthorityAclUnitFixture.js')
  return createWindowsSessionAuthorityAclUnitFixture(actual)
})
vi.mock('electron', () => ({
  app: { getPath: () => boundary.directory, isReady: () => true },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
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
let priorConfigPath: string | undefined

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  boundary.credentials.clear()
  boundary.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-persistence-contract-'))
  priorConfigPath = process.env.CLERUM_DESKTOP_CONFIG_PATH
  process.env.CLERUM_DESKTOP_CONFIG_PATH = path.join(boundary.directory, 'desktop-runtime.json')
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
  if (priorConfigPath === undefined) delete process.env.CLERUM_DESKTOP_CONFIG_PATH
  else process.env.CLERUM_DESKTOP_CONFIG_PATH = priorConfigPath
  priorConfigPath = undefined
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
  const [{ AppService }, { TokenStore }, markers, config, journal] = await Promise.all([
    import('../appService.js'),
    import('../tokenStore.js'),
    import('../pendingExternalLogout.js'),
    import('../config.js'),
    import('../sessionPersistenceJournal.js'),
  ])
  await config.saveDesktopRuntimeConfig({
    externalRestApiBaseUrl: 'http://127.0.0.1:8091',
    rpcProxyBaseUrl: 'http://127.0.0.1:8094',
    appName: 'Evenfire',
  })
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
    runSessionPersistence: <T>(operation: () => Promise<T>) => Promise<T>
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
    teamId: token === otherToken ? 'fixture-other' : homeMe.teamId,
  }))
  vi.spyOn(state.authClient, 'switchTeam').mockResolvedValue({ token: otherToken })
  return {
    service,
    tokenStore,
    state,
    markers,
    journal,
    reportFailure,
    envKey: config.getActiveEnvKey(),
  }
}

async function readAuthorityRecord(
  tokenStore: Awaited<ReturnType<typeof harness>>['tokenStore'],
  envKey: string
) {
  const storageScope = await tokenStore.createSessionAuthorityStorageScope()
  const { SessionAuthorityRecordRepository } = await import('../sessionAuthorityRecord.js')
  const repository = new SessionAuthorityRecordRepository(storageScope, envKey, tokenStore)
  const observation = repository.observe()
  if (observation.status !== 'observed')
    throw new Error(`Expected an observed authority record, found ${observation.status}`)
  return observation.record
}

describe('source persistence mutation-sensitive contracts', () => {
  it('keeps exact logout cleanup from deleting a fresh source accepted during prior-source cleanup', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
    const prior = await readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(prior.status).toBe('accepted')
    if (prior.status !== 'accepted' || prior.session.accepted.record.frame.source?.format !== 'v1')
      throw new Error('Expected an exact accepted V1 source before logout')
    const priorSourceAccount = `session-v1:${prior.session.accepted.record.frame.source.sourceRef}`
    const cleanupEntered = gate()
    const cleanupRelease = gate()
    const deletePassword = boundary.deletePassword.getMockImplementation()
    const setPassword = boundary.setPassword.getMockImplementation()
    if (!deletePassword || !setPassword) throw new Error('Keytar fixture is not configured')
    boundary.deletePassword.mockImplementation(async (service, account) => {
      if (account === priorSourceAccount) {
        cleanupEntered.resolve()
        await cleanupRelease.promise
      }
      return deletePassword(service, account)
    })
    const freshMe = { ...homeMe, id: 'fixture-canceled-new-user' }
    vi.mocked(h.state.authClient.getMe).mockImplementation(async token =>
      token === freshToken ? freshMe : homeMe
    )
    const freshCandidateWritten = gate()
    boundary.setPassword.mockImplementation(async (service, account, value) => {
      if (value.includes(freshToken)) freshCandidateWritten.resolve()
      return setPassword(service, account, value)
    })
    const logout = own(h.service.logout())
    let freshLogin: Promise<unknown> | undefined
    let logoutCleanup: Promise<void> | null = null
    try {
      await expect(logout).resolves.toMatchObject({ kind: 'committed' })
      logoutCleanup = (
        h.service as unknown as { sessionAuthorityCleanupInFlight: Promise<void> | null }
      ).sessionAuthorityCleanupInFlight
      await vi.waitFor(() =>
        expect(boundary.deletePassword).toHaveBeenCalledWith(expect.any(String), priorSourceAccount)
      )
      freshLogin = own(h.state.installAuthenticatedLogin({ token: freshToken, me: freshMe }))
      await entered(
        freshCandidateWritten.promise,
        freshLogin,
        'fresh candidate publication while exact prior-source cleanup is delayed'
      )
    } finally {
      cleanupRelease.resolve()
    }
    await expect(freshLogin).resolves.toEqual({ authenticated: true, me: freshMe })
    await logoutCleanup
    expect(h.reportFailure).not.toHaveBeenCalled()
    await vi.waitFor(() =>
      expect(
        [...boundary.credentials.keys()].some(key => key.endsWith(`::${priorSourceAccount}`))
      ).toBe(false)
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
    const selected = await readSessionAuthoritySourceSelection({
      tokenStore: restarted.tokenStore,
      envKey: h.envKey,
    })
    expect(selected.status).toBe('accepted')
    if (selected.status !== 'accepted') throw new Error('Fresh source did not remain selected')
    expect(selected.session.token).toBe(freshToken)
    expect(
      selected.session.accepted.record.cleanupDebts.map(debt => debt.source.sourceRef)
    ).toEqual([priorSourceAccount.slice('session-v1:'.length)])
    expect(
      h.markers.readPendingExternalLogoutMarker(boundary.directory, h.envKey)?.intent.intent
    ).toBe('acceptance-pending')
  })

  it('M12 keeps the exact prior source selected after a rejected candidate and restart', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    boundary.setPassword.mockImplementation(async (service, account, token) => {
      if (token === otherToken) boundary.credentials.set(accountKey(service, account), token)
      throw new Error('fixture-native partial write or rollback failure')
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
    const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
    const prior = await readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(prior.status).toBe('accepted')
    if (prior.status !== 'accepted') throw new Error('Rejected candidate displaced prior source')
    expect(prior.session.token).toBe(homeToken)
    expect(prior.session.accepted.record.frame.source).toMatchObject({
      format: 'v1',
      kind: 'keytar',
      accountId: homeMe.id,
      storedValueDigest: expect.any(String),
    })
    expect(await h.tokenStore.getKeytarSessionToken(h.envKey)).toBeNull()
    expect(prior.session.accepted.record.frame.source?.kind).toBe('keytar')
    expect(await h.tokenStore.getSafeStorageSessionToken(h.envKey)).toBeNull()
    const projectedMarker = h.markers.observePendingExternalLogoutRaw(boundary.directory, h.envKey)
    expect(projectedMarker.marker?.intent.intent).toBe('acceptance-pending')
    expect(projectedMarker.rawContents).toBe(
      JSON.stringify(prior.session.accepted.record.projectionReceipt?.marker)
    )
    expect([...boundary.credentials.values()]).not.toContain(otherToken)
    expect(error).toBeInstanceOf(Error)
  })

  it('accepts a persistent team candidate before runtime publication and restores that exact source', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })

    await expect(h.service.switchTeam('fixture-other')).resolves.toEqual({
      authenticated: true,
      me: { ...homeMe, teamId: 'fixture-other' },
    })
    expect(h.state.sessionToken).toBe(otherToken)
    const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
    const selected = await readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(selected.status).toBe('accepted')
    if (selected.status !== 'accepted') throw new Error('Expected an accepted team source')
    expect(selected.session.token).toBe(otherToken)
    expect(selected.session.accepted.record.frame.source?.format).toBe('v1')

    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: { ...homeMe, teamId: 'fixture-other' },
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(otherToken)
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(homeToken)
  })

  it('M13 keeps an unremoved rejected V1 candidate denied beside the exact accepted V1 source', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    let candidateAccount: string | undefined
    let candidateValue: string | undefined
    const setPassword = boundary.setPassword.getMockImplementation()
    const deletePassword = boundary.deletePassword.getMockImplementation()
    if (!setPassword || !deletePassword) throw new Error('Keytar fixture is not configured')
    boundary.setPassword.mockImplementation(async (service, account, value) => {
      if (account.startsWith('session-v1:')) {
        candidateAccount = account
        candidateValue = value
        boundary.credentials.set(accountKey(service, account), value)
        throw new Error('fixture candidate setter rejected after publication')
      }
      return setPassword(service, account, value)
    })
    boundary.deletePassword.mockImplementation(async (service, account) => {
      if (account === candidateAccount) throw new Error('fixture candidate cleanup unavailable')
      return deletePassword(service, account)
    })
    const error = await h.service.switchTeam('fixture-other').then(
      () => null,
      error => error
    )
    expect(candidateAccount).toBeDefined()
    expect(candidateValue).toBeDefined()
    expect(JSON.parse(candidateValue!).sessionToken).toBe(otherToken)

    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: homeMe,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(homeToken)
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(otherToken)
    const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
    const selection = await readSessionAuthoritySourceSelection({
      tokenStore: restarted.tokenStore,
      envKey: h.envKey,
    })
    expect(selection.status).toBe('accepted')
    if (selection.status !== 'accepted') throw new Error('Prior source is not authoritative')
    expect(selection.session.token).toBe(homeToken)
    expect(
      selection.session.accepted.record.candidates.some(
        candidate =>
          candidate.phase === 'cleanup-pending' &&
          candidate.sourceRef === candidateAccount!.slice('session-v1:'.length)
      )
    ).toBe(true)
    expect(h.state.sessionToken).toBe(homeToken)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain('rejected after publication')
  })

  it.each(['canceled-retry', 'startup'] as const)(
    '%s denies the exact logged-out source after one cleanup attempt, then accepts fresh auth',
    async operation => {
      const h = await harness()
      await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
      const { readSessionAuthoritySourceSelection } =
        await import('../sessionAuthorityAcceptance.js')
      const prior = await readSessionAuthoritySourceSelection({
        tokenStore: h.tokenStore,
        envKey: h.envKey,
      })
      expect(prior.status).toBe('accepted')
      if (
        prior.status !== 'accepted' ||
        prior.session.accepted.record.frame.source?.format !== 'v1'
      )
        throw new Error('Expected an exact V1 source before logout')
      const priorSourceAccount = `session-v1:${prior.session.accepted.record.frame.source.sourceRef}`
      const deletePassword = boundary.deletePassword.getMockImplementation()
      if (!deletePassword) throw new Error('Keytar fixture is not configured')
      let exactDeleteAttempts = 0
      boundary.deletePassword.mockImplementation(async (service, account) => {
        if (account === priorSourceAccount) {
          exactDeleteAttempts += 1
          if (exactDeleteAttempts === 1) throw new Error('fixture exact-source cleanup unavailable')
        }
        return deletePassword(service, account)
      })
      const logout = own(h.service.logout())
      await expect(logout).resolves.toMatchObject({ kind: 'committed' })
      await vi.waitFor(() => expect(exactDeleteAttempts).toBe(1))
      await vi.waitFor(() => expect(h.reportFailure).toHaveBeenCalled())
      const denied = await readSessionAuthoritySourceSelection({
        tokenStore: h.tokenStore,
        envKey: h.envKey,
      })
      expect(denied).toMatchObject({ status: 'denied', frameMode: 'logged-out' })
      const loggedOutAuthority = await readAuthorityRecord(h.tokenStore, h.envKey)
      expect(loggedOutAuthority.frame.mode).toBe('logged-out')
      expect(loggedOutAuthority.cleanupDebts).toHaveLength(1)
      expect(loggedOutAuthority.cleanupDebts[0]?.source).toMatchObject({
        format: 'v1',
        kind: 'keytar',
      })

      let freshProducer = h
      if (operation === 'canceled-retry') {
        await h.service.prepareForQuit()
        h.service.cancelQuitPreparation()
        await expect(h.service.applyPendingExternalLogoutIntent()).resolves.toBe(true)
      } else {
        freshProducer = await harness()
        await expect(freshProducer.service.initialize()).resolves.toEqual({
          authenticated: false,
          me: null,
        })
        expect(freshProducer.state.authClient.getMe).not.toHaveBeenCalled()
      }
      await vi.waitFor(() => expect(exactDeleteAttempts).toBe(1))
      const freshMe = { ...homeMe, id: 'fixture-new-user' }
      vi.mocked(freshProducer.state.authClient.getMe).mockImplementation(async token =>
        token === freshToken ? freshMe : homeMe
      )
      await expect(
        freshProducer.state.installAuthenticatedLogin({ token: freshToken, me: freshMe })
      ).resolves.toEqual({ authenticated: true, me: freshMe })
      const restarted = await harness()
      vi.mocked(restarted.state.authClient.getMe).mockResolvedValue(freshMe)
      await expect(restarted.service.initialize()).resolves.toEqual({
        authenticated: true,
        me: freshMe,
      })
      expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(freshToken)
      expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(homeToken)
      expect(freshProducer.state.sessionToken).toBe(freshToken)
      expect(freshProducer.state.me).toEqual(freshMe)
    }
  )

  it('preserves a newer accepted candidate when a stale login cannot authorize fallback (M28)', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    const staleNativeEntered = gate()
    const staleNativeRelease = gate()
    const freshNativeEntered = gate()
    const freshAuthDispatched = gate()
    const setPassword = boundary.setPassword.getMockImplementation()
    const deletePassword = boundary.deletePassword.getMockImplementation()
    if (!setPassword || !deletePassword) throw new Error('Keytar fixture is not configured')
    let staleSourceAccount: string | undefined
    boundary.setPassword.mockImplementation(async (service, account, value) => {
      if (value.includes(otherToken)) {
        staleSourceAccount = account
        boundary.credentials.set(accountKey(service, account), value)
        staleNativeEntered.resolve()
        await staleNativeRelease.promise
        throw new Error('fixture-stale login native write rejected')
      }
      const result = await setPassword(service, account, value)
      if (value.includes(freshToken)) freshNativeEntered.resolve()
      return result
    })
    boundary.deletePassword.mockImplementation(async (service, account) => {
      if (account === staleSourceAccount)
        throw new Error('fixture stale-candidate cleanup unavailable')
      return deletePassword(service, account)
    })
    const staleLogin = own(
      h.state.installAuthenticatedLogin({
        token: otherToken,
        me: { ...homeMe, id: 'rejected-user' },
      })
    )
    const staleOutcome = staleLogin.then(
      () => null,
      error => error
    )
    try {
      await entered(staleNativeEntered.promise, staleLogin, 'stale login candidate setter')
      const freshMe = { ...homeMe, id: 'fixture-new-user' }
      vi.mocked(h.state.authClient.getMe).mockImplementation(async token =>
        token === freshToken
          ? freshMe
          : { ...homeMe, id: token === otherToken ? 'rejected-user' : homeMe.id }
      )
      vi.spyOn(h.state.authClient, 'passwordLogin').mockImplementation(async () => {
        freshAuthDispatched.resolve()
        return { token: freshToken, me: freshMe }
      })
      const freshLogin = own(h.service.passwordLogin('new-user@example.com', 'fixture-password'))
      await entered(
        freshAuthDispatched.promise,
        freshLogin,
        'newer public password authentication request'
      )
      staleNativeRelease.resolve()
      await entered(freshNativeEntered.promise, freshLogin, 'newer login candidate setter')
      await expect(freshLogin).resolves.toEqual({ authenticated: true, me: freshMe })
    } finally {
      staleNativeRelease.resolve()
    }
    const error = await staleOutcome
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
    const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
    const selected = await readSessionAuthoritySourceSelection({
      tokenStore: restarted.tokenStore,
      envKey: h.envKey,
    })
    expect(selected.status).toBe('accepted')
    if (selected.status !== 'accepted') throw new Error('Newer candidate did not remain selected')
    expect(selected.session.token).toBe(freshToken)
    expect(staleSourceAccount).toBeDefined()
    expect(
      selected.session.accepted.record.candidates.some(
        candidate =>
          candidate.phase === 'cleanup-pending' &&
          candidate.sourceRef === staleSourceAccount?.slice('session-v1:'.length)
      )
    ).toBe(true)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain('fixture-stale login native write rejected')
  })

  it.each(['team', 'login'] as const)(
    'a real logout supersedes an in-flight %s candidate and restart remains denied',
    async operation => {
      const h = await harness()
      await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
      const nativeEntered = gate()
      const nativeRelease = gate()
      const setPassword = boundary.setPassword.getMockImplementation()
      if (!setPassword) throw new Error('Keytar fixture is not configured')
      boundary.setPassword.mockImplementationOnce(async (service, account, token) => {
        boundary.credentials.set(accountKey(service, account), token)
        nativeEntered.resolve()
        await nativeRelease.promise
        return setPassword(service, account, token)
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
      // The public logout producer installs its in-memory cancellation fence before it
      // joins the session/native queues. The candidate may therefore finish its native
      // call but must lose before authority acceptance.
      const logout = own(h.service.logout())
      try {
        nativeRelease.resolve()
        const error = await outcome
        expect(error).toBeInstanceOf(Error)
        await expect(logout).resolves.toMatchObject({ kind: 'committed' })
      } finally {
        nativeRelease.resolve()
      }
      expect(h.state.sessionToken).toBeNull()
      expect(h.state.me).toBeNull()
      expect(h.markers.readPendingExternalLogoutIntent(boundary.directory, h.envKey)).toEqual({
        intent: 'logout-pending',
      })
      const { readSessionAuthoritySourceSelection } =
        await import('../sessionAuthorityAcceptance.js')
      expect(
        await readSessionAuthoritySourceSelection({ tokenStore: h.tokenStore, envKey: h.envKey })
      ).toMatchObject({ status: 'denied', frameMode: 'logged-out' })
      const restarted = await harness()
      await expect(restarted.service.initialize()).resolves.toEqual({
        authenticated: false,
        me: null,
      })
      expect(restarted.state.authClient.getMe).not.toHaveBeenCalled()
      expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(homeToken)
      expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(otherToken)
      expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(freshToken)
    }
  )
})
