import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Same real AppService/TokenStore harness as pendingExternalLogout.test.ts.
const runtime = vi.hoisted(() => ({ directory: '', keychain: new Map<string, string>() }))
const { notifySessionChanged } = vi.hoisted(() => ({ notifySessionChanged: vi.fn() }))
const keyOf = (service: string, account: string) => `${service}::${account}`
vi.mock('keytar', () => ({
  getPassword: vi.fn(
    async (service: string, account: string) =>
      runtime.keychain.get(`${service}::${account}`) ?? null
  ),
  setPassword: vi.fn(async (service: string, account: string, token: string) => {
    runtime.keychain.set(`${service}::${account}`, token)
  }),
  deletePassword: vi.fn(async (service: string, account: string) =>
    runtime.keychain.delete(`${service}::${account}`)
  ),
}))
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => runtime.directory), isReady: vi.fn(() => true) },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: vi.fn((value: string) => Buffer.from(value)),
    decryptString: vi.fn((value: Buffer) => value.toString()),
  },
}))
vi.mock('../chatStoreBinding.js', async () => {
  const { createChatStoreBindingMock } = await import('../../testSupport/chatStoreBindingMock.js')
  return createChatStoreBindingMock()
})
vi.mock('../pluginSdkRuntime.js', () => ({
  tryGetPluginSdkRuntime: () => ({ notifySessionChanged, unpinAllSandboxUiSurfaces: vi.fn() }),
}))

let AppServiceClass: typeof import('../appService.js').AppService
let TokenStoreClass: typeof import('../tokenStore.js').TokenStore
let markerStore: typeof import('../pendingExternalLogout.js')
let activeEnvKey = ''
let priorRuntimeEnv: { externalRest?: string; rpcProxy?: string } | undefined
const loginResult = {
  token: 'fixture-fresh-verified-session',
  me: {
    id: 'user-1',
    email: 'user@example.com',
    name: null,
    picture: null,
    teamId: 'team-1',
    teamName: 'Team 1',
    role: 'member' as const,
  },
}

beforeEach(async () => {
  priorRuntimeEnv = {
    externalRest: process.env.EXTERNAL_REST_API_BASE_URL,
    rpcProxy: process.env.RPC_PROXY_BASE_URL,
  }
  process.env.EXTERNAL_REST_API_BASE_URL = 'https://auth.pending-logout.test'
  process.env.RPC_PROXY_BASE_URL = 'https://rpc.pending-logout.test'
  vi.resetModules()
  vi.clearAllMocks()
  runtime.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-marker-coverage-'))
  runtime.keychain.clear()
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
  const [app, tokens, markers, config] = await Promise.all([
    import('../appService.js'),
    import('../tokenStore.js'),
    import('../pendingExternalLogout.js'),
    import('../config.js'),
  ])
  AppServiceClass = app.AppService
  TokenStoreClass = tokens.TokenStore
  markerStore = markers
  activeEnvKey = config.getActiveEnvKey()
  const { safeStorage } = await import('electron')
  vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
})

afterEach(async () => {
  vi.restoreAllMocks()
  if (runtime.directory) await fs.rm(runtime.directory, { recursive: true, force: true })
  runtime.directory = ''
  runtime.keychain.clear()
  if (priorRuntimeEnv?.externalRest === undefined) delete process.env.EXTERNAL_REST_API_BASE_URL
  else process.env.EXTERNAL_REST_API_BASE_URL = priorRuntimeEnv.externalRest
  if (priorRuntimeEnv?.rpcProxy === undefined) delete process.env.RPC_PROXY_BASE_URL
  else process.env.RPC_PROXY_BASE_URL = priorRuntimeEnv.rpcProxy
  priorRuntimeEnv = undefined
  vi.resetModules()
})

