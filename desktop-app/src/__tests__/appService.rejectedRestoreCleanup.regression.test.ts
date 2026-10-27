import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

const tokenWithExpiry = (id: string) => {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, jti: id })
  ).toString('base64url')
  return `header.${payload}.signature`
}
const homeToken = tokenWithExpiry('fixture-r21-home-session')
const teamToken = tokenWithExpiry('fixture-r21-team-session')
const homeMe = {
  id: 'fixture-r21-user',
  email: 'fixture-r21@example.com',
  name: null,
  picture: null,
  teamId: 'fixture-home',
  teamName: 'Fixture home',
  role: 'member',
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
    externalRestApiBaseUrl: 'https://auth.r9-m2.test/api',
    rpcProxyBaseUrl: 'https://rpc.r9-m2.test',
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
      getDesktopEnvironment: () => Promise<{
        appName: string
        externalRestApiBaseUrl: string
        rpcProxyBaseUrl: string
      }>
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
  const acceptance = await import('../sessionAuthorityAcceptance.js')
  return { service, tokenStore, markers, envKey, state, reportFailure, acceptance }
}

async function loginWithPassword(
  h: Awaited<ReturnType<typeof harness>>,
  token: string,
  me: typeof homeMe
) {
  vi.spyOn(h.state.authClient, 'passwordLogin').mockResolvedValueOnce({ token, me })
  return h.service.passwordLogin(me.email, 'fixture-password')
}

async function expectSelectedSession(h: Awaited<ReturnType<typeof harness>>, token: string) {
  const selected = await h.acceptance.readSessionAuthoritySourceSelection({
    tokenStore: h.tokenStore,
    envKey: h.envKey,
  })
  const status =
    selected.status === 'denied' ? `${selected.status}:${selected.frameMode}` : selected.status
  expect(status).toBe('accepted')
  if (selected.status !== 'accepted') throw new Error('Expected accepted session authority')
  expect(selected.session.token).toBe(token)
  expect(selected.session.accepted.record.frame.source?.format).toBe('v1')
  const projection = selected.session.accepted.record.projectionReceipt
  expect(projection).not.toBeNull()
  return h.markers.acceptancePendingExternalMarker(projection!.marker)
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

async function enteredWithin(promise: Promise<void>, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const entered = await Promise.race([
      promise.then(() => true),
      new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), 2000)
      }),
    ])
    expect(entered, `producer reached ${label}`).toBe(true)
  } finally {
    clearTimeout(timer)
  }
}

