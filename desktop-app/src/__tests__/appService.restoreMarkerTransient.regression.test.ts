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
let previousConfigPath: string | undefined

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.doMock('keytar', () => boundary)
  runtime.keychain.clear()
  runtime.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-r21-marker-'))
  previousConfigPath = process.env.CLERUM_DESKTOP_CONFIG_PATH
  process.env.CLERUM_DESKTOP_CONFIG_PATH = path.join(runtime.directory, 'desktop-runtime.json')
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
  const config = await import('../config.js')
  await config.saveDesktopRuntimeConfig({
    externalRestApiBaseUrl: 'https://api.example.test',
    rpcProxyBaseUrl: 'https://rpc.example.test',
  })
  const { safeStorage } = await import('electron')
  vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
})

afterEach(async () => {
  vi.restoreAllMocks()
  if (previousConfigPath === undefined) delete process.env.CLERUM_DESKTOP_CONFIG_PATH
  else process.env.CLERUM_DESKTOP_CONFIG_PATH = previousConfigPath
  previousConfigPath = undefined
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

describe('R21-M6 live restore retains verified authority after transient inspection', () => {
  it('preserves live CP-S Home when the actual selected encrypted read is transient', async () => {
    // Exercise a genuine pre-dispatch Keytar absence, not an ambiguous rejected setter.
    const h = await harness()
    vi.spyOn(h.tokenStore, 'inspectVersionedKeytarCapability').mockResolvedValue('unavailable')
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    h.state.authClient.getMe.mockClear()
    const marker = h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)
    const selection = await import('../sessionAuthorityAcceptance.js').then(module =>
      module.readSessionAuthoritySourceSelection({ tokenStore: h.tokenStore, envKey: h.envKey })
    )
    expect(selection.status).toBe('accepted')
    if (selection.status !== 'accepted') throw new Error('Expected selected safeStorage source')
    expect(selection.session.accepted.record.frame.source?.kind).toBe('safe-storage')
    expect(selection.session.accepted.record.projectionReceipt).not.toBeNull()
    const selectedSource = selection.session.accepted.record.frame.source
    if (!selectedSource || selectedSource.format !== 'v1')
      throw new Error('Expected the exact selected safeStorage candidate source')
    expect(marker).toEqual(
      h.markers.acceptancePendingExternalMarker(
        selection.session.accepted.record.projectionReceipt!.marker
      )
    )
    const encryptedPath = path.join(
      runtime.directory,
      'sessions',
      `session-v1-${selectedSource.sourceRef}.enc`
    )
    const encryptedBytesBefore = await fs.readFile(encryptedPath)
    const canonicalEncryptedPath = await fs.realpath(encryptedPath)
    const read = fs.readFile.bind(fs)
    const open = fsSync.openSync.bind(fsSync)
    let injected = false
    const failRead = (file: unknown) => {
      if (!injected && String(file) === canonicalEncryptedPath) {
        injected = true
        throw Object.assign(new Error('fixture-selected encrypted read'), { code: 'EMFILE' })
      }
    }
    vi.spyOn(fs, 'readFile').mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
      failRead(args[0])
      return read(...args)
    })
    vi.spyOn(fsSync, 'openSync').mockImplementation(
      (...args: Parameters<typeof fsSync.openSync>) => {
        failRead(args[0])
        return open(...args)
      }
    )
    boundary.notifySessionChanged.mockClear()
    const result = await h.service.initialize()
    expect(injected).toBe(true)
    await expect(fs.readFile(encryptedPath)).resolves.toEqual(encryptedBytesBefore)
    expect(h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)).toEqual(marker)
    expect(result.authenticated).toBe(true)
    expect(h.state.sessionToken).toBe(homeToken)
    expect(h.state.me).toEqual(homeMe)
    expect(h.state.authClient.getMe).not.toHaveBeenCalled()
    expect(boundary.notifySessionChanged).not.toHaveBeenCalledWith(false)
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: homeMe,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(homeToken)
  })

  it('preserves live native authority after a transient exact Keytar source read', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    let injected = false
    const getPassword = boundary.getPassword.getMockImplementation()
    boundary.getPassword.mockImplementation(async (...args) => {
      if (!injected) {
        injected = true
        throw Object.assign(new Error('fixture-selected Keytar source read'), { code: 'EMFILE' })
      }
      return getPassword?.(...args) ?? null
    })
    boundary.notifySessionChanged.mockClear()
    const result = await h.service.initialize()
    expect(injected).toBe(true)
    expect(result.authenticated).toBe(true)
    expect(h.state.sessionToken).toBe(homeToken)
    expect(h.state.me).toEqual(homeMe)
    expect(boundary.notifySessionChanged).not.toHaveBeenCalledWith(false)
    const selected = await import('../sessionAuthorityAcceptance.js').then(module =>
      module.readSessionAuthoritySourceSelection({ tokenStore: h.tokenStore, envKey: h.envKey })
    )
    expect(selected.status).toBe('accepted')
    if (selected.status !== 'accepted') throw new Error('Expected selected native source')
    expect(selected.session.token).toBe(homeToken)
    expect(selected.session.accepted.record.frame.source?.kind).toBe('keytar')
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: homeMe,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(homeToken)
  })

  it('preserves an already authenticated session when journal descriptor close is transient', async () => {
    const h = await harness()
    const { SessionPersistenceProducer } = await import('../sessionPersistenceJournal.js')
    new SessionPersistenceProducer(
      runtime.directory,
      h.envKey,
      null,
      () => {},
      () => {}
    ).prepare('keytar', 'fixture-independent-unaccepted')
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    expect(h.state.sessionToken).toBe(homeToken)
    expect(h.state.me).toEqual(homeMe)
    const open = fsSync.openSync.bind(fsSync)
    const close = fsSync.closeSync.bind(fsSync)
    const descriptors = new Set<number>()
    let injected = false
    vi.spyOn(fsSync, 'openSync').mockImplementation(
      (...args: Parameters<typeof fsSync.openSync>) => {
        const descriptor = open(...args)
        if (String(args[0]).includes('session-persistence-journal-')) descriptors.add(descriptor)
        return descriptor
      }
    )
    vi.spyOn(fsSync, 'closeSync').mockImplementation(descriptor => {
      close(descriptor)
      if (descriptors.delete(descriptor) && !injected) {
        injected = true
        throw Object.assign(new Error('fixture-journal-close'), { code: 'EINTR' })
      }
    })
    boundary.notifySessionChanged.mockClear()
    const result = await h.service.initialize()
    expect(injected).toBe(true)
    expect(result.authenticated).toBe(true)
    expect(h.state.sessionToken).toBe(homeToken)
    expect(h.state.me).toEqual(homeMe)
    expect(boundary.notifySessionChanged).not.toHaveBeenCalledWith(false)
    const selected = await import('../sessionAuthorityAcceptance.js').then(module =>
      module.readSessionAuthoritySourceSelection({ tokenStore: h.tokenStore, envKey: h.envKey })
    )
    expect(selected.status).toBe('accepted')
    if (selected.status !== 'accepted') throw new Error('Expected the accepted session source')
    expect(selected.session.token).toBe(homeToken)
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: homeMe,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(homeToken)
  })

  it('preserves live Home after a transient selected journal read', async () => {
    const h = await harness()
    h.state.authClient.passwordLogin = vi.fn().mockResolvedValue({ token: homeToken, me: homeMe })
    await h.service.passwordLogin(homeMe.email, 'synthetic-password')
    await expect(h.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: homeMe,
    })
    const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
    const selected = await readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(selected.status).toBe('accepted')
    if (selected.status !== 'accepted') throw new Error('Expected pinned V1 source')
    expect(selected.session.accepted.record.frame.source?.format).toBe('v1')
    h.state.authClient.getMe.mockClear()
    boundary.notifySessionChanged.mockClear()
    const journalPath = path.join(
      fsSync.realpathSync(runtime.directory),
      `session-persistence-journal-${createHash('sha256').update(h.envKey).digest('hex')}`
    )
    const open = fsSync.openSync.bind(fsSync)
    let journalReads = 0
    let faultReached = false
    const openedPaths: string[] = []
    vi.spyOn(fsSync, 'openSync').mockImplementation((file, flags, mode) => {
      openedPaths.push(String(file))
      if (String(file) === journalPath) {
        journalReads += 1
        if (journalReads === 1) {
          faultReached = true
          throw Object.assign(new Error('fixture-transient selected V1 journal read'), {
            code: 'EMFILE',
          })
        }
      }
      return open(file, flags, mode)
    })

    const result = await h.service.initialize()

    expect(faultReached, `journal path was not opened: ${openedPaths.join(', ')}`).toBe(true)
    const selectedAfterTransient = await import('../sessionAuthorityAcceptance.js').then(module =>
      module.readSessionAuthoritySourceSelection({ tokenStore: h.tokenStore, envKey: h.envKey })
    )
    expect(selectedAfterTransient.status).toBe('accepted')
    if (selectedAfterTransient.status !== 'accepted')
      throw new Error('Expected prior accepted source')
    expect(selectedAfterTransient.session.token).toBe(homeToken)
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: homeMe,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(homeToken)
    expect(h.service.getCachedUserId()).toBe(homeMe.id)
    expect(result).toEqual({ authenticated: true, me: homeMe })
    expect(h.state.sessionToken).toBe(homeToken)
    expect(boundary.notifySessionChanged).not.toHaveBeenCalledWith(false)
  })

  it('keeps Home bound when staged replacement chat preparation fails', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    const freshToken = 'fixture-rejected-recovery-binding-session'
    const freshMe = { ...homeMe, id: 'fixture-new-user' }
    const binding = await import('../chatStoreBinding.js')
    vi.spyOn(h.state.authClient, 'passwordLogin').mockResolvedValueOnce({
      token: freshToken,
      me: freshMe,
    })
    vi.spyOn(h.state.authClient, 'getMe').mockImplementation(async token =>
      token === freshToken ? freshMe : homeMe
    )
    vi.mocked(binding.prepareChatStoreBindingForUser).mockRejectedValueOnce(
      new Error('fixture-staged replacement chat preparation failed')
    )
    const error = await h.service
      .passwordLogin('fixture-new-user@example.test', 'fixture-password')
      .then(
        () => null,
        error => error
      )
    expect(h.service.getCachedUserId()).toBe(homeMe.id)
    expect(h.state.sessionToken).toBe(homeToken)
    expect(h.state.me).toEqual(homeMe)
    expect(binding.requireChatStore().getAuthorityScope()).toMatchObject({
      userId: homeMe.id,
      teamId: homeMe.teamId,
    })
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: homeMe,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(freshToken)
    expect(error).toBeInstanceOf(Error)
  })

  it('preserves prior authority after transient projection inspection following consumer staging', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    const fresh = 'fixture-rejected-post-bind-user'
    const freshMe = { ...homeMe, id: 'fixture-post-bind-user' }
    const binding = await import('../chatStoreBinding.js')
    let armed = false
    const prepareNormally = vi
      .mocked(binding.prepareChatStoreBindingForUser)
      .getMockImplementation()
    if (!prepareNormally) throw new Error('Chat preparation fixture is not installed')
    vi.mocked(binding.prepareChatStoreBindingForUser).mockImplementationOnce(async (...args) => {
      const prepared = await prepareNormally(...args)
      armed = true
      return prepared
    })
    vi.spyOn(h.state.authClient, 'passwordLogin').mockResolvedValueOnce({
      token: fresh,
      me: freshMe,
    })
    vi.spyOn(h.state.authClient, 'getMe').mockImplementation(async token =>
      token === fresh ? freshMe : homeMe
    )
    const beforeMarker = h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)
    const open = fsSync.openSync.bind(fsSync)
    const spy = vi.spyOn(fsSync, 'openSync').mockImplementation((file, flags, mode) => {
      if (String(file) === h.markerPath && armed) {
        armed = false
        throw Object.assign(new Error('fixture-login post-bind EMFILE'), { code: 'EMFILE' })
      }
      return open(file, flags, mode)
    })
    boundary.notifySessionChanged.mockClear()
    const error = await h.service
      .passwordLogin('fixture-post-bind-user@example.test', 'fixture-password')
      .then(
        () => null,
        error => error
      )
    spy.mockRestore()
    expect(h.state.sessionToken).toBe(homeToken)
    expect(h.state.me).toEqual(homeMe)
    expect(
      (
        h.service as unknown as {
          currentDesktopGfsUploadScope: (drive: undefined) => {
            ownerId: string
            teamId: string | null
          }
        }
      ).currentDesktopGfsUploadScope(undefined)
    ).toMatchObject({
      ownerId: homeMe.id,
      teamId: homeMe.teamId,
    })
    expect(boundary.notifySessionChanged).not.toHaveBeenCalledWith(false)
    const selected = await import('../sessionAuthorityAcceptance.js').then(module =>
      module.readSessionAuthoritySourceSelection({ tokenStore: h.tokenStore, envKey: h.envKey })
    )
    expect(selected.status).toBe('accepted')
    if (selected.status !== 'accepted')
      throw new Error('Expected prior authority to remain accepted')
    expect(selected.session.token).toBe(homeToken)
    expect(h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)).toEqual(
      beforeMarker
    )
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: homeMe,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(fresh)
    expect(error).toBeInstanceOf(Error)
  })

  it('preserves already valid authentication when post-getMe marker inspection is transient', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    const getMe = h.state.authClient.getMe.bind(h.state.authClient)
    const open = fsSync.openSync.bind(fsSync)
    let armed = false
    vi.mocked(h.state.authClient.getMe).mockImplementationOnce(async token => {
      const me = await getMe(token)
      armed = true
      return me
    })
    vi.spyOn(fsSync, 'openSync').mockImplementation(
      (...args: Parameters<typeof fsSync.openSync>) => {
        if (String(args[0]) === h.markerPath && armed) {
          armed = false
          throw Object.assign(new Error('fixture-post-auth-transient'), { code: 'EMFILE' })
        }
        return open(...args)
      }
    )
    boundary.notifySessionChanged.mockClear()
    const result = await h.service.initialize()
    expect(result.authenticated).toBe(true)
    expect(h.state.sessionToken).toBe(homeToken)
    expect(h.state.me?.id).toBe(homeMe.id)
    const selected = await import('../sessionAuthorityAcceptance.js').then(module =>
      module.readSessionAuthoritySourceSelection({ tokenStore: h.tokenStore, envKey: h.envKey })
    )
    expect(selected.status).toBe('accepted')
    if (selected.status !== 'accepted') throw new Error('Expected live accepted source')
    expect(selected.session.token).toBe(homeToken)
    expect(boundary.notifySessionChanged).not.toHaveBeenCalledWith(false)
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: homeMe,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(homeToken)
  })
})
