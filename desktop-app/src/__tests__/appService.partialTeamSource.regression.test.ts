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

const homeToken = 'fixture-r21-home-session'
const teamToken = 'fixture-r21-team-session'
const homeMe = {
  id: 'fixture-r21-user',
  email: 'fixture-r21@example.com',
  name: null,
  picture: null,
  teamId: 'fixture-home',
  teamName: 'Fixture home',
  role: 'member',
}

let tokenSequence = 0
let priorConfigPath: string | undefined
let configPath = ''
function validSessionToken(): string {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, jti: ++tokenSequence })
  ).toString('base64url')
  return `header.${payload}.signature`
}

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.doMock('keytar', () => boundary)
  runtime.keychain.clear()
  runtime.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-r21-marker-'))
  priorConfigPath = process.env.CLERUM_DESKTOP_CONFIG_PATH
  configPath = path.join(runtime.directory, 'desktop-runtime.json')
  process.env.CLERUM_DESKTOP_CONFIG_PATH = configPath
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
  const config = await import('../config.js')
  await config.saveDesktopRuntimeConfig({
    externalRestApiBaseUrl: 'https://api.example.test',
    rpcProxyBaseUrl: 'https://rpc.example.test',
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(runtime.directory, { recursive: true, force: true })
  runtime.directory = ''
  runtime.keychain.clear()
  if (priorConfigPath === undefined) delete process.env.CLERUM_DESKTOP_CONFIG_PATH
  else process.env.CLERUM_DESKTOP_CONFIG_PATH = priorConfigPath
  configPath = ''
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

describe('R21-M7 installed team source cleanup', () => {
  it('repairs a rejected final team acceptance observation before clearing its runtime', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    const authority = await import('../sessionAuthorityAcceptance.js')
    const selectedBefore = await authority.readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(selectedBefore.status).toBe('accepted')
    if (selectedBefore.status !== 'accepted') throw new Error('Expected accepted Home authority')
    const priorSource = selectedBefore.session.accepted.record.frame.source
    const priorMarker = h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)
    let candidateIdentityChecked = false
    let failed = false
    const getMe = vi.mocked(h.state.authClient.getMe).getMockImplementation()!
    vi.mocked(h.state.authClient.getMe).mockImplementation(async token => {
      const me = await getMe(token)
      if (token === teamToken) candidateIdentityChecked = true
      return me
    })
    const open = fsSync.openSync.bind(fsSync)
    vi.spyOn(fsSync, 'openSync').mockImplementation((file, flags, mode) => {
      if (candidateIdentityChecked && !failed && String(file) === h.markerPath) {
        failed = true
        throw Object.assign(new Error('fixture-final acceptance observation'), { code: 'EMFILE' })
      }
      return open(file, flags, mode)
    })
    const error = await h.service.switchTeam('fixture-other').then(
      () => null,
      error => error
    )
    vi.restoreAllMocks()
    expect(candidateIdentityChecked).toBe(true)
    expect(failed).toBe(true)
    expect(h.state.sessionToken).toBe(homeToken)
    expect(h.state.me).toEqual(homeMe)
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: homeMe,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(teamToken)
    const selectedAfter = await authority.readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(selectedAfter.status).toBe('accepted')
    if (selectedAfter.status !== 'accepted') throw new Error('Rejected team lost Home authority')
    expect(selectedAfter.session.token).toBe(homeToken)
    expect(selectedAfter.session.accepted.record.frame.source).toEqual(priorSource)
    expect(h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)).toEqual(
      priorMarker
    )
    const journal = await import('../sessionPersistenceJournal.js')
    expect(journal.readSessionPersistenceJournal(runtime.directory, h.envKey)).toBeNull()
    expect(error).toBeInstanceOf(Error)
  })

  it('does not restore a rejected team session after transient cleanup-source inspection', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    const authority = await import('../sessionAuthorityAcceptance.js')
    const selectedBefore = await authority.readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(selectedBefore.status).toBe('accepted')
    if (selectedBefore.status !== 'accepted') throw new Error('Expected accepted Home authority')
    const priorSource = selectedBefore.session.accepted.record.frame.source
    const priorMarker = h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)
    const state = h.service as unknown as {
      suspendDesktopGfsUploadsForAuthBoundary: () => Promise<void>
    }
    let gfsFailureSeen = false
    vi.spyOn(state, 'suspendDesktopGfsUploadsForAuthBoundary').mockImplementationOnce(async () => {
      gfsFailureSeen = true
      throw new Error('fixture-genuine GFS boundary failed')
    })
    const getMe = vi.mocked(h.state.authClient.getMe).getMockImplementation()!
    vi.mocked(h.state.authClient.getMe).mockImplementation(async token => {
      const me = await getMe(token)
      return me
    })
    const open = fsSync.openSync.bind(fsSync)
    let transientReadFailed = false
    const spy = vi.spyOn(fsSync, 'openSync').mockImplementation((file, flags, mode) => {
      if (String(file) === h.markerPath && gfsFailureSeen && !transientReadFailed) {
        transientReadFailed = true
        throw Object.assign(new Error('fixture-GFS cleanup marker EMFILE'), { code: 'EMFILE' })
      }
      return open(file, flags, mode)
    })
    const error = await h.service.switchTeam('fixture-other').then(
      () => null,
      error => error
    )
    spy.mockRestore()
    expect(error).toBeInstanceOf(Error)
    expect(gfsFailureSeen).toBe(true)
    expect(transientReadFailed).toBe(true)
    expect(h.state.sessionToken).toBe(homeToken)
    expect(h.state.me).toEqual(homeMe)
    const selectedAfter = await authority.readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(selectedAfter.status).toBe('accepted')
    if (selectedAfter.status !== 'accepted') throw new Error('Rejected team lost Home authority')
    expect(selectedAfter.session.token).toBe(homeToken)
    expect(selectedAfter.session.accepted.record.frame.source).toEqual(priorSource)
    expect(h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)).toEqual(
      priorMarker
    )
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: homeMe,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(teamToken)
  })
})