describe('R9-M2 rejected restore cleanup preserves independent accepted producers', () => {
  it('preserves a fresh encrypted CP-S login while older rejected cleanup awaits dispatch', async () => {
    // The source switch is authorized only when Keytar is unavailable before native dispatch.
    const config = await import('../config.js')
    await config.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: 'https://auth.example.test/api',
      rpcProxyBaseUrl: 'https://rpc.example.test',
    })
    vi.doMock('keytar', () => ({}))
    const seed = await harness()
    await expect(loginWithPassword(seed, homeToken, homeMe)).resolves.toMatchObject({
      authenticated: true,
      me: homeMe,
    })
    const seededSelection = await seed.acceptance.readSessionAuthoritySourceSelection({
      tokenStore: seed.tokenStore,
      envKey: seed.envKey,
    })
    expect(seededSelection.status).toBe('accepted')
    if (seededSelection.status !== 'accepted')
      throw new Error('Expected the password producer to pin its V1 source')
    const originalSource = seededSelection.session.accepted.record.frame.source
    expect(originalSource).toMatchObject({ format: 'v1', kind: 'safe-storage' })
    const old = await harness()
    vi.spyOn(old.state.authClient, 'getDesktopEnvironment').mockResolvedValue({
      appName: 'Fixture',
      externalRestApiBaseUrl: 'https://auth.example.test/api',
      rpcProxyBaseUrl: 'https://rpc.example.test',
    })
    const { ApiError } = await import('../httpClient.js')
    const started = deferred()
    const release = deferred()
    const fresh = tokenWithExpiry('fixture-newer-encrypted-login')
    const freshMe = { ...homeMe, id: 'fixture-newer-user' }
    let rejected = false
    let held = false
    const delayRejectedCleanup = async () => {
      if (rejected && !held) {
        held = true
        started.resolve()
        await release.promise
      }
    }
    // Hold the real exact-debt deletion after LP is durable, then let a newer accepted
    // producer publish before the stale cleanup resumes.
    const deleteExact = old.tokenStore.deleteSessionCredentialSourceIfUnselectedWithProof.bind(
      old.tokenStore
    )
    let rejectedSource: Parameters<
      typeof old.tokenStore.deleteSessionCredentialSourceIfUnselectedWithProof
    >[0]
    const cleanupAttempts: string[] = []
    vi.spyOn(
      old.tokenStore,
      'deleteSessionCredentialSourceIfUnselectedWithProof'
    ).mockImplementation(async (...args) => {
      rejectedSource = args[0]
      cleanupAttempts.push(`${args[0].format}:${args[0].kind}:${rejected}`)
      await delayRejectedCleanup()
      return deleteExact(...args)
    })
    vi.mocked(old.state.authClient.getMe).mockImplementationOnce(async () => {
      rejected = true
      throw new ApiError('fixture-expired saved Home', 401, 'unauthorized')
    })
    const restore = old.service.initialize()
    let login: Promise<unknown> | undefined
    const newer = await harness({ isolated: true })
    let winningMarker: ReturnType<typeof old.markers.readPendingExternalLogoutMarker>
    try {
      await enteredWithin(started.promise, 'old 401 cleanup awaiting exact dispatch')
      expect(rejectedSource).toEqual(originalSource)
      expect(rejectedSource).toMatchObject({
        format: 'v1',
        kind: 'safe-storage',
        envKey: old.envKey,
      })
      expect(cleanupAttempts).toContain('v1:safe-storage:true')
      const oldScope = await old.tokenStore.createSessionAuthorityStorageScope()
      const { SessionAuthorityRecordRepository } = await import('../sessionAuthorityRecord.js')
      const oldAuthority = new SessionAuthorityRecordRepository(
        oldScope,
        old.envKey,
        old.tokenStore
      )
      const oldRecord = oldAuthority.observe()
      expect(oldRecord.status).toBe('observed')
      if (oldRecord.status !== 'observed') throw new Error('Expected durable logout record')
      expect(oldRecord.record.cleanupDebts).toHaveLength(1)
      expect(oldRecord.record.cleanupDebts[0]?.source).toEqual(rejectedSource)

      vi.mocked(newer.state.authClient.getMe).mockResolvedValue(freshMe)
      login = loginWithPassword(newer, fresh, freshMe)
      await expect(login).resolves.toEqual({ authenticated: true, me: freshMe })
      const expectedWinningMarker = await expectSelectedSession(newer, fresh)
      await expect(newer.tokenStore.getSafeStorageSessionToken(newer.envKey)).resolves.toBeNull()
      expect(newer.state.sessionToken).toBe(fresh)
      winningMarker = newer.markers.readPendingExternalLogoutMarker(runtime.directory, newer.envKey)
      expect(winningMarker).toEqual(expectedWinningMarker)
    } finally {
      release.resolve()
      await Promise.allSettled([restore, login])
    }
    expect(held).toBe(true)
    const cleanup = (
      old.service as unknown as { sessionAuthorityCleanupInFlight: Promise<void> | null }
    ).sessionAuthorityCleanupInFlight
    await cleanup
    expect(old.reportFailure).not.toHaveBeenCalled()
    await expect(old.tokenStore.getSafeStorageSessionToken(old.envKey)).resolves.toBeNull()
    const settledScope = await old.tokenStore.createSessionAuthorityStorageScope()
    const { SessionAuthorityRecordRepository } = await import('../sessionAuthorityRecord.js')
    const settledRecord = new SessionAuthorityRecordRepository(
      settledScope,
      old.envKey,
      old.tokenStore
    ).observe()
    expect(settledRecord.status).toBe('observed')
    if (settledRecord.status !== 'observed')
      throw new Error('Expected newer authority after exact rejected-source cleanup')
    expect(settledRecord.record.cleanupDebts).not.toContainEqual(
      expect.objectContaining({ source: originalSource })
    )
    expect(newer.markers.readPendingExternalLogoutMarker(runtime.directory, newer.envKey)).toEqual(
      winningMarker!
    )
    const restarted = await harness()
    vi.mocked(restarted.state.authClient.getMe).mockImplementation(async token =>
      token === fresh ? freshMe : homeMe
    )
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: freshMe,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(fresh)
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(homeToken)
    expect(winningMarker).toEqual(await expectSelectedSession(newer, fresh))
    await expect(newer.tokenStore.getSafeStorageSessionToken(newer.envKey)).resolves.toBeNull()
    expect(newer.state.sessionToken).toBe(fresh)
    expect(newer.state.me).toEqual(freshMe)
  })

  it('preserves fresh native authority even when its marker remains absent', async () => {
    const seed = await harness()
    await seed.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    const old = await harness()
    const { ApiError } = await import('../httpClient.js')
    const started = deferred()
    const release = deferred()
    const fresh = tokenWithExpiry('fixture-newer-native-login')
    const freshMe = { ...homeMe, id: 'fixture-newer-native-user' }
    vi.mocked(old.state.authClient.getMe).mockImplementationOnce(async token => {
      expect(token).toBe(homeToken)
      started.resolve()
      await release.promise
      throw new ApiError('fixture-expired saved Home', 401, 'unauthorized')
    })
    const restore = old.service.initialize()
    let login: Promise<unknown> | undefined
    const newer = await harness()
    try {
      await enteredWithin(started.promise, 'old stored-session getMe rejection')
      vi.mocked(newer.state.authClient.getMe).mockResolvedValue(freshMe)
      login = loginWithPassword(newer, fresh, freshMe)
      await expect(login).resolves.toEqual({ authenticated: true, me: freshMe })
      const expectedWinningMarker = await expectSelectedSession(newer, fresh)
      expect(
        newer.markers.readPendingExternalLogoutMarker(runtime.directory, newer.envKey)
      ).toEqual(expectedWinningMarker)
    } finally {
      release.resolve()
      await Promise.allSettled([restore, login])
    }
    const restarted = await harness()
    vi.mocked(restarted.state.authClient.getMe).mockImplementation(async token =>
      token === fresh ? freshMe : homeMe
    )
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: freshMe,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(fresh)
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(homeToken)
    const expectedWinningMarker = await expectSelectedSession(newer, fresh)
    expect(newer.markers.readPendingExternalLogoutMarker(runtime.directory, newer.envKey)).toEqual(
      expectedWinningMarker
    )
    expect(newer.state.sessionToken).toBe(fresh)
    expect(newer.state.me).toEqual(freshMe)
  })
})

