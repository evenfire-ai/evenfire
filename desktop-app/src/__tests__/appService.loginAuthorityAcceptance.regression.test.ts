import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
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
  app: {
    getPath: () => boundary.directory,
    isReady: () => true,
    isPackaged: true,
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
    decryptString: (value: Buffer) => value.toString().replace(/^encrypted:/, ''),
  },
}))
vi.mock('../pluginSdkRuntime.js', () => ({
  tryGetPluginSdkRuntime: () => ({
    notifySessionChanged: boundary.notifySessionChanged,
    unpinAllSandboxUiSurfaces: vi.fn(),
  }),
}))

const homeToken = 'fixture-home-token'
const teamToken = 'fixture-team-token'
const replacementToken = 'fixture-replacement-token'
const temporaryHomeToken = validSessionToken('temporary-home')
const temporaryTeamToken = validSessionToken('temporary-team')
const homeUser = {
  id: 'login-owner-a',
  email: 'owner-a@example.test',
  name: 'Owner A',
  picture: null,
  teamId: 'home-team',
  teamName: 'Home',
  role: 'member' as const,
}
const teamUser = { ...homeUser, teamId: 'team-b', teamName: 'Team B' }
const replacementUser = {
  ...homeUser,
  id: 'login-owner-b',
  email: 'owner-b@example.test',
  teamId: 'team-b',
}

function validSessionToken(subject: string): string {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, sub: subject })
  ).toString('base64url')
  return `header.${payload}.signature`
}

let configPath = ''
let priorConfigPath: string | undefined
let chat: typeof import('../chatStoreBinding.js') | undefined

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  const { safeStorage } = await import('electron')
  vi.mocked(safeStorage.isEncryptionAvailable).mockReset().mockReturnValue(true)
  boundary.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-login-acceptance-'))
  boundary.keychain.clear()
  boundary.getPassword
    .mockReset()
    .mockImplementation(
      async (service, account) => boundary.keychain.get(keyOf(service, account)) ?? null
    )
  boundary.setPassword.mockReset().mockImplementation(async (service, account, value) => {
    boundary.keychain.set(keyOf(service, account), value)
  })
  boundary.deletePassword
    .mockReset()
    .mockImplementation(async (service, account) =>
      boundary.keychain.delete(keyOf(service, account))
    )
  priorConfigPath = process.env.CLERUM_DESKTOP_CONFIG_PATH
  configPath = path.join(boundary.directory, 'desktop-runtime.json')
  process.env.CLERUM_DESKTOP_CONFIG_PATH = configPath
  vi.doMock('keytar', () => boundary)
  const [{ __setChatStoreBaseDirForTests }, config] = await Promise.all([
    import('../chatStoreBinding.js'),
    import('../config.js'),
  ])
  __setChatStoreBaseDirForTests(path.join(boundary.directory, 'chats'))
  chat = await import('../chatStoreBinding.js')
  await config.saveDesktopRuntimeConfig({
    externalRestApiBaseUrl: 'https://api.example.test',
    rpcProxyBaseUrl: 'https://rpc.example.test',
  })
})

afterEach(async () => {
  await chat?.__waitForChatStoreMaintenanceForTests()
  chat?.unbindChatStore()
  chat?.__setChatStoreBaseDirForTests(null)
  vi.restoreAllMocks()
  vi.resetModules()
  if (priorConfigPath === undefined) delete process.env.CLERUM_DESKTOP_CONFIG_PATH
  else process.env.CLERUM_DESKTOP_CONFIG_PATH = priorConfigPath
  await fs.rm(boundary.directory, { recursive: true, force: true })
  boundary.keychain.clear()
})

async function harness() {
  const [{ AppService }, { TokenStore }, config, chatBinding, acceptance] = await Promise.all([
    import('../appService.js'),
    import('../tokenStore.js'),
    import('../config.js'),
    import('../chatStoreBinding.js'),
    import('../sessionAuthorityAcceptance.js'),
  ])
  const tokenStore = new TokenStore()
  const service = new AppService({
    tokenStore,
    getUserDataDirectory: () => boundary.directory,
    reportDeferredLogoutFailure: vi.fn(),
  })
  const state = service as unknown as {
    sessionToken: string | null
    me: typeof homeUser | null
    authClient: {
      getMe: (token: string) => Promise<typeof homeUser>
      switchTeam: (token: string, teamId: string) => Promise<{ token: string }>
      googleLogin: (idToken: string) => Promise<{ token: string; me: typeof homeUser }>
      passwordLogin: (
        email: string,
        password: string
      ) => Promise<{ token: string; me: typeof homeUser }>
    }
    installAuthenticatedLogin: (value: { token: string; me: typeof homeUser }) => Promise<unknown>
  }
  vi.spyOn(state.authClient, 'getMe').mockImplementation(async token => {
    if (token === teamToken) return teamUser
    if (token === replacementToken) return replacementUser
    return homeUser
  })
  vi.spyOn(state.authClient, 'switchTeam').mockResolvedValue({ token: teamToken })
  const envKey = config.getActiveEnvKey()
  const bindHome = async () => {
    await state.installAuthenticatedLogin({ token: homeToken, me: homeUser })
    await service.switchTeam('team-b')
    const selected = await acceptance.readSessionAuthoritySourceSelection({ tokenStore, envKey })
    expect(selected.status).toBe('accepted')
    if (selected.status !== 'accepted') throw new Error('Expected an accepted V1 source')
    expect(selected.session.accepted.record.frame.source?.format).toBe('v1')
    expect(selected.session.token).toBe(teamToken)
    return selected.session.accepted.record.frame.source
  }
  return { service, state, tokenStore, envKey, chatBinding, acceptance, config, bindHome }
}

/** Recreate module-owned coordinators and consumers while retaining only OS/store backing data. */
async function restartHarness() {
  chat?.unbindChatStore()
  vi.restoreAllMocks()
  vi.resetModules()
  vi.doMock('keytar', () => boundary)
  const [{ __setChatStoreBaseDirForTests }] = await Promise.all([
    import('../chatStoreBinding.js'),
    import('../config.js'),
  ])
  __setChatStoreBaseDirForTests(path.join(boundary.directory, 'chats'))
  chat = await import('../chatStoreBinding.js')
  return harness()
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

async function expectPhaseEntered(
  phase: Promise<unknown>,
  producer: Promise<unknown>,
  label: string
) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      phase.then(() => 'entered'),
      producer.then(
        () => 'producer-settled',
        () => 'producer-settled'
      ),
      new Promise<string>(resolve => {
        timer = setTimeout(() => resolve('deadline'), 5_000)
      }),
    ])
    expect(result, `${label} must be reached before restore settles`).toBe('entered')
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function injectIndeterminateAuthorityCommit(
  tokenStore: InstanceType<typeof import('../tokenStore.js').TokenStore>,
  envKey: string
) {
  const scope = await tokenStore.createSessionAuthorityStorageScope()
  const authorityFile = path.join(
    tokenStore.resolveSessionAuthorityStorageDirectory(scope),
    `session-authority-${createHash('sha256').update(envKey).digest('hex')}`
  )
  const { SessionAuthorityRecordRepository } = await import('../sessionAuthorityRecord.js')
  const acceptCandidate = SessionAuthorityRecordRepository.prototype.acceptCandidate
  const observed = {
    acceptanceStarted: false,
    authorityReplaced: false,
    directorySyncRejected: false,
  }
  let authorityDirectoryDescriptor: number | undefined
  vi.spyOn(SessionAuthorityRecordRepository.prototype, 'acceptCandidate').mockImplementation(
    function (this: InstanceType<typeof SessionAuthorityRecordRepository>, ...args) {
      observed.acceptanceStarted = true
      return acceptCandidate.apply(this, args)
    }
  )
  const rename = fsSync.renameSync.bind(fsSync)
  vi.spyOn(fsSync, 'renameSync').mockImplementation((source, destination) => {
    const result = rename(source, destination)
    if (observed.acceptanceStarted && path.resolve(String(destination)) === authorityFile)
      observed.authorityReplaced = true
    return result
  })
  const open = fsSync.openSync.bind(fsSync)
  vi.spyOn(fsSync, 'openSync').mockImplementation((file, flags, mode) => {
    const descriptor = open(file, flags, mode)
    if (observed.authorityReplaced && path.resolve(String(file)) === path.dirname(authorityFile))
      authorityDirectoryDescriptor = descriptor
    return descriptor
  })
  const sync = fsSync.fsyncSync.bind(fsSync)
  vi.spyOn(fsSync, 'fsyncSync').mockImplementation(descriptor => {
    if (
      observed.authorityReplaced &&
      !observed.directorySyncRejected &&
      descriptor === authorityDirectoryDescriptor &&
      fsSync.fstatSync(descriptor).isDirectory()
    ) {
      observed.directorySyncRejected = true
      throw Object.assign(new Error('fixture authority directory sync uncertainty'), {
        code: 'EIO',
      })
    }
    return sync(descriptor)
  })
  return observed
}