describe('Stage A partial-team rollback policy parity', () => {
  it('preserves persistent rollback behavior after the public team switch installs then fails', async () => {
    const h = await harness()
    await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    const authority = await import('../sessionAuthorityAcceptance.js')
    const selectedBefore = await authority.readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(selectedBefore.status).toBe('accepted')
    if (selectedBefore.status !== 'accepted') throw new Error('Expected accepted Home authority')
    const priorSource = selectedBefore.session.accepted.record.frame.source
    const priorMarker = h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)
    const effects = h.service as unknown as {
      suspendDesktopGfsUploadsForAuthBoundary: (identity: unknown) => Promise<void>
    }
    const gfsBoundary = vi
      .spyOn(effects, 'suspendDesktopGfsUploadsForAuthBoundary')
      .mockImplementationOnce(async () => {
        expect(h.state.sessionToken).toBe(homeToken)
        expect(h.state.me?.teamId).toBe(homeMe.teamId)
        throw new Error('fixture-GFS boundary failure after replacement install')
      })

    await expect(h.service.switchTeam('fixture-other')).rejects.toThrow(
      'fixture-GFS boundary failure after replacement install'
    )
    expect(gfsBoundary).toHaveBeenCalledOnce()

    expect(h.state.sessionToken).toBe(homeToken)
    expect(h.state.me).toEqual(homeMe)
    const selectedAfter = await authority.readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(selectedAfter.status).toBe('accepted')
    if (selectedAfter.status !== 'accepted') throw new Error('Rejected team lost Home authority')
    expect(selectedAfter.session.token).toBe(homeToken)
    expect(selectedAfter.session.accepted.record.frame.source).toEqual(priorSource)
    expect(h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)).toEqual(
      priorMarker
    )
    const { requireChatStore } = await import('../chatStoreBinding.js')
    expect(requireChatStore().getAuthorityScope()).toEqual({
      environmentKey: h.envKey,
      userId: homeMe.id,
      teamId: homeMe.teamId,
    })

    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toMatchObject({
      authenticated: true,
      me: homeMe,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(teamToken)
  })

  it('keeps the temporary candidate staged until GFS preparation succeeds', async () => {
    const h = await harness()
    const temporaryHomeToken = validSessionToken()
    const temporaryTeamToken = `header.${Buffer.from(
      JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 7200, jti: 'fixture-team-candidate' })
    ).toString('base64url')}.signature`
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    const keytarUnavailable = Object.assign(new Error('fixture-Keytar unavailable'), {
      code: 'EACCES',
    })
    boundary.getPassword.mockRejectedValue(keytarUnavailable)
    boundary.setPassword.mockRejectedValue(keytarUnavailable)
    boundary.deletePassword.mockRejectedValue(keytarUnavailable)
    vi.spyOn(h.state.authClient, 'passwordLogin').mockResolvedValue({
      token: temporaryHomeToken,
      me: homeMe,
    })
    await h.service.passwordLogin('fixture@example.test', 'fixture-password')
    const markerBefore = h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)
    expect(markerBefore?.intent.intent).toBe('acceptance-pending')
    expect(h.state.sessionToken).toBe(temporaryHomeToken)
    vi.mocked(h.state.authClient.getMe).mockImplementation(async token => ({
      ...homeMe,
      teamId: token === temporaryTeamToken ? 'fixture-other' : homeMe.teamId,
    }))
    vi.mocked(h.state.authClient.switchTeam).mockResolvedValue({ token: temporaryTeamToken })

    const effects = h.service as unknown as {
      suspendDesktopGfsUploadsForAuthBoundary: (identity: unknown) => Promise<void>
    }
    const gfsBoundary = vi
      .spyOn(effects, 'suspendDesktopGfsUploadsForAuthBoundary')
      .mockImplementationOnce(async () => {
        expect(h.state.sessionToken).toBe(temporaryHomeToken)
        expect(h.state.me).toEqual(homeMe)
        throw new Error('fixture-GFS boundary failure after volatile replacement')
      })

    await expect(h.service.switchTeam('fixture-other')).rejects.toThrow(
      'fixture-GFS boundary failure after volatile replacement'
    )
    expect(gfsBoundary).toHaveBeenCalledOnce()

    expect(h.state.sessionToken).toBe(temporaryHomeToken)
    expect(h.state.me).toEqual(homeMe)
    expect(h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)).toEqual(
      markerBefore
    )
    const { requireChatStore } = await import('../chatStoreBinding.js')
    expect(requireChatStore().getAuthorityScope()).toEqual({
      environmentKey: h.envKey,
      userId: homeMe.id,
      teamId: homeMe.teamId,
    })

    const restarted = await harness()
    const restored = await restarted.service.initialize()
    expect(restored.authenticated).toBe(false)
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(temporaryHomeToken)
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(temporaryTeamToken)
  })

  it('accepts a prepared temporary team candidate without extending its lease or persisting it', async () => {
    const h = await harness()
    const temporaryHomeToken = validSessionToken()
    const temporaryTeamToken = `header.${Buffer.from(
      JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 7200, jti: 'fixture-team-candidate' })
    ).toString('base64url')}.signature`
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    const keytarUnavailable = Object.assign(new Error('fixture-Keytar unavailable'), {
      code: 'EACCES',
    })
    boundary.getPassword.mockRejectedValue(keytarUnavailable)
    boundary.setPassword.mockRejectedValue(keytarUnavailable)
    boundary.deletePassword.mockRejectedValue(keytarUnavailable)
    vi.spyOn(h.state.authClient, 'passwordLogin').mockResolvedValue({
      token: temporaryHomeToken,
      me: homeMe,
    })
    await h.service.passwordLogin('fixture@example.test', 'fixture-password')
    const leaseBefore = await h.service.getSessionState()
    expect(leaseBefore).toMatchObject({ authenticated: true, sessionMode: 'temporary' })
    const expiresAtBefore = leaseBefore.expiresAt
    const markerBefore = h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)
    expect(markerBefore?.intent.intent).toBe('acceptance-pending')
    const writesBeforeTeamSwitch = boundary.setPassword.mock.calls.length

    vi.mocked(h.state.authClient.getMe).mockImplementation(async token => ({
      ...homeMe,
      teamId: token === temporaryTeamToken ? 'fixture-other' : homeMe.teamId,
    }))
    vi.mocked(h.state.authClient.switchTeam).mockResolvedValue({ token: temporaryTeamToken })
    const effects = h.service as unknown as {
      suspendDesktopGfsUploadsForAuthBoundary: (identity: unknown) => Promise<void>
    }
    vi.spyOn(effects, 'suspendDesktopGfsUploadsForAuthBoundary').mockImplementationOnce(
      async () => {
        expect(h.state.sessionToken).toBe(temporaryHomeToken)
        expect(h.state.me).toEqual(homeMe)
      }
    )

    await expect(h.service.switchTeam('fixture-other')).resolves.toMatchObject({
      authenticated: true,
      me: { ...homeMe, teamId: 'fixture-other' },
      sessionMode: 'temporary',
    })
    expect(h.state.sessionToken).toBe(temporaryTeamToken)
    expect((await h.service.getSessionState()).expiresAt).toBeLessThanOrEqual(expiresAtBefore!)
    expect(boundary.setPassword).toHaveBeenCalledTimes(writesBeforeTeamSwitch)
    expect(await h.tokenStore.getSafeStorageSessionToken(h.envKey)).toBeNull()
    const markerAfter = h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)
    expect(markerAfter?.intent.intent).toBe('acceptance-pending')
    expect(markerAfter?.revision).not.toBe(markerBefore?.revision)
    const authority = await import('../sessionAuthorityAcceptance.js')
    await expect(
      authority.readSessionAuthoritySourceSelection({ tokenStore: h.tokenStore, envKey: h.envKey })
    ).resolves.toEqual({ status: 'denied', frameMode: 'memory-only' })
    const { requireChatStore } = await import('../chatStoreBinding.js')
    expect(requireChatStore().getAuthorityScope()).toEqual({
      environmentKey: h.envKey,
      userId: homeMe.id,
      teamId: 'fixture-other',
    })

    const restarted = await harness()
    const restored = await restarted.service.initialize()
    expect(restored.authenticated).toBe(false)
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(temporaryHomeToken)
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(temporaryTeamToken)
  })
})