describe('R9-M2 identical-value publication still has a newer owner', () => {
  it('preserves newly accepted same-value native authority after an older stored-session 401', async () => {
    const seed = await harness()
    await seed.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    const old = await harness()
    const { ApiError } = await import('../httpClient.js')
    const started = deferred()
    const release = deferred()
    vi.mocked(old.state.authClient.getMe).mockImplementationOnce(async token => {
      expect(token).toBe(homeToken)
      started.resolve()
      await release.promise
      throw new ApiError('fixture-older saved-session rejection', 401, 'unauthorized')
    })
    const restore = old.service.initialize()
    let login: Promise<unknown> | undefined
    const newer = await harness()
    try {
      await enteredWithin(started.promise, 'older same-value getMe')
      login = loginWithPassword(newer, homeToken, homeMe)
      await expect(login).resolves.toEqual({ authenticated: true, me: homeMe })
      const expectedWinningMarker = await expectSelectedSession(newer, homeToken)
      expect(
        newer.markers.readPendingExternalLogoutMarker(runtime.directory, newer.envKey)
      ).toEqual(expectedWinningMarker)
    } finally {
      release.resolve()
      await Promise.allSettled([restore, login])
    }
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: homeMe,
    })
    const expectedWinningMarker = await expectSelectedSession(newer, homeToken)
    expect(newer.state.sessionToken).toBe(homeToken)
    expect(newer.state.me).toEqual(homeMe)
    expect(newer.markers.readPendingExternalLogoutMarker(runtime.directory, newer.envKey)).toEqual(
      expectedWinningMarker
    )
  })

  it('requires fresh authentication instead of restoring isolated plaintext after restart', async () => {
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    const seed = await harness({ isolated: true })
    await seed.tokenStore.setSessionToken(homeToken, seed.envKey)

    const restarted = await harness({ isolated: true })
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalled()
    expect(restarted.state.sessionToken).toBeNull()
    expect(restarted.state.me).toBeNull()
  })
})
