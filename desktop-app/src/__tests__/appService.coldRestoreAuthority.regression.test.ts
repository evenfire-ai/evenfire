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
  openExternal: vi.fn(),
}))
const keyOf = (service: string, account: string) => `${service}::${account}`
vi.mock('keytar', () => boundary)
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => runtime.directory), isReady: vi.fn(() => true) },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(`encrypted:${value}`)),
    decryptString: vi.fn((value: Buffer) => value.toString().replace(/^encrypted:/, '')),
  },
  shell: { openExternal: boundary.openExternal },
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

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  boundary.openExternal.mockResolvedValue(undefined)
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
    runSessionPersistence: <T>(operation: () => Promise<T>) => Promise<T>
    authClient: {
      getMe: (token: string) => Promise<typeof homeMe>
      switchTeam: (token: string, teamId: string) => Promise<{ token: string }>
      issueRpcToken: (
        token: string,
        scopes: string[],
        hostRefs?: string[]
      ) => Promise<{
        token: string
        accessScope: 'user'
        teamId: null
        scopes: string[]
        hostRefs: string[]
        expiresInSeconds: number
      }>
    }
    rpcClient: {
      requestSandboxUiOauthAuthorizeUrl: (...args: unknown[]) => Promise<{ authorizeUrl: string }>
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
  return { service, tokenStore, markers, envKey, state, reportFailure }
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

describe('R9-M2 cold restore authentication authority', () => {
  it('does not expose a saved token to OAuth before authentication and binding accept it', async () => {
    const previous = await harness()
    await previous.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    const h = await harness()
    const getMeStarted = deferred()
    const releaseGetMe = deferred()
    const setterStarted = deferred()
    const releaseSetter = deferred()
    const consentStarted = deferred()
    const releaseConsent = deferred()
    const fresh = 'fixture-admitted-fresh-session'
    const freshMe = { ...homeMe, id: 'fixture-admitted-fresh-user' }
    const homeConsent = 'https://fixture.example/oauth/consent?owner=Home'
    vi.mocked(h.state.authClient.getMe).mockImplementationOnce(async token => {
      expect(token).toBe(homeToken)
      getMeStarted.resolve()
      await releaseGetMe.promise
      return homeMe
    })
    vi.spyOn(h.state.authClient, 'issueRpcToken').mockImplementation(
      async (token, scopes, hosts) => {
        expect(token).toBe(homeToken)
        return {
          token: 'fixture-home-rpc',
          accessScope: 'user',
          teamId: null,
          scopes,
          hostRefs: hosts ?? [],
          expiresInSeconds: 600,
        }
      }
    )
    vi.spyOn(h.state.rpcClient, 'requestSandboxUiOauthAuthorizeUrl').mockImplementation(
      async () => {
        consentStarted.resolve()
        await releaseConsent.promise
        return { authorizeUrl: homeConsent }
      }
    )
    boundary.setPassword.mockImplementation(async (service, account, token) => {
      if (token === fresh) {
        setterStarted.resolve()
        await releaseSetter.promise
      }
      runtime.keychain.set(keyOf(service, account), token)
    })
    const restore = h.service.initialize()
    let login: Promise<unknown> | undefined
    let consent: Promise<unknown> | undefined
    let consentOutcome: unknown
    try {
      await enteredWithin(getMeStarted.promise, 'cold Home authentication request')
      consent = h.service.requestSandboxUiOauthAuthorize('fixture', 'app', 'provider')
      const observedConsent = consent.then(
        result => ({ status: 'fulfilled' as const, result }),
        error => ({ status: 'rejected' as const, error })
      )
      await enteredWithin(
        Promise.race([consentStarted.promise, observedConsent.then(() => undefined)]),
        'real cold-token consumer admission or rejection'
      )
      login = h.state.installAuthenticatedLogin({ token: fresh, me: freshMe })
      await enteredWithin(setterStarted.promise, 'admitted Fresh native setter')
      releaseSetter.resolve()
      await login
      releaseGetMe.resolve()
      releaseConsent.resolve()
      consentOutcome = await observedConsent
    } finally {
      releaseGetMe.resolve()
      releaseSetter.resolve()
      releaseConsent.resolve()
      await Promise.allSettled([restore, login, consent])
    }
    const restarted = await harness()
    vi.mocked(restarted.state.authClient.getMe).mockImplementation(async token =>
      token === fresh ? freshMe : homeMe
    )
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: freshMe,
    })
    expect(h.state.sessionToken).toBe(fresh)
    expect(h.state.me).toEqual(freshMe)
    await expect(h.tokenStore.getKeytarSessionToken(h.envKey)).resolves.toBe(fresh)
    expect(boundary.openExternal).not.toHaveBeenCalledWith(homeConsent)
    expect(consentOutcome).toMatchObject({ status: 'rejected', error: expect.any(Error) })
  })
})