async function failNextProfileAuthorityRead(
  tokenStore: InstanceType<typeof import('../tokenStore.js').TokenStore>
) {
  const scope = await tokenStore.createSessionAuthorityStorageScope()
  const { PROFILE_SESSION_AUTHORITY_ENV_KEY } = await import('../sessionAuthorityRecord.js')
  const authorityFile = path.join(
    tokenStore.resolveSessionAuthorityStorageDirectory(scope),
    'session-authority-' +
      createHash('sha256').update(PROFILE_SESSION_AUTHORITY_ENV_KEY).digest('hex')
  )
  const open = fsSync.openSync.bind(fsSync)
  let failed = false
  vi.spyOn(fsSync, 'openSync').mockImplementation((file, flags, mode) => {
    if (!failed && path.resolve(String(file)) === authorityFile) {
      failed = true
      throw Object.assign(new Error('fixture profile authority read unavailable'), {
        code: 'EMFILE',
      })
    }
    return open(file, flags, mode)
  })
  return () => failed
}

describe('Stage 4 public login candidate acceptance', () => {
  async function addSecondEnvironment(h: Awaited<ReturnType<typeof harness>>) {
    const current = h.config.getDesktopRuntimeConfigState()
    const first = current.options.find(option => option.id === current.activeOptionId)
    if (!first) throw new Error('Expected the first saved environment')
    await h.config.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: 'https://api.other.example.test',
      rpcProxyBaseUrl: 'https://rpc.other.example.test',
      appName: 'Environment B',
    })
    const second = h.config
      .getDesktopRuntimeConfigState()
      .options.find(option => option.id !== first.id)
    if (!second) throw new Error('Expected the second saved environment')
    await h.config.selectDesktopRuntimeConfigOption(first.id)
    return { first, second }
  }

  it('atomically replaces the profile-wide active environment after accepted login', async () => {
    const h = await harness()
    vi.spyOn(h.state.authClient, 'passwordLogin').mockResolvedValueOnce({
      token: homeToken,
      me: homeUser,
    })
    await h.service.passwordLogin('owner-a@example.test', 'fixture-password')
    const { second } = await addSecondEnvironment(h)
    const logout = await h.service.logout()
    if (logout.kind !== 'committed')
      throw new Error('logout did not commit before environment selection')
    const handoff = await h.service.selectRuntimeConfigForHandoff(
      second.id,
      logout.sessionGeneration
    )
    const envB = handoff.runtimeConfigState.envKey
    expect(envB).not.toBe(h.envKey)
    expect(h.state.sessionToken).toBeNull()
    vi.spyOn(h.state.authClient, 'passwordLogin').mockResolvedValueOnce({
      token: replacementToken,
      me: replacementUser,
    })

    await expect(
      h.service.passwordLogin('owner-b@example.test', 'fixture-password')
    ).resolves.toMatchObject({ authenticated: true, me: replacementUser })

    const selectedB = await h.acceptance.readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: envB,
    })
    expect(selectedB.status).toBe('accepted')
    if (selectedB.status !== 'accepted') throw new Error('Expected environment B to be selected')
    expect(selectedB.session.token).toBe(replacementToken)
    const { PROFILE_SESSION_AUTHORITY_ENV_KEY, SessionAuthorityRecordRepository } =
      await import('../sessionAuthorityRecord.js')
    const profileScope = await h.tokenStore.createSessionAuthorityStorageScope()
    const profile = new SessionAuthorityRecordRepository(
      profileScope,
      PROFILE_SESSION_AUTHORITY_ENV_KEY,
      h.tokenStore
    ).observeProfileSelection()
    expect(profile.status).toBe('observed')
    if (profile.status !== 'observed') throw new Error('Expected profile-wide active selection')
    expect(profile.selection).toMatchObject({
      state: 'active',
      mode: 'persistent',
      envKey: envB,
      userId: replacementUser.id,
      teamId: replacementUser.teamId,
      source: selectedB.session.accepted.record.frame.source,
      transactionId: selectedB.session.accepted.record.frame.transactionId,
    })
    expect(
      await h.acceptance.readSessionAuthoritySourceSelection({
        tokenStore: h.tokenStore,
        envKey: h.envKey,
      })
    ).toEqual({ status: 'denied', frameMode: 'logged-out' })
  })

  it('stays signed out when login fails after logout and environment selection', async () => {
    const h = await harness()
    vi.spyOn(h.state.authClient, 'passwordLogin').mockResolvedValueOnce({
      token: homeToken,
      me: homeUser,
    })
    await h.service.passwordLogin('owner-a@example.test', 'fixture-password')
    const { second } = await addSecondEnvironment(h)
    const logout = await h.service.logout()
    if (logout.kind !== 'committed')
      throw new Error('logout did not commit before environment selection')
    const handoff = await h.service.selectRuntimeConfigForHandoff(
      second.id,
      logout.sessionGeneration
    )
    const envB = handoff.runtimeConfigState.envKey
    expect(envB).not.toBe(h.envKey)
    vi.spyOn(h.state.authClient, 'passwordLogin').mockRejectedValueOnce(
      new Error('synthetic rejected login')
    )

    await expect(
      h.service.passwordLogin('owner-b@example.test', 'fixture-password')
    ).rejects.toThrow('synthetic rejected login')
    expect(h.state.sessionToken).toBeNull()
    expect(h.state.me).toBeNull()
    expect(h.config.getActiveEnvKey()).toBe(envB)
    const { PROFILE_SESSION_AUTHORITY_ENV_KEY, SessionAuthorityRecordRepository } =
      await import('../sessionAuthorityRecord.js')
    const profileScope = await h.tokenStore.createSessionAuthorityStorageScope()
    const profile = new SessionAuthorityRecordRepository(
      profileScope,
      PROFILE_SESSION_AUTHORITY_ENV_KEY,
      h.tokenStore
    ).observeProfileSelection()
    expect(profile.status).toBe('observed')
    if (profile.status !== 'observed')
      throw new Error('Expected profile selection to be observable')
    expect(profile.selection.state).not.toBe('active')
    expect(
      await h.acceptance.readSessionAuthoritySourceSelection({
        tokenStore: h.tokenStore,
        envKey: h.envKey,
      })
    ).toEqual({ status: 'denied', frameMode: 'logged-out' })
    expect(
      await h.acceptance.readSessionAuthoritySourceSelection({
        tokenStore: h.tokenStore,
        envKey: envB,
      })
    ).toEqual({ status: 'denied', frameMode: 'logged-out' })

    const restarted = await restartHarness()
    await expect(restarted.service.initialize()).resolves.toMatchObject({ authenticated: false })
    expect(restarted.config.getActiveEnvKey()).toBe(envB)
    expect(restarted.state.sessionToken).toBeNull()
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalled()
  })

  it('accepts fresh V1 authentication without importing an old safeStorage credential', async () => {
    const h = await harness()
    const oldToken = 'fixture-cp-s-previous-user'
    const freshToken = 'fixture-cp-s-fresh-user'
    const freshMe = { ...homeUser, id: 'fixture-cp-s-fresh-account' }
    await h.tokenStore.setSafeStorageSessionToken(oldToken, h.envKey)
    const markers = await import('../pendingExternalLogout.js')

    vi.spyOn(h.state.authClient, 'passwordLogin').mockResolvedValueOnce({
      token: freshToken,
      me: freshMe,
    })
    vi.spyOn(h.state.authClient, 'getMe').mockImplementation(async token => {
      if (token === freshToken) return freshMe
      if (token === oldToken) return homeUser
      throw new Error(`Unexpected identity validation for ${token}`)
    })

    await expect(
      h.service.passwordLogin('fixture@example.test', 'fixture-password')
    ).resolves.toMatchObject({ authenticated: true, me: freshMe })

    const selected = await h.acceptance.readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(selected.status).toBe('accepted')
    if (selected.status === 'accepted') {
      expect(selected.session.token).toBe(freshToken)
      expect(selected.session.accepted.record.frame.source?.format).toBe('v1')
    }
    expect(markers.readPendingExternalLogoutMarker(boundary.directory, h.envKey)).toMatchObject({
      intent: { intent: 'acceptance-pending' },
    })
    await expect(h.tokenStore.getSafeStorageSessionToken(h.envKey)).resolves.toBe(oldToken)
    expect(h.state.authClient.getMe).toHaveBeenCalledWith(freshToken)

    h.chatBinding.unbindChatStore()
    const restarted = await restartHarness()
    vi.spyOn(restarted.state.authClient, 'getMe').mockResolvedValue(freshMe)
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: freshMe,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(freshToken)
    await expect(restarted.tokenStore.getSafeStorageSessionToken(restarted.envKey)).resolves.toBe(
      oldToken
    )
  })

  it('does not reconcile an active candidate projection as crash residue', async () => {
    const h = await harness()
    vi.spyOn(h.state.authClient, 'passwordLogin').mockResolvedValueOnce({
      token: homeToken,
      me: homeUser,
    })
    await h.service.passwordLogin('owner-a@example.test', 'fixture-password')

    const { SessionAuthorityAcceptanceTransaction } =
      await import('../sessionAuthorityAcceptance.js')
    const transactionPrototype = SessionAuthorityAcceptanceTransaction.prototype as unknown as {
      prepareAcceptanceProjection: (
        this: { input: { token: string } },
        isStillOwned: () => boolean
      ) => Promise<void>
    }
    const originalPrepare = transactionPrototype.prepareAcceptanceProjection
    const projectionPrepared = deferred<void>()
    const releaseProjection = deferred<void>()
    vi.spyOn(transactionPrototype, 'prepareAcceptanceProjection').mockImplementation(
      async function (this: { input: { token: string } }, isStillOwned: () => boolean) {
        await originalPrepare.call(this, isStillOwned)
        if (this.input.token === replacementToken) {
          projectionPrepared.resolve()
          await releaseProjection.promise
        }
      }
    )
    vi.spyOn(h.state.authClient, 'passwordLogin').mockResolvedValueOnce({
      token: replacementToken,
      me: replacementUser,
    })

    const replacement = h.service.passwordLogin('owner-b@example.test', 'fixture-password')
    await expectPhaseEntered(projectionPrepared.promise, replacement, 'candidate projection')

    const markers = await import('../pendingExternalLogout.js')
    const markerBefore = markers.observePendingExternalLogoutRaw(boundary.directory, h.envKey)
    expect(markerBefore.marker?.intent.intent).toBe('acceptance-pending')
    await SessionAuthorityAcceptanceTransaction.reconcilePendingAcceptanceProjection(
      h.tokenStore,
      boundary.directory,
      h.envKey,
      (await import('../config.js')).getActiveLegacyEnvKeys()
    )
    expect(markers.observePendingExternalLogoutRaw(boundary.directory, h.envKey)).toEqual(
      markerBefore
    )

    releaseProjection.resolve()
    await expect(replacement).resolves.toEqual({
      authenticated: true,
      me: replacementUser,
    })
    const selected = await h.acceptance.readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(selected.status).toBe('accepted')
    if (selected.status !== 'accepted') throw new Error('Expected replacement source B')
    expect(selected.session.token).toBe(replacementToken)
  })

  it('replaces V0 authority through fresh login and leaves old Keytar bytes untouched', async () => {
    const h = await harness()
    const legacyAccount = `session-token::${h.envKey}`
    await h.tokenStore.setSessionToken(homeToken, h.envKey)
    vi.spyOn(h.state.authClient, 'passwordLogin').mockResolvedValueOnce({
      token: replacementToken,
      me: replacementUser,
    })

    await expect(
      h.service.passwordLogin('owner-b@example.test', 'fixture-password')
    ).resolves.toMatchObject({ authenticated: true, me: replacementUser })
    expect(h.state.authClient.getMe).toHaveBeenCalledWith(replacementToken)
    expect(boundary.keychain.get(keyOf('Evenfire', legacyAccount))).toBe(homeToken)
    expect([...boundary.keychain.keys()].some(account => account.includes('session-v1:'))).toBe(
      true
    )

    const markers = await import('../pendingExternalLogout.js')
    expect(
      markers.observePendingExternalLogoutRaw(boundary.directory, h.envKey).marker
    ).toMatchObject({
      intent: { intent: 'acceptance-pending' },
    })
    const scope = await h.tokenStore.createSessionAuthorityStorageScope()
    const { SessionAuthorityRecordRepository } = await import('../sessionAuthorityRecord.js')
    const observation = new SessionAuthorityRecordRepository(
      scope,
      h.envKey,
      h.tokenStore
    ).observe()
    expect(observation.status).toBe('observed')
    if (observation.status === 'observed')
      expect(observation.record.frame.source?.format).toBe('v1')

    h.chatBinding.unbindChatStore()
    const restarted = await restartHarness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: replacementUser,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledTimes(1)
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(replacementToken)
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(homeToken)
  })

  it('ignores a historical V0 Keytar credential without credential publication', async () => {
    const h = await harness()
    const legacyAccount = `session-token::${h.envKey}`
    await h.tokenStore.setSessionToken(homeToken, h.envKey)
    boundary.setPassword.mockClear()
    const { SessionAuthorityAcceptanceTransaction } =
      await import('../sessionAuthorityAcceptance.js')
    const restoreExisting = vi.spyOn(SessionAuthorityAcceptanceTransaction, 'beginRestoreExisting')
    await expect(h.service.initialize()).resolves.toEqual({ authenticated: false, me: null })
    expect(restoreExisting).not.toHaveBeenCalled()

    const accepted = await h.acceptance.readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(accepted.status).not.toBe('accepted')
    expect(boundary.keychain.get(keyOf('Evenfire', legacyAccount))).toBe(homeToken)
    expect([...boundary.keychain.keys()].some(account => account.includes('session-v1:'))).toBe(
      false
    )
    expect(boundary.setPassword).not.toHaveBeenCalled()

    h.chatBinding.unbindChatStore()
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalled()
    expect([...boundary.keychain.keys()].some(account => account.includes('session-v1:'))).toBe(
      false
    )
  })

  it('keeps historical V0 credentials out of restore consumer staging', async () => {
    const h = await harness()
    const legacyAccount = `session-token::${h.envKey}`
    await h.tokenStore.setSessionToken(homeToken, h.envKey)
    boundary.setPassword.mockClear()
    await expect(h.service.initialize()).resolves.toEqual({ authenticated: false, me: null })
    expect(h.state.authClient.getMe).not.toHaveBeenCalled()

    const selected = await h.acceptance.readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(selected.status).not.toBe('accepted')
    expect(boundary.keychain.get(keyOf('Evenfire', legacyAccount))).toBe(homeToken)
    expect([...boundary.keychain.keys()].some(account => account.includes('session-v1:'))).toBe(
      false
    )
    expect(boundary.setPassword).not.toHaveBeenCalled()
    expect(() => h.chatBinding.requireChatStore()).toThrow('Not authenticated')

    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalled()
    expect([...boundary.keychain.keys()].some(account => account.includes('session-v1:'))).toBe(
      false
    )
  })

  it('ignores a historical V0 safeStorage credential without rewriting it', async () => {
    const h = await harness()
    await h.tokenStore.setSafeStorageSessionToken(homeToken, h.envKey)
    const setKeytar = vi.spyOn(h.tokenStore, 'setSessionToken')
    const setSafeStorage = vi.spyOn(h.tokenStore, 'setSafeStorageSessionToken')
    const { SessionAuthorityAcceptanceTransaction } =
      await import('../sessionAuthorityAcceptance.js')
    const restoreExisting = vi.spyOn(SessionAuthorityAcceptanceTransaction, 'beginRestoreExisting')
    setKeytar.mockClear()
    setSafeStorage.mockClear()

    await expect(h.service.initialize()).resolves.toEqual({ authenticated: false, me: null })
    expect(restoreExisting).not.toHaveBeenCalled()

    const selected = await h.acceptance.readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(selected.status).not.toBe('accepted')
    expect(setKeytar).not.toHaveBeenCalled()
    expect(setSafeStorage).not.toHaveBeenCalled()

    h.chatBinding.unbindChatStore()
    const restarted = await harness()
    const restoredSetKeytar = vi.spyOn(restarted.tokenStore, 'setSessionToken')
    const restoredSetSafeStorage = vi.spyOn(restarted.tokenStore, 'setSafeStorageSessionToken')
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalled()
    expect(restoredSetKeytar).not.toHaveBeenCalled()
    expect(restoredSetSafeStorage).not.toHaveBeenCalled()
  })

  it('does not delete an unrelated historical credential when no new session is active', async () => {
    const h = await harness()
    const legacyAccount = `session-token::${h.envKey}`
    await h.tokenStore.setSessionToken(homeToken, h.envKey)
    await expect(h.service.initialize()).resolves.toEqual({ authenticated: false, me: null })
    await expect(h.service.logout()).resolves.toMatchObject({ kind: 'not-committed' })
    expect(boundary.keychain.get(keyOf('Evenfire', legacyAccount))).toBe(homeToken)
    const markers = await import('../pendingExternalLogout.js')

    h.chatBinding.unbindChatStore()
    const restarted = await restartHarness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(homeToken)
    expect(restarted.state.sessionToken).toBeNull()
  })

  it('does not fall through to safeStorage after a transient Keytar restore observation', async () => {
    const h = await harness()
    await h.tokenStore.setSafeStorageSessionToken(homeToken, h.envKey)
    const encryptedPath = path.join(boundary.directory, `session-token-${h.envKey}.enc`)
    const encryptedBefore = await fs.readFile(encryptedPath)
    const { safeStorage } = await import('electron')
    const decrypt = vi.spyOn(safeStorage, 'decryptString')
    decrypt.mockClear()
    boundary.getPassword.mockRejectedValueOnce(
      Object.assign(new Error('fixture Keytar EMFILE'), { code: 'EMFILE' })
    )

    await expect(h.service.initialize()).resolves.toEqual({ authenticated: false, me: null })

    expect(h.state.authClient.getMe).not.toHaveBeenCalled()
    expect(decrypt).not.toHaveBeenCalled()
    expect(h.state.sessionToken).toBeNull()
    expect(h.state.me).toBeNull()
    expect(() => h.chatBinding.requireChatStore()).toThrow('Not authenticated')
    await expect(fs.readFile(encryptedPath)).resolves.toEqual(encryptedBefore)
  })

  it('keeps an unframed V0 source denied by the journal from reaching identity validation', async () => {
    const h = await harness()
    await h.tokenStore.setSessionToken(homeToken, h.envKey)
    const { SessionPersistenceProducer } = await import('../sessionPersistenceJournal.js')
    const deniedCandidate = new SessionPersistenceProducer(
      boundary.directory,
      h.envKey,
      null,
      () => {},
      () => {}
    )
    deniedCandidate.prepare('keytar', homeToken)

    await expect(h.service.initialize()).resolves.toEqual({ authenticated: false, me: null })

    expect(h.state.authClient.getMe).not.toHaveBeenCalled()
    expect(h.state.sessionToken).toBeNull()
    expect(h.state.me).toBeNull()
    expect(() => h.chatBinding.requireChatStore()).toThrow('Not authenticated')
    expect(boundary.keychain.get(keyOf('Evenfire', `session-token::${h.envKey}`))).toBe(homeToken)
    const authority = await h.acceptance.readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(authority).toEqual({ status: 'denied', frameMode: 'logged-out' })
  })

  it('does not publish a delayed V1 restore after a newer public login owns the runtime', async () => {
    const seed = await harness()
    vi.spyOn(seed.state.authClient, 'passwordLogin').mockResolvedValueOnce({
      token: homeToken,
      me: homeUser,
    })
    await expect(
      seed.service.passwordLogin('owner-a@example.test', 'fixture-password')
    ).resolves.toMatchObject({ authenticated: true, me: homeUser })
    seed.chatBinding.unbindChatStore()

    const h = await restartHarness()
    const getMeEntered = deferred<void>()
    const releaseRestoreIdentity = deferred<typeof homeUser>()
    vi.spyOn(h.state.authClient, 'getMe').mockImplementationOnce(async token => {
      expect(token).toBe(homeToken)
      getMeEntered.resolve()
      return releaseRestoreIdentity.promise
    })
    vi.spyOn(h.state.authClient, 'passwordLogin').mockResolvedValue({
      token: replacementToken,
      me: replacementUser,
    })

    const restoring = h.service.initialize()
    await getMeEntered.promise
    await expect(
      h.service.passwordLogin('fixture@example.test', 'fixture-password')
    ).resolves.toEqual({
      authenticated: true,
      me: replacementUser,
    })
    releaseRestoreIdentity.resolve(homeUser)

    await expect(restoring).resolves.toEqual({
      authenticated: true,
      me: replacementUser,
    })
    expect(h.state.sessionToken).toBe(replacementToken)
    expect(h.state.me).toEqual(replacementUser)
    expect(h.chatBinding.requireChatStore().getAuthorityScope()).toMatchObject({
      environmentKey: h.envKey,
      userId: replacementUser.id,
    })

    h.chatBinding.unbindChatStore()
    const restarted = await restartHarness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: replacementUser,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(replacementToken)
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(homeToken)
  })

  it('restores a public Google login from persistent Keytar with its chat owner binding', async () => {
    const h = await harness()
    const oauthUser = { ...homeUser, id: 'google-login-owner', email: 'google@example.test' }
    const oauthToken = 'fixture-google-persistent-token'
    vi.spyOn(h.state.authClient, 'googleLogin').mockResolvedValueOnce({
      token: oauthToken,
      me: oauthUser,
    })
    vi.spyOn(h.state.authClient, 'getMe').mockResolvedValue(oauthUser)

    await expect(h.service.googleLogin('fixture-google-id-token')).resolves.toEqual({
      authenticated: true,
      me: oauthUser,
    })
    const accepted = await h.acceptance.readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(accepted.status).toBe('accepted')
    if (accepted.status !== 'accepted') throw new Error('Expected persistent Google authority')
    const source = accepted.session.accepted.record.frame.source
    expect(accepted.session.token).toBe(oauthToken)
    expect(source).toMatchObject({
      format: 'v1',
      kind: 'keytar',
      accountId: oauthUser.id,
    })
    expect(boundary.setPassword).toHaveBeenCalled()
    expect(h.chatBinding.requireChatStore().getAuthorityScope()).toMatchObject({
      environmentKey: h.envKey,
      userId: oauthUser.id,
      teamId: oauthUser.teamId,
    })

    h.chatBinding.unbindChatStore()
    const restarted = await restartHarness()
    vi.spyOn(restarted.state.authClient, 'getMe').mockResolvedValue(oauthUser)
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: oauthUser,
    })
    expect(restarted.state.sessionToken).toBe(oauthToken)
    const restored = await restarted.acceptance.readSessionAuthoritySourceSelection({
      tokenStore: restarted.tokenStore,
      envKey: restarted.envKey,
    })
    expect(restored.status).toBe('accepted')
    if (restored.status !== 'accepted') throw new Error('Expected the same accepted Google owner')
    expect(restored.session.token).toBe(oauthToken)
    expect(restored.session.accepted.record.frame.source).toEqual(source)
    expect(restarted.chatBinding.requireChatStore().getAuthorityScope()).toMatchObject({
      environmentKey: restarted.envKey,
      userId: oauthUser.id,
      teamId: oauthUser.teamId,
    })
  })

  it('keeps temporary login independent from legacy Keytar inventory', async () => {
    const inaccessibleLegacyToken = 'legacy-token-hidden-by-keytar-acl'
    const h = await harness()
    await h.tokenStore.setSessionToken(inaccessibleLegacyToken, h.envKey)
    const legacyAccount = keyOf('Evenfire', `session-token::${h.envKey}`)
    boundary.setPassword.mockClear()
    boundary.getPassword.mockRejectedValue(
      Object.assign(new Error('fixture access denied'), { code: 'EACCES' })
    )
    vi.spyOn(h.tokenStore, 'inspectVersionedKeytarCapability').mockResolvedValue('unknown')
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    const passwordLogin = vi.spyOn(h.state.authClient, 'passwordLogin').mockResolvedValue({
      token: temporaryHomeToken,
      me: homeUser,
    })

    await expect(
      h.service.passwordLogin('fixture@example.test', 'fixture-password')
    ).resolves.toMatchObject({ authenticated: true, me: homeUser })
    expect(passwordLogin).toHaveBeenCalledTimes(1)
    expect(h.state.authClient.getMe).toHaveBeenCalledWith(temporaryHomeToken)
    expect(h.state.sessionToken).toBe(temporaryHomeToken)
    expect(h.state.me).toEqual(homeUser)
    expect(() => h.chatBinding.requireChatStore().getAuthorityScope()).not.toThrow()
    expect(boundary.setPassword).not.toHaveBeenCalled()
    expect(boundary.keychain.get(legacyAccount)).toBe(inaccessibleLegacyToken)
    expect([...boundary.keychain.values()]).not.toContain(temporaryHomeToken)
    const accepted = await h.acceptance.readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(accepted).toMatchObject({ status: 'denied', frameMode: 'memory-only' })

    h.chatBinding.unbindChatStore()
    const restarted = await restartHarness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalled()
    expect(restarted.state.sessionToken).toBeNull()
    expect(restarted.state.me).toBeNull()
  })

  it('accepts a fresh session without requiring legacy namespace enumeration', async () => {
    const h = await harness()
    const config = await import('../config.js')
    vi.spyOn(config, 'getActiveLegacyEnvKeyInventory').mockReturnValue({
      keys: [],
      complete: false,
    })
    boundary.setPassword.mockClear()
    vi.spyOn(h.state.authClient, 'passwordLogin').mockResolvedValueOnce({
      token: replacementToken,
      me: replacementUser,
    })

    await expect(
      h.service.passwordLogin('owner-b@example.test', 'fixture-password')
    ).resolves.toMatchObject({ authenticated: true, me: replacementUser })
    expect(boundary.setPassword).toHaveBeenCalled()
    const active = await h.acceptance.readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(active.status).toBe('accepted')
    if (active.status === 'accepted') expect(active.session.token).toBe(replacementToken)
    expect(() => h.chatBinding.requireChatStore().getAuthorityScope()).not.toThrow()

    h.chatBinding.unbindChatStore()
    const restarted = await restartHarness()
    await expect(restarted.service.initialize()).resolves.toMatchObject({
      authenticated: true,
      me: replacementUser,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(replacementToken)
  })

  it('uses qualified versioned safeStorage when versioned Keytar is uncertain', async () => {
    const h = await harness()
    await h.tokenStore.setSafeStorageSessionToken(homeToken, h.envKey)
    const sourcePath = path.join(boundary.directory, `session-token-${h.envKey}.enc`)
    const sourceBytes = await fs.readFile(sourcePath)
    await expect(h.service.initialize()).resolves.toEqual({ authenticated: false, me: null })

    boundary.setPassword.mockClear()
    boundary.getPassword.mockRejectedValue(
      Object.assign(new Error('fixture Keytar access denied'), { code: 'EACCES' })
    )
    vi.spyOn(h.tokenStore, 'inspectVersionedKeytarCapability').mockResolvedValue('unknown')
    vi.spyOn(h.state.authClient, 'passwordLogin').mockResolvedValueOnce({
      token: replacementToken,
      me: replacementUser,
    })
    await expect(
      h.service.passwordLogin('owner-b@example.test', 'fixture-password')
    ).resolves.toMatchObject({ authenticated: true, me: replacementUser })

    expect(h.state.sessionToken).toBe(replacementToken)
    expect(h.state.me).toEqual(replacementUser)
    expect(boundary.setPassword).not.toHaveBeenCalled()
    await expect(fs.readFile(sourcePath)).resolves.toEqual(sourceBytes)
    const stillSelected = await h.acceptance.readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(stillSelected.status).toBe('accepted')
    if (stillSelected.status === 'accepted') {
      expect(stillSelected.session.token).toBe(replacementToken)
      expect(stillSelected.session.accepted.record.frame.source?.kind).toBe('safe-storage')
    }

    h.chatBinding.unbindChatStore()
    const restarted = await restartHarness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: replacementUser,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(replacementToken)
  })

  it('uses fresh V1 authority when legacy namespace enumeration is unavailable', async () => {
    const h = await harness()
    await h.tokenStore.setSafeStorageSessionToken(homeToken, h.envKey)
    const sourcePath = path.join(boundary.directory, `session-token-${h.envKey}.enc`)
    const sourceBytes = await fs.readFile(sourcePath)
    await expect(h.service.initialize()).resolves.toEqual({ authenticated: false, me: null })
    const config = await import('../config.js')
    vi.spyOn(config, 'getActiveLegacyEnvKeyInventory').mockReturnValue({
      keys: [],
      complete: false,
    })
    boundary.setPassword.mockClear()
    vi.spyOn(h.state.authClient, 'passwordLogin').mockResolvedValueOnce({
      token: replacementToken,
      me: replacementUser,
    })

    await expect(
      h.service.passwordLogin('owner-b@example.test', 'fixture-password')
    ).resolves.toMatchObject({ authenticated: true, me: replacementUser })

    expect(h.state.sessionToken).toBe(replacementToken)
    expect(h.state.me).toEqual(replacementUser)
    expect(boundary.setPassword).toHaveBeenCalled()
    await expect(fs.readFile(sourcePath)).resolves.toEqual(sourceBytes)
    const stillSelected = await h.acceptance.readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(stillSelected.status).toBe('accepted')
    if (stillSelected.status !== 'accepted') throw new Error('Expected new V1 source')
    expect(stillSelected.session.token).toBe(replacementToken)

    h.chatBinding.unbindChatStore()
    const restarted = await restartHarness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: replacementUser,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(replacementToken)
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(homeToken)
  })

  it('does not use a legacy Keytar token when the legacy namespace is ambiguous', async () => {
    const h = await harness()
    await h.tokenStore.setSessionToken(homeToken, h.envKey)
    await expect(h.service.initialize()).resolves.toEqual({ authenticated: false, me: null })

    const config = await import('../config.js')
    vi.spyOn(config, 'getActiveLegacyEnvKeyInventory').mockReturnValue({
      keys: [],
      complete: false,
    })
    boundary.setPassword.mockClear()
    vi.spyOn(h.state.authClient, 'passwordLogin').mockResolvedValueOnce({
      token: replacementToken,
      me: replacementUser,
    })
    await expect(
      h.service.passwordLogin('owner-b@example.test', 'fixture-password')
    ).resolves.toMatchObject({ authenticated: true, me: replacementUser })
    expect(boundary.setPassword).toHaveBeenCalled()
    expect(h.state.sessionToken).toBe(replacementToken)
    expect(h.state.me).toEqual(replacementUser)

    h.chatBinding.unbindChatStore()
    const restarted = await restartHarness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: replacementUser,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(replacementToken)
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(homeToken)
  })

  it('preserves a public-login source after team candidate publication rejects and across restart', async () => {
    const h = await harness()
    vi.spyOn(h.state.authClient, 'passwordLogin').mockResolvedValue({
      token: homeToken,
      me: homeUser,
    })

    await expect(
      h.service.passwordLogin('fixture@example.test', 'fixture-password')
    ).resolves.toEqual({
      authenticated: true,
      me: homeUser,
    })
    const prior = await h.acceptance.readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(prior.status).toBe('accepted')
    if (prior.status !== 'accepted') throw new Error('Expected public login source acceptance')
    expect(prior.session.token).toBe(homeToken)
    const priorSource = prior.session.accepted.record.frame.source
    expect(priorSource).toMatchObject({ format: 'v1', kind: 'keytar', accountId: homeUser.id })
    const priorAccount = `Evenfire::session-v1:${priorSource?.sourceRef}`
    const priorBytes = boundary.keychain.get(priorAccount)
    expect(priorBytes).toBeDefined()

    vi.spyOn(h.state.authClient, 'switchTeam').mockResolvedValue({ token: replacementToken })
    vi.spyOn(h.state.authClient, 'getMe').mockImplementation(async token =>
      token === replacementToken ? teamUser : homeUser
    )
    const setPassword = boundary.setPassword.getMockImplementation()
    if (!setPassword) throw new Error('Keytar producer fixture is not configured')
    boundary.setPassword.mockImplementation(async (service, account, value) => {
      if (account.startsWith('session-v1:')) {
        let candidateToken: unknown
        try {
          candidateToken = (JSON.parse(value) as { sessionToken?: unknown }).sessionToken
        } catch {
          candidateToken = undefined
        }
        if (candidateToken === replacementToken) {
          boundary.keychain.set(keyOf(service, account), value)
          throw new Error('fixture replacement setter rejected after native publication')
        }
      }
      await setPassword(service, account, value)
    })

    await expect(h.service.switchTeam('team-b')).rejects.toThrow(
      'fixture replacement setter rejected after native publication'
    )
    expect(h.state.sessionToken).toBe(homeToken)
    expect(h.state.me).toEqual(homeUser)
    expect(boundary.keychain.get(priorAccount)).toBe(priorBytes)
    const after = await h.acceptance.readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(after.status).toBe('accepted')
    if (after.status !== 'accepted') throw new Error('Rejected team candidate displaced authority')
    expect(after.session.token).toBe(homeToken)
    expect(after.session.accepted.record.frame.source).toEqual(priorSource)
    expect(
      [...boundary.keychain.entries()].some(([account, value]) => {
        if (!account.startsWith('Evenfire::session-v1:')) return false
        try {
          return (JSON.parse(value) as { sessionToken?: unknown }).sessionToken === replacementToken
        } catch {
          return false
        }
      })
    ).toBe(false)

    h.chatBinding.unbindChatStore()
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: homeUser,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledTimes(1)
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(homeToken)
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(replacementToken)
  })

  it('replaces durable logout denial only after a fresh public login acceptance CAS', async () => {
    const h = await harness()
    vi.spyOn(h.state.authClient, 'passwordLogin').mockResolvedValueOnce({
      token: homeToken,
      me: homeUser,
    })
    await expect(
      h.service.passwordLogin('fixture@example.test', 'fixture-password')
    ).resolves.toMatchObject({
      authenticated: true,
      me: homeUser,
    })
    const beforeLogout = await h.acceptance.readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(beforeLogout.status).toBe('accepted')
    if (beforeLogout.status !== 'accepted') throw new Error('Expected the original accepted source')
    const priorSource = beforeLogout.session.accepted.record.frame.source
    if (!priorSource) throw new Error('Original accepted source is missing')

    // Keep exact source debt outstanding through replacement. The new source may be accepted,
    // but failure to clean the old source cannot erase its durable cleanup obligation.
    boundary.deletePassword.mockRejectedValue(new Error('fixture native cleanup unavailable'))

    await h.service.logout()
    const denied = await h.acceptance.readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(denied).toMatchObject({ status: 'denied', frameMode: 'logged-out' })
    expect(h.state.sessionToken).toBeNull()
    expect(h.state.me).toBeNull()

    vi.spyOn(h.state.authClient, 'passwordLogin').mockResolvedValueOnce({
      token: replacementToken,
      me: replacementUser,
    })
    await expect(
      h.service.passwordLogin('fixture@example.test', 'fixture-password')
    ).resolves.toEqual({
      authenticated: true,
      me: replacementUser,
    })

    const accepted = await h.acceptance.readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(accepted.status).toBe('accepted')
    if (accepted.status !== 'accepted')
      throw new Error('Fresh authentication did not replace the durable logout denial')
    expect(accepted.session.token).toBe(replacementToken)
    expect(accepted.session.accepted.record.frame.source).toMatchObject({
      format: 'v1',
      kind: 'keytar',
      accountId: replacementUser.id,
    })
    expect(accepted.session.accepted.record.cleanupDebts).toContainEqual(
      expect.objectContaining({ source: priorSource })
    )
    expect(accepted.session.accepted.record.marker).toBeNull()
    expect(h.state.sessionToken).toBe(replacementToken)
    expect(h.state.me).toEqual(replacementUser)

    h.chatBinding.unbindChatStore()
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: replacementUser,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledTimes(1)
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(replacementToken)
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(homeToken)
  })

  it('keeps logout denial authoritative when a fresh-login candidate write rejects after dispatch', async () => {
    const h = await harness()
    vi.spyOn(h.state.authClient, 'passwordLogin').mockResolvedValueOnce({
      token: homeToken,
      me: homeUser,
    })
    await h.service.passwordLogin('fixture@example.test', 'fixture-password')
    await h.service.logout()

    const setPassword = boundary.setPassword.getMockImplementation()
    if (!setPassword) throw new Error('Keytar producer fixture is not configured')
    boundary.setPassword.mockImplementation(async (service, account, value) => {
      if (account.startsWith('session-v1:')) {
        let storedToken: unknown
        try {
          storedToken = (JSON.parse(value) as { sessionToken?: unknown }).sessionToken
        } catch {
          storedToken = undefined
        }
        if (storedToken === replacementToken) {
          boundary.keychain.set(keyOf(service, account), value)
          throw new Error('fixture candidate setter rejected after native publication')
        }
      }
      await setPassword(service, account, value)
    })
    vi.spyOn(h.state.authClient, 'passwordLogin').mockResolvedValueOnce({
      token: replacementToken,
      me: replacementUser,
    })

    await expect(
      h.service.passwordLogin('fixture@example.test', 'fixture-password')
    ).rejects.toThrow('fixture candidate setter rejected after native publication')
    expect(h.state.sessionToken).toBeNull()
    expect(h.state.me).toBeNull()
    const denied = await h.acceptance.readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(denied).toMatchObject({ status: 'denied', frameMode: 'logged-out' })

    h.chatBinding.unbindChatStore()
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(homeToken)
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(replacementToken)
  })

  it('uses qualified safeStorage when the Keytar state is uncertain', async () => {
    const providerError = new Error('fixture transient provider error')
    boundary.getPassword.mockRejectedValue(providerError)
    const h = await harness()
    vi.spyOn(h.state.authClient, 'passwordLogin').mockResolvedValue({
      token: homeToken,
      me: homeUser,
    })

    await expect(
      h.service.passwordLogin('fixture@example.test', 'fixture-password')
    ).resolves.toMatchObject({ authenticated: true, me: homeUser })
    expect(h.state.sessionToken).toBe(homeToken)
    expect(h.state.me).toEqual(homeUser)
    expect([...boundary.keychain.values()]).toEqual([])
    const authority = await h.acceptance.readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(authority.status).toBe('accepted')
    if (authority.status === 'accepted') {
      expect(authority.session.token).toBe(homeToken)
      expect(authority.session.accepted.record.frame.source?.kind).toBe('safe-storage')
    }
  })

  it('keeps the prior source and visible chat owner when replacement identity is rejected', async () => {
    const h = await harness()
    const priorSource = await h.bindHome()
    const validation = deferred<typeof replacementUser>()
    const entered = deferred<void>()
    vi.spyOn(h.state.authClient, 'getMe').mockImplementation(token => {
      if (token === replacementToken) {
        entered.resolve()
        return validation.promise
      }
      return Promise.resolve(token === teamToken ? teamUser : homeUser)
    })
    vi.spyOn(h.state.authClient, 'passwordLogin').mockResolvedValue({
      token: replacementToken,
      me: replacementUser,
    })

    const login = h.service.passwordLogin('fixture@example.test', 'fixture-password')
    await entered.promise
    const candidateScope = await h.tokenStore.createSessionAuthorityStorageScope()
    const { SessionAuthorityRecordRepository } = await import('../sessionAuthorityRecord.js')
    const candidateObservation = new SessionAuthorityRecordRepository(
      candidateScope,
      h.envKey,
      h.tokenStore
    ).observe()
    expect(candidateObservation.status).toBe('observed')
    if (candidateObservation.status !== 'observed')
      throw new Error('Expected a durable candidate receipt during identity validation')
    const candidate = candidateObservation.record.candidates.find(
      item => item.candidateHash === createHash('sha256').update(replacementToken).digest('hex')
    )
    expect(candidate).toBeDefined()
    if (!candidate) throw new Error('Expected the rejected producer candidate receipt')
    expect(candidate.sourceKind).toBe('keytar')
    const candidateAccount = `session-v1:${candidate.sourceRef}`
    expect(boundary.keychain.has(keyOf('Evenfire', candidateAccount))).toBe(true)
    expect(h.state.sessionToken).toBe(teamToken)
    expect(h.state.me).toEqual(teamUser)
    expect(h.chatBinding.requireChatStore().getAuthorityScope()).toMatchObject({
      environmentKey: h.envKey,
      userId: homeUser.id,
      teamId: teamUser.teamId,
    })
    const staged = await h.acceptance.readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(staged.status).toBe('accepted')
    if (staged.status !== 'accepted') throw new Error('Expected prior source to remain selected')
    expect(staged.session.accepted.record.frame.source).toEqual(priorSource)
    validation.resolve({ ...replacementUser, id: 'foreign-account' })
    await expect(login).rejects.toThrow('Authenticated candidate identity does not match')

    expect(h.state.sessionToken).toBe(teamToken)
    expect(h.state.me).toEqual(teamUser)
    expect(h.chatBinding.requireChatStore().getAuthorityScope()).toMatchObject({
      userId: homeUser.id,
      teamId: teamUser.teamId,
    })
    const after = await h.acceptance.readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(after.status).toBe('accepted')
    if (after.status !== 'accepted') throw new Error('Rejected candidate displaced prior source')
    expect(after.session.accepted.record.frame.source).toEqual(priorSource)
    expect(after.session.token).toBe(teamToken)
    expect(boundary.keychain.has(keyOf('Evenfire', candidateAccount))).toBe(false)

    h.chatBinding.unbindChatStore()
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: teamUser,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(teamToken)
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(replacementToken)
    expect(restarted.chatBinding.requireChatStore().getAuthorityScope()).toMatchObject({
      userId: homeUser.id,
      teamId: teamUser.teamId,
    })
  })

  it('publishes the new source and prepared chat binding only after acceptance', async () => {
    const h = await harness()
    await h.bindHome()
    const validation = deferred<typeof replacementUser>()
    const entered = deferred<void>()
    vi.spyOn(h.state.authClient, 'getMe').mockImplementation(token => {
      if (token === replacementToken) {
        entered.resolve()
        return validation.promise
      }
      return Promise.resolve(token === teamToken ? teamUser : homeUser)
    })
    vi.spyOn(h.state.authClient, 'passwordLogin').mockResolvedValue({
      token: replacementToken,
      me: replacementUser,
    })
    const login = h.service.passwordLogin('fixture@example.test', 'fixture-password')
    await entered.promise
    expect(h.state.sessionToken).toBe(teamToken)
    expect(h.chatBinding.requireChatStore().getAuthorityScope()).toMatchObject({
      userId: homeUser.id,
      teamId: teamUser.teamId,
    })
    validation.resolve(replacementUser)
    await expect(login).resolves.toEqual({ authenticated: true, me: replacementUser })
    expect(h.state.sessionToken).toBe(replacementToken)
    expect(h.state.me).toEqual(replacementUser)
    expect(h.chatBinding.requireChatStore().getAuthorityScope()).toMatchObject({
      userId: replacementUser.id,
      teamId: replacementUser.teamId,
    })
    const selected = await h.acceptance.readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(selected.status).toBe('accepted')
    if (selected.status !== 'accepted') throw new Error('Expected accepted replacement')
    expect(selected.session.token).toBe(replacementToken)
    expect(selected.session.accepted.record.cleanupDebts).toHaveLength(0)

    h.chatBinding.unbindChatStore()
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: replacementUser,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(replacementToken)
    expect(restarted.chatBinding.requireChatStore().getAuthorityScope()).toMatchObject({
      userId: replacementUser.id,
      teamId: replacementUser.teamId,
    })
  })

  it('stages the compatibility marker before authority acceptance with no later marker CAS', async () => {
    const h = await harness()
    const order: string[] = []
    const stageMarker = h.tokenStore.stageSessionAuthorityMarker.bind(h.tokenStore)
    vi.spyOn(h.tokenStore, 'stageSessionAuthorityMarker').mockImplementation((...args) => {
      order.push('marker-projection')
      return stageMarker(...args)
    })
    const { SessionAuthorityRecordRepository } = await import('../sessionAuthorityRecord.js')
    const acceptCandidate = SessionAuthorityRecordRepository.prototype.acceptCandidate
    vi.spyOn(SessionAuthorityRecordRepository.prototype, 'acceptCandidate').mockImplementation(
      function (
        this: InstanceType<typeof SessionAuthorityRecordRepository>,
        ...args: Parameters<typeof acceptCandidate>
      ) {
        order.push('authority-acceptance-cas')
        return acceptCandidate.apply(this, args)
      }
    )
    const markerCas = vi.spyOn(h.tokenStore, 'applySessionAuthorityMarkerCas')
    vi.spyOn(h.state.authClient, 'passwordLogin').mockResolvedValueOnce({
      token: homeToken,
      me: homeUser,
    })

    await expect(
      h.service.passwordLogin('owner-a@example.test', 'fixture-password')
    ).resolves.toEqual({ authenticated: true, me: homeUser })

    expect(order).toEqual(['marker-projection', 'authority-acceptance-cas'])
    expect(markerCas).not.toHaveBeenCalled()
    const selected = await h.acceptance.readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(selected.status).toBe('accepted')
    if (selected.status !== 'accepted') throw new Error('Expected accepted password source')
    expect(selected.session.accepted.record.projectionReceipt).not.toBeNull()
    const markers = await import('../pendingExternalLogout.js')
    expect(markers.readPendingExternalLogoutMarker(boundary.directory, h.envKey)).toEqual(
      markers.acceptancePendingExternalMarker(
        selected.session.accepted.record.projectionReceipt!.marker
      )
    )
  })

  it('fails closed after a publisher fault and recovers the committed authority on restart', async () => {
    const h = await harness()
    const binding = await import('../chatStoreBinding.js')
    const prepareNormally = binding.prepareChatStoreBindingForUser.bind(binding)
    vi.spyOn(binding, 'prepareChatStoreBindingForUser').mockImplementation(async (...args) => {
      const prepared = await prepareNormally(...args)
      const reserveNormally = prepared.reservePublication.bind(prepared)
      prepared.reservePublication = () => {
        const publish = reserveNormally()
        if (!publish) return null
        return () => {
          publish()
          throw new Error('fixture-synchronous-publication-failure')
        }
      }
      return prepared
    })
    vi.spyOn(h.state.authClient, 'passwordLogin').mockResolvedValueOnce({
      token: replacementToken,
      me: replacementUser,
    })

    await expect(
      h.service.passwordLogin('owner-b@example.test', 'fixture-password')
    ).rejects.toThrow('Accepted session runtime publication failed')
    expect(h.state.sessionToken).toBeNull()
    expect(h.state.me).toBeNull()
    expect(() => h.chatBinding.requireChatStore()).toThrow('Not authenticated')
    const accepted = await h.acceptance.readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(accepted.status).toBe('accepted')
    if (accepted.status !== 'accepted') throw new Error('Publisher failure lost durable acceptance')
    expect(accepted.session.token).toBe(replacementToken)

    const restarted = await restartHarness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: replacementUser,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(replacementToken)
  })

  it('re-durably commits an exact next login authority after one directory-sync failure', async () => {
    const h = await harness()
    vi.spyOn(h.state.authClient, 'passwordLogin').mockResolvedValueOnce({
      token: homeToken,
      me: homeUser,
    })
    await expect(
      h.service.passwordLogin('owner-a@example.test', 'fixture-password')
    ).resolves.toEqual({ authenticated: true, me: homeUser })

    const selectedA = await h.acceptance.readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(selectedA.status).toBe('accepted')
    if (selectedA.status !== 'accepted') throw new Error('Expected source A to be accepted')
    expect(selectedA.session.token).toBe(homeToken)

    vi.spyOn(h.state.authClient, 'passwordLogin').mockResolvedValueOnce({
      token: replacementToken,
      me: replacementUser,
    })
    const publication = await injectIndeterminateAuthorityCommit(h.tokenStore, h.envKey)

    const outcome = await h.service.passwordLogin('owner-b@example.test', 'fixture-password').then(
      value => ({ value, error: null }),
      error => ({ value: null, error })
    )
    vi.restoreAllMocks()

    expect(publication).toEqual({
      acceptanceStarted: true,
      authorityReplaced: true,
      directorySyncRejected: true,
    })
    expect(outcome.error).toBeNull()
    expect(outcome.value).toEqual({ authenticated: true, me: replacementUser })
    expect(h.state.sessionToken).toBe(replacementToken)
    expect(h.state.me).toEqual(replacementUser)
    expect(h.service.getCachedUserId()).toBe(replacementUser.id)
    expect(h.chatBinding.requireChatStore().getAuthorityScope()).toMatchObject({
      userId: replacementUser.id,
      teamId: replacementUser.teamId,
    })

    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: replacementUser,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(replacementToken)
    const recovered = await restarted.acceptance.readSessionAuthoritySourceSelection({
      tokenStore: restarted.tokenStore,
      envKey: restarted.envKey,
    })
    expect(recovered.status).toBe('accepted')
    if (recovered.status !== 'accepted') throw new Error('Expected replacement authority')
    expect(recovered.session.token).toBe(replacementToken)
    const retiredSource = selectedA.session.accepted.record.frame.source
    if (!retiredSource || retiredSource.format !== 'v1' || retiredSource.kind !== 'keytar')
      throw new Error('Expected the exact prior V1 Keytar source')
    expect(
      boundary.keychain.get(keyOf('Evenfire', `session-v1:${retiredSource.sourceRef}`))
    ).toBeUndefined()
  })

  it('recovers LP after marker directory-sync uncertainty before reporting logout success', async () => {
    const h = await harness()
    vi.spyOn(h.state.authClient, 'passwordLogin').mockResolvedValueOnce({
      token: homeToken,
      me: homeUser,
    })
    await expect(
      h.service.passwordLogin('owner-a@example.test', 'fixture-password')
    ).resolves.toEqual({ authenticated: true, me: homeUser })
    expect(h.state.sessionToken).toBe(homeToken)
    h.state.authClient.getMe.mockClear()

    const selected = await h.acceptance.readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(selected.status).toBe('accepted')
    if (selected.status !== 'accepted') throw new Error('Expected an accepted V1 source')
    const source = selected.session.accepted.record.frame.source
    if (!source || source.format !== 'v1' || source.kind !== 'keytar')
      throw new Error('Expected the exact accepted V1 Keytar source')
    const cleanupFailure = new Error('fixture exact-source cleanup remains pending')
    const deletion = vi
      .spyOn(h.tokenStore, 'deleteSessionCredentialSourceIfUnselectedWithProof')
      .mockRejectedValue(cleanupFailure)

    const syncFailure = Object.assign(new Error('fixture LP directory sync failure'), {
      code: 'EIO',
    })
    const originalSync = fsSync.fsyncSync.bind(fsSync)
    let injected = false
    const sync = vi.spyOn(fsSync, 'fsyncSync').mockImplementation(descriptor => {
      if (!injected && fsSync.fstatSync(descriptor).isDirectory()) {
        injected = true
        throw syncFailure
      }
      return originalSync(descriptor)
    })
    const outcome = await h.service.logout().then(
      value => ({ value, error: null }),
      error => ({ value: null, error })
    )
    sync.mockRestore()

    expect(injected).toBe(true)
    expect(outcome.value).toMatchObject({ kind: 'committed' })
    expect(outcome.error).toBeNull()
    expect(h.state.sessionToken).toBeNull()
    expect(h.state.me).toBeNull()
    expect(h.service.getCachedUserId()).toBeNull()
    expect(() => h.chatBinding.requireChatStore()).toThrow('Not authenticated')
    await vi.waitFor(() =>
      expect(deletion).toHaveBeenCalledWith(source, expect.anything(), expect.anything())
    )

    const { SessionAuthorityRecordRepository } = await import('../sessionAuthorityRecord.js')
    const authority = new SessionAuthorityRecordRepository(
      await h.tokenStore.createSessionAuthorityStorageScope(),
      h.envKey,
      h.tokenStore
    ).observe()
    expect(authority.status).toBe('observed')
    if (authority.status !== 'observed') throw new Error('Expected durable logout authority')
    expect(authority.record.frame.mode).toBe('logged-out')
    expect(authority.record.cleanupDebts.map(debt => debt.source)).toContainEqual(source)

    const restarted = await restartHarness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(homeToken)
    const recovered = await restarted.acceptance.readSessionAuthoritySourceSelection({
      tokenStore: restarted.tokenStore,
      envKey: restarted.envKey,
    })
    expect(recovered).toMatchObject({ status: 'denied', frameMode: 'logged-out' })
  })

  it('does not repair an acceptance marker after its bound storage root changes', async () => {
    const h = await harness()
    const alternateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-login-root-race-'))
    const originalDirectory = boundary.directory
    const markers = await import('../pendingExternalLogout.js')
    const { SessionAuthorityRecordRepository } = await import('../sessionAuthorityRecord.js')
    const acceptCandidate = SessionAuthorityRecordRepository.prototype.acceptCandidate
    let markerAtFinalCas: ReturnType<typeof markers.observePendingExternalLogoutRaw> | null = null
    vi.spyOn(SessionAuthorityRecordRepository.prototype, 'acceptCandidate').mockImplementation(
      function (
        this: InstanceType<typeof SessionAuthorityRecordRepository>,
        ...args: Parameters<typeof acceptCandidate>
      ) {
        markerAtFinalCas = markers.observePendingExternalLogoutRaw(originalDirectory, h.envKey)
        boundary.directory = alternateDirectory
        return acceptCandidate.apply(this, args)
      }
    )
    vi.spyOn(h.state.authClient, 'passwordLogin').mockResolvedValueOnce({
      token: replacementToken,
      me: replacementUser,
    })

    try {
      await expect(
        h.service.passwordLogin('owner-b@example.test', 'fixture-password')
      ).rejects.toThrow()
      expect(markerAtFinalCas?.marker?.intent.intent).toBe('acceptance-pending')
      expect(markers.observePendingExternalLogoutRaw(originalDirectory, h.envKey)).toEqual(
        markerAtFinalCas
      )
      expect(h.state.sessionToken).toBeNull()
      expect(h.service.getCachedUserId()).toBeNull()
      expect(() => h.chatBinding.requireChatStore()).toThrow('Not authenticated')
    } finally {
      boundary.directory = originalDirectory
      await fs.rm(alternateDirectory, { recursive: true, force: true })
    }
  })

  it.each(['persistent', 'memory-only'] as const)(
    're-durably accepts an exact next %s team authority after one directory-sync failure',
    async sourceMode => {
      const h = await harness()
      if (sourceMode === 'memory-only') {
        const { safeStorage } = await import('electron')
        vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
        const { SessionAuthorityCoordinator } = await import('../sessionAuthorityCoordinator.js')
        vi.spyOn(
          SessionAuthorityCoordinator.prototype,
          'selectFreshPersistentCandidateSource'
        ).mockResolvedValue(null)
      }
      const initialToken = sourceMode === 'memory-only' ? temporaryHomeToken : homeToken
      const nextToken = sourceMode === 'memory-only' ? temporaryTeamToken : teamToken
      vi.spyOn(h.state.authClient, 'passwordLogin').mockResolvedValueOnce({
        token: initialToken,
        me: homeUser,
      })
      const login = await h.service.passwordLogin('owner-a@example.test', 'fixture-password')
      expect(login).toMatchObject({
        authenticated: true,
        me: homeUser,
        ...(sourceMode === 'memory-only' ? { sessionMode: 'temporary' } : {}),
      })
      expect(h.state.sessionToken).toBe(initialToken)
      expect(h.chatBinding.requireChatStore().getAuthorityScope()).toMatchObject({
        userId: homeUser.id,
        teamId: homeUser.teamId,
      })
      let priorKeytarAccount: string | null = null
      let priorKeytarValue: string | null = null
      let priorAcceptedSource:
        | import('../sessionAuthorityRecord.js').SessionAuthorityCredentialSource
        | null = null
      if (sourceMode === 'persistent') {
        const prior = await h.acceptance.readSessionAuthoritySourceSelection({
          tokenStore: h.tokenStore,
          envKey: h.envKey,
        })
        expect(prior.status).toBe('accepted')
        if (prior.status !== 'accepted') throw new Error('Expected persistent source A')
        expect(prior.session.token).toBe(initialToken)
        const source = prior.session.accepted.record.frame.source
        expect(source).toMatchObject({ format: 'v1', kind: 'keytar' })
        if (!source || source.format !== 'v1' || source.kind !== 'keytar')
          throw new Error('Expected the exact V1 Keytar source A')
        priorAcceptedSource = source
        priorKeytarAccount = `session-v1:${source.sourceRef}`
        priorKeytarValue = boundary.keychain.get(keyOf('Evenfire', priorKeytarAccount)) ?? null
        expect(priorKeytarValue).not.toBeNull()
      } else {
        expect(boundary.setPassword).not.toHaveBeenCalled()
        expect([...boundary.keychain.values()]).not.toContain(initialToken)
      }

      vi.spyOn(h.state.authClient, 'switchTeam').mockResolvedValueOnce({ token: nextToken })
      vi.spyOn(h.state.authClient, 'getMe').mockImplementation(async token =>
        token === nextToken ? { ...homeUser, teamId: 'team-c' } : homeUser
      )
      const publication = await injectIndeterminateAuthorityCommit(h.tokenStore, h.envKey)
      const outcome = await h.service.switchTeam('team-c').then(
        value => ({ value, error: null }),
        error => ({ value: null, error })
      )
      vi.restoreAllMocks()

      expect(publication).toEqual({
        acceptanceStarted: true,
        authorityReplaced: true,
        directorySyncRejected: true,
      })
      const teamUser = { ...homeUser, teamId: 'team-c' }
      expect(outcome.error).toBeNull()
      expect(outcome.value).toMatchObject({
        authenticated: true,
        me: teamUser,
        ...(sourceMode === 'memory-only' ? { sessionMode: 'temporary' } : {}),
      })
      expect(h.state.sessionToken).toBe(nextToken)
      expect(h.state.me).toEqual(teamUser)
      expect(h.service.getCachedUserId()).toBe(homeUser.id)
      expect(h.chatBinding.requireChatStore().getAuthorityScope()).toMatchObject({
        userId: homeUser.id,
        teamId: 'team-c',
      })
      expect(boundary.notifySessionChanged).toHaveBeenLastCalledWith(true)
      if (priorKeytarAccount && sourceMode === 'persistent') {
        expect(priorKeytarValue).not.toBeNull()
        expect(boundary.keychain.get(keyOf('Evenfire', priorKeytarAccount))).toBeUndefined()
      }
      if (sourceMode === 'memory-only') {
        expect(boundary.setPassword).not.toHaveBeenCalled()
        expect([...boundary.keychain.values()]).not.toContain(initialToken)
        expect([...boundary.keychain.values()]).not.toContain(nextToken)
      }

      const restarted = await restartHarness()
      const selection = await restarted.acceptance.readSessionAuthoritySourceSelection({
        tokenStore: restarted.tokenStore,
        envKey: restarted.envKey,
      })
      if (sourceMode === 'memory-only') {
        await expect(restarted.service.initialize()).resolves.toEqual({
          authenticated: false,
          me: null,
        })
        expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(initialToken)
        expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(nextToken)
        expect(() => restarted.chatBinding.requireChatStore()).toThrow('Not authenticated')
        expect(selection).toMatchObject({ status: 'denied', frameMode: 'memory-only' })
      } else {
        vi.spyOn(restarted.state.authClient, 'getMe').mockResolvedValue(teamUser)
        await expect(restarted.service.initialize()).resolves.toEqual({
          authenticated: true,
          me: teamUser,
        })
        expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(nextToken)
        expect(restarted.state.sessionToken).toBe(nextToken)
        expect(selection.status).toBe('accepted')
        if (selection.status !== 'accepted') throw new Error('Expected persistent team authority')
        expect(selection.session.token).toBe(nextToken)
      }
      const scope = await restarted.tokenStore.createSessionAuthorityStorageScope()
      const { SessionAuthorityRecordRepository } = await import('../sessionAuthorityRecord.js')
      const repository = new SessionAuthorityRecordRepository(
        scope,
        restarted.envKey,
        restarted.tokenStore
      )
      const record = repository.observe()
      expect(record.status).toBe('observed')
      if (record.status !== 'observed') throw new Error('Expected a recovered authority record')
      expect(record.record.frame.mode).toBe(
        sourceMode === 'memory-only' ? 'memory-only' : 'persistent'
      )
      if (priorAcceptedSource) {
        const exactPriorDebt = record.record.cleanupDebts.some(
          debt => JSON.stringify(debt.source) === JSON.stringify(priorAcceptedSource)
        )
        const exactPriorStoredValue =
          priorAcceptedSource.format === 'v1' && priorAcceptedSource.kind === 'keytar'
            ? boundary.keychain.get(
                keyOf('Evenfire', `session-v1:${priorAcceptedSource.sourceRef}`)
              )
            : undefined
        expect(exactPriorDebt || exactPriorStoredValue === undefined).toBe(true)
      }
    }
  )

  it('does not accept a team candidate after its staged chat owner is superseded', async () => {
    const h = await harness()
    const priorSource = await h.bindHome()
    const app = h.service as unknown as {
      suspendDesktopGfsUploadsForAuthBoundary: () => Promise<void>
    }
    vi.spyOn(h.state.authClient, 'switchTeam').mockResolvedValueOnce({
      token: 'fixture-team-c-session',
    })
    vi.spyOn(h.state.authClient, 'getMe').mockImplementation(async token =>
      token === 'fixture-team-c-session' ? { ...teamUser, teamId: 'team-c' } : homeUser
    )
    const stageChatOwnerSupersession = vi
      .spyOn(app, 'suspendDesktopGfsUploadsForAuthBoundary')
      .mockImplementationOnce(async () => {
        // Model a competing accepted binding after the async GFS preparation begins but before
        // the source CAS. The candidate must lose without displacing the prior source/runtime.
        h.chatBinding.unbindChatStore()
        await h.chatBinding.bindChatStoreForUser(homeUser.id, h.envKey, {
          teamId: teamUser.teamId,
        })
      })

    await expect(h.service.switchTeam('team-c')).rejects.toThrow()
    expect(stageChatOwnerSupersession).toHaveBeenCalledTimes(1)

    expect(h.state.sessionToken).toBe(teamToken)
    expect(h.state.me).toEqual(teamUser)
    expect(h.chatBinding.requireChatStore().getAuthorityScope()).toMatchObject({
      environmentKey: h.envKey,
      userId: homeUser.id,
      teamId: teamUser.teamId,
    })
    const after = await h.acceptance.readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(after.status).toBe('accepted')
    if (after.status !== 'accepted') throw new Error('Superseded candidate retired prior authority')
    expect(after.session.accepted.record.frame.source).toEqual(priorSource)
    expect(after.session.token).toBe(teamToken)
    expect([...boundary.keychain.values()]).not.toContain('fixture-team-c-session')

    h.chatBinding.unbindChatStore()
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: teamUser,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(teamToken)
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith('fixture-team-c-session')
  })

  it('keeps chat unbound until V1 restore completes its final exact-source check', async () => {
    const h = await harness()
    await h.bindHome()
    h.chatBinding.unbindChatStore()
    const restart = await harness()
    const getMeEntered = deferred<void>()
    const releaseGetMe = deferred<typeof teamUser>()
    const candidateReadEntered = deferred<void>()
    const releaseCandidateRead = deferred<void>()
    const readCandidate = restart.tokenStore.readSessionTokenCandidate.bind(restart.tokenStore)
    let candidateReadCount = 0
    let identityValidated = false
    let finalSourceReadHeld = false
    vi.spyOn(restart.state.authClient, 'getMe').mockImplementation(async token => {
      expect(token).toBe(teamToken)
      getMeEntered.resolve()
      const identity = await releaseGetMe.promise
      identityValidated = true
      return identity
    })
    vi.spyOn(restart.tokenStore, 'readSessionTokenCandidate').mockImplementation(
      async (...args) => {
        candidateReadCount += 1
        // Hold the first source read after identity verification. It is the exact-source check
        // immediately before staged consumers can be published; do not couple this to the
        // number of implementation-internal reads performed while pinning the accepted source.
        if (identityValidated && !finalSourceReadHeld) {
          finalSourceReadHeld = true
          candidateReadEntered.resolve()
          await releaseCandidateRead.promise
        }
        return readCandidate(...args)
      }
    )
    const restoring = restart.service.initialize()
    try {
      await expectPhaseEntered(getMeEntered.promise, restoring, 'V1 identity validation')
      releaseGetMe.resolve(teamUser)
      await expectPhaseEntered(
        candidateReadEntered.promise,
        restoring,
        'V1 final exact-source validation'
      )
      expect(finalSourceReadHeld).toBe(true)
      expect(candidateReadCount).toBeGreaterThan(0)
      expect(() => restart.chatBinding.requireChatStore()).toThrow('Not authenticated')
      expect(restart.state.sessionToken).toBeNull()
      expect(restart.state.me).toBeNull()
    } finally {
      releaseGetMe.resolve(teamUser)
      releaseCandidateRead.resolve()
    }
    await expect(restoring).resolves.toEqual({ authenticated: true, me: teamUser })
    expect(restart.chatBinding.requireChatStore().getAuthorityScope()).toMatchObject({
      environmentKey: restart.envKey,
      userId: teamUser.id,
      teamId: teamUser.teamId,
    })
  })
})