function createService(tokenStore = new TokenStoreClass()) {
  const reportFailure = vi.fn()
  const service = new AppServiceClass({
    tokenStore,
    getUserDataDirectory: () => runtime.directory,
    reportDeferredLogoutFailure: reportFailure,
  })
  const state = service as unknown as {
    sessionToken: string | null
    me: typeof loginResult.me | null
    installAuthenticatedLogin: (result: typeof loginResult) => Promise<unknown>
    installAuthenticatedLoginOnce: (result: typeof loginResult) => Promise<unknown>
    authClient: {
      getMe: (token: string) => Promise<typeof loginResult.me>
      passwordLogin: (email: string, password: string) => Promise<typeof loginResult>
    }
  }
  vi.spyOn(state.authClient, 'getMe').mockResolvedValue(loginResult.me)
  return { service, tokenStore, state, reportFailure }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

async function within<T>(operation: Promise<T>, phase: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out during ${phase}`)), 4_000)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function memoryOnlyToken(label: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, jti: label })
  ).toString('base64url')
  return `${header}.${payload}.fixture-signature`
}

// These characterize current accepted marker cells and kill targeted guard mutants.
describe('pending logout accepted lifecycle coverage', () => {
  it('restores only the accepted V1 session after canceled quit with V0 Keytar residue', async () => {
    const { service, tokenStore, state } = createService()
    const freshToken = 'fixture-fresh-safe-storage'
    const legacyToken = 'fixture-stale-logged-out'
    await tokenStore.setSessionToken(legacyToken, activeEnvKey)
    vi.spyOn(state.authClient, 'passwordLogin').mockResolvedValueOnce({
      token: freshToken,
      me: loginResult.me,
    })
    await expect(
      service.passwordLogin(loginResult.me.email, 'fixture-password')
    ).resolves.toMatchObject({ authenticated: true, me: loginResult.me })
    await service.prepareForQuit()
    service.cancelQuitPreparation()

    await expect(service.applyPendingExternalLogoutIntent()).resolves.toBe(false)
    expect(state.sessionToken).toBe(freshToken)
    expect(state.me).toEqual(loginResult.me)
    expect(notifySessionChanged).not.toHaveBeenCalledWith(false)
    expect(
      markerStore.readPendingExternalLogoutIntent(runtime.directory, activeEnvKey)
    ).toMatchObject({
      intent: 'acceptance-pending',
    })
    await expect(tokenStore.getSessionToken(activeEnvKey)).resolves.toBe(legacyToken)

    const restarted = createService()
    vi.spyOn(restarted.state.authClient, 'getMe').mockResolvedValue(loginResult.me)
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: loginResult.me,
    })
    expect(restarted.state.sessionToken).toBe(freshToken)
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(freshToken)
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(legacyToken)
    await expect(restarted.tokenStore.getSessionToken(activeEnvKey)).resolves.toBe(legacyToken)
  })

  it.each(['keytar-write', 'volatile-fallback'] as const)(
    'rejects a login racing a newer same-intent logout during %s admission',
    async mode => {
      const { service, tokenStore, state } = createService()
      const observed = markerStore.readPendingExternalLogoutMarker(runtime.directory, activeEnvKey)
      const { safeStorage } = await import('electron')
      if (mode === 'volatile-fallback') {
        const keytar = await import('keytar')
        vi.mocked(keytar.getPassword).mockRejectedValue(
          Object.assign(new Error('keychain access denied'), { code: 'EACCES' })
        )
        vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
      }
      const started = deferred()
      const release = deferred()
      const candidate =
        mode === 'volatile-fallback'
          ? { ...loginResult, token: memoryOnlyToken(`logout-race-${mode}`) }
          : loginResult
      if (mode === 'keytar-write') {
        const write = tokenStore.writeSessionTokenCandidate.bind(tokenStore)
        vi.spyOn(tokenStore, 'writeSessionTokenCandidate').mockImplementation(async input => {
          const receipt = await write(input)
          started.resolve()
          await release.promise
          return receipt
        })
      } else {
        vi.spyOn(state.authClient, 'getMe').mockImplementationOnce(async () => {
          started.resolve()
          await release.promise
          return loginResult.me
        })
      }
      const login = state.installAuthenticatedLogin(candidate)
      let admissionTimer: ReturnType<typeof setTimeout> | undefined
      const admission = await Promise.race([
        started.promise.then(() => ({ kind: 'entered' as const })),
        login.then(
          () => ({ kind: 'settled' as const }),
          error => ({ kind: 'rejected' as const, error })
        ),
        new Promise<{ kind: 'timeout' }>(resolve => {
          admissionTimer = setTimeout(() => resolve({ kind: 'timeout' }), 4_000)
        }),
      ])
      if (admissionTimer) clearTimeout(admissionTimer)
      if (admission.kind === 'rejected') {
        throw new Error(`Candidate rejected before identity validation: ${String(admission.error)}`)
      }
      expect(admission).toMatchObject({ kind: 'entered' })
      const draining = service.prepareForQuit()
      await expect(within(service.logout(), 'quit-denied logout fallback')).resolves.toMatchObject({
        kind: 'not-committed',
        reason: 'deferred',
      })
      const newer = markerStore.readPendingExternalLogoutMarker(runtime.directory, activeEnvKey)!
      expect(newer.intent).toEqual({ intent: 'logout-pending' })
      expect(newer.revision).toBeTruthy()
      expect(newer.revision).not.toBe(observed?.revision)
      release.resolve()

      await expect(within(login, 'candidate rejection')).rejects.toThrow(
        /Pending logout intent changed|superseded/
      )
      await within(draining, 'quit producer drain')
      expect(state.sessionToken).toBeNull()
      expect(state.me).toBeNull()
      expect(markerStore.readPendingExternalLogoutIntent(runtime.directory, activeEnvKey)).toEqual({
        intent: 'logout-pending',
      })
      const restarted = createService()
      const authenticate = vi.spyOn(restarted.state.authClient, 'getMe')
      await expect(restarted.service.initialize()).resolves.toEqual({
        authenticated: false,
        me: null,
      })
      expect(authenticate).not.toHaveBeenCalled()
      expect(restarted.state.sessionToken).toBeNull()
    }
  )

  it('does not restore legacy safeStorage bytes under an obsolete cleanup marker', async () => {
    const { service, tokenStore, state } = createService()
    await tokenStore.setSafeStorageSessionToken(loginResult.token, activeEnvKey)
    markerStore.recordPendingKeytarCleanup(runtime.directory, activeEnvKey, 'safe-storage')

    await expect(service.initialize()).resolves.toEqual({ authenticated: false, me: null })
    expect(state.sessionToken).toBeNull()
    expect(state.authClient.getMe).not.toHaveBeenCalled()
    expect(markerStore.readPendingExternalLogoutIntent(runtime.directory, activeEnvKey)).toEqual({
      intent: 'keytar-cleanup-pending',
      credentialSource: 'safe-storage',
    })
    await expect(tokenStore.getSafeStorageSessionToken(activeEnvKey)).resolves.toBe(
      loginResult.token
    )
  })

  it('preserves the selected Keytar authority after an ambiguous replacement write', async () => {
    const { service, tokenStore, state } = createService()
    const priorToken = memoryOnlyToken('accepted-prior-keytar')
    const candidateToken = memoryOnlyToken('rejected-keytar-candidate')
    vi.spyOn(state.authClient, 'passwordLogin').mockResolvedValueOnce({
      token: priorToken,
      me: loginResult.me,
    })
    await expect(
      service.passwordLogin(loginResult.me.email, 'fixture-password')
    ).resolves.toMatchObject({ authenticated: true, me: loginResult.me })
    const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
    const prior = await readSessionAuthoritySourceSelection({ tokenStore, envKey: activeEnvKey })
    expect(prior.status).toBe('accepted')
    if (prior.status !== 'accepted') throw new Error('Expected a producer-accepted prior source')
    expect(prior.session.token).toBe(priorToken)
    expect(prior.session.accepted.record.frame.source).toMatchObject({
      format: 'v1',
      kind: 'keytar',
    })

    const keytar = await import('keytar')
    vi.mocked(keytar.setPassword).mockRejectedValueOnce(new Error('keychain write denied'))
    vi.spyOn(state.authClient, 'passwordLogin').mockResolvedValueOnce({
      token: candidateToken,
      me: loginResult.me,
    })

    await expect(service.passwordLogin(loginResult.me.email, 'fixture-password')).rejects.toThrow(
      'keychain write denied'
    )
    expect(state.sessionToken).toBe(priorToken)
    expect(state.me).toEqual(loginResult.me)
    const stillSelected = await readSessionAuthoritySourceSelection({
      tokenStore,
      envKey: activeEnvKey,
    })
    expect(stillSelected.status).toBe('accepted')
    if (stillSelected.status !== 'accepted')
      throw new Error('Failed replacement displaced the accepted source')
    expect(stillSelected.session.token).toBe(priorToken)
    expect(stillSelected.session.accepted.record.frame.source).toEqual(
      prior.session.accepted.record.frame.source
    )

    const restarted = createService()
    vi.spyOn(restarted.state.authClient, 'getMe').mockResolvedValue(loginResult.me)
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: loginResult.me,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledOnce()
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(priorToken)
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(candidateToken)
    expect(restarted.state.sessionToken).toBe(priorToken)
  })

  it('accepts fresh V1 auth without reading V0 Keytar inventory', async () => {
    const { service, state, tokenStore } = createService()
    const legacyToken = 'fixture-v0-keytar-session'
    await tokenStore.setSessionToken(legacyToken, activeEnvKey)
    markerStore.recordPendingKeytarCleanup(runtime.directory, activeEnvKey, 'safe-storage')
    const keytar = await import('keytar')
    const keychainLocked = Object.assign(new Error('keychain access denied'), { code: 'EACCES' })
    vi.mocked(keytar.getPassword).mockRejectedValue(keychainLocked)
    vi.mocked(keytar.setPassword).mockRejectedValue(keychainLocked)
    vi.mocked(keytar.deletePassword).mockRejectedValue(keychainLocked)
    vi.spyOn(state.authClient, 'passwordLogin').mockResolvedValue(loginResult)
    vi.spyOn(state.authClient, 'getMe').mockResolvedValue(loginResult.me)

    const markerBeforeLogin = markerStore.readPendingExternalLogoutMarker(
      runtime.directory,
      activeEnvKey
    )
    const getMe = vi.mocked(state.authClient.getMe)
    await expect(
      service.passwordLogin('user@example.com', 'fixture-password')
    ).resolves.toMatchObject({ authenticated: true, me: loginResult.me })
    expect(getMe).toHaveBeenCalledWith(loginResult.token)
    expect(getMe).not.toHaveBeenCalledWith(legacyToken)
    expect(state.sessionToken).toBe(loginResult.token)
    expect(state.me).toEqual(loginResult.me)
    expect(
      markerStore.readPendingExternalLogoutMarker(runtime.directory, activeEnvKey)
    ).not.toEqual(markerBeforeLogin)
    expect(keytar.getPassword).not.toHaveBeenCalledWith(
      expect.any(String),
      `session-token::${activeEnvKey}`
    )
    keytar.getPassword
      .mockReset()
      .mockImplementation(
        async (service, account) => runtime.keychain.get(keyOf(service, account)) ?? null
      )
    await expect(tokenStore.getSessionToken(activeEnvKey)).resolves.toBe(legacyToken)
    const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
    const selected = await readSessionAuthoritySourceSelection({
      tokenStore,
      envKey: activeEnvKey,
    })
    expect(selected.status).toBe('accepted')
    if (selected.status !== 'accepted') throw new Error('Fresh V1 session was not accepted')
    expect(selected.session.token).toBe(loginResult.token)
    expect(selected.session.accepted.record.frame.source).toMatchObject({
      format: 'v1',
      kind: 'safe-storage',
    })
    const restarted = createService()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: loginResult.me,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(loginResult.token)
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(legacyToken)
  })

  it('rejects isolated default-store recovery when its fresh persisted token cannot be read back', async () => {
    const tokenStore = new TokenStoreClass({ isolatedUserDataPath: runtime.directory })
    const { state } = createService(tokenStore)
    markerStore.recordPendingExternalLogout(runtime.directory, activeEnvKey)
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    const originalWrite = tokenStore.setSessionToken.bind(tokenStore)
    vi.spyOn(tokenStore, 'setSessionToken').mockImplementation(async (...args) => {
      await originalWrite(...args)
      await fs.writeFile(
        path.join(runtime.directory, `session-token-${activeEnvKey}.json`),
        '{not-json'
      )
    })

    const failure = await state.installAuthenticatedLoginOnce(loginResult).catch(error => error)
    expect(state.sessionToken).toBeNull()
    expect(state.me).toBeNull()
    expect(markerStore.readPendingExternalLogoutIntent(runtime.directory, activeEnvKey)).toEqual({
      intent: 'logout-pending',
    })
    expect(failure).toBeInstanceOf(Error)
  })

  it('does not report logout success when the accepted-source marker CAS loses', async () => {
    const { service, tokenStore, state, reportFailure } = createService()
    vi.spyOn(state.authClient, 'passwordLogin').mockResolvedValueOnce(loginResult)
    await expect(
      service.passwordLogin(loginResult.me.email, 'fixture-password')
    ).resolves.toMatchObject({ authenticated: true, me: loginResult.me })
    const markerCas = vi.spyOn(tokenStore, 'applySessionAuthorityMarkerCas').mockReturnValue(false)

    await expect(service.logout()).resolves.toMatchObject({ kind: 'not-committed' })
    expect(markerCas).toHaveBeenCalledOnce()
    expect(state.sessionToken).toBeNull()
    expect(state.me).toBeNull()
    expect(notifySessionChanged).toHaveBeenCalledWith(false)
    expect(reportFailure).not.toHaveBeenCalled()
    expect(
      markerStore.readPendingExternalLogoutMarker(runtime.directory, activeEnvKey)
    ).toMatchObject({
      intent: { intent: 'acceptance-pending' },
      revision: expect.any(String),
    })
    const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
    const selected = await readSessionAuthoritySourceSelection({
      tokenStore,
      envKey: activeEnvKey,
    })
    expect(selected.status).toBe('accepted')
    if (selected.status !== 'accepted')
      throw new Error('Expected the prior session to remain accepted')
    expect(selected.session.token).toBe(loginResult.token)
    const restarted = createService(new TokenStoreClass())
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: loginResult.me,
    })
    expect(reportFailure).not.toHaveBeenCalled()
  })

  it('does not report unframed logout success when the cleanup-marker upgrade CAS loses', async () => {
    const { service, tokenStore, state } = createService()
    await tokenStore.setSafeStorageSessionToken(loginResult.token, activeEnvKey)
    state.sessionToken = loginResult.token
    state.me = loginResult.me
    markerStore.recordPendingKeytarCleanup(runtime.directory, activeEnvKey, 'safe-storage')
    const observed = markerStore.readPendingExternalLogoutMarker(runtime.directory, activeEnvKey)
    const markerCas = vi
      .spyOn(tokenStore, 'applySessionAuthorityMarkerRawCas')
      .mockReturnValue(false)

    await expect(service.logout()).resolves.toMatchObject({ kind: 'not-committed' })
    expect(markerCas).toHaveBeenCalledOnce()
    expect(state.sessionToken).toBeNull()
    expect(state.me).toBeNull()
    await expect(tokenStore.getSafeStorageSessionToken(activeEnvKey)).resolves.toBe(
      loginResult.token
    )
    expect(markerStore.readPendingExternalLogoutMarker(runtime.directory, activeEnvKey)).toEqual(
      observed
    )
  })
})
