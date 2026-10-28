import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const runtime = vi.hoisted(() => ({ directory: '' }))
const { notifySessionChanged } = vi.hoisted(() => ({ notifySessionChanged: vi.fn() }))
let priorRuntimeEnv: { externalRest?: string; rpcProxy?: string } | undefined
const keychain = new Map<string, string>()
const keyOf = (service: string, account: string) => `${service}::${account}`
const keytarMock = {
  getPassword: vi.fn(
    async (service: string, account: string) => keychain.get(keyOf(service, account)) ?? null
  ),
  setPassword: vi.fn(async (service: string, account: string, token: string) => {
    keychain.set(keyOf(service, account), token)
  }),
  deletePassword: vi.fn(async (service: string, account: string) =>
    keychain.delete(keyOf(service, account))
  ),
}

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

const me = {
  id: 'fixture-user',
  email: 'fixture@example.com',
  name: null,
  picture: null,
  teamId: 'fixture-home-team',
  teamName: 'Fixture home team',
  role: 'member',
}

const expectedFreshToken = sessionToken('fixture-fresh-session')

function sessionToken(label: string): string {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, fixture: label })
  ).toString('base64url')
  return `header.${payload}.signature`
}

beforeEach(async () => {
  priorRuntimeEnv = {
    externalRest: process.env.EXTERNAL_REST_API_BASE_URL,
    rpcProxy: process.env.RPC_PROXY_BASE_URL,
  }
  process.env.EXTERNAL_REST_API_BASE_URL = 'https://auth.pending-logout.test'
  process.env.RPC_PROXY_BASE_URL = 'https://rpc.pending-logout.test'
  vi.clearAllMocks()
  vi.resetModules()
  keychain.clear()
  keytarMock.getPassword
    .mockReset()
    .mockImplementation(async (service, account) => keychain.get(keyOf(service, account)) ?? null)
  keytarMock.setPassword.mockReset().mockImplementation(async (service, account, token) => {
    keychain.set(keyOf(service, account), token)
  })
  keytarMock.deletePassword
    .mockReset()
    .mockImplementation(async (service, account) => keychain.delete(keyOf(service, account)))
  vi.doMock('keytar', () => keytarMock)
  runtime.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-marker-login-repair-'))
  const { safeStorage } = await import('electron')
  vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
})

afterEach(async () => {
  vi.restoreAllMocks()
  if (runtime.directory) await fs.rm(runtime.directory, { recursive: true, force: true })
  runtime.directory = ''
  keychain.clear()
  if (priorRuntimeEnv?.externalRest === undefined) delete process.env.EXTERNAL_REST_API_BASE_URL
  else process.env.EXTERNAL_REST_API_BASE_URL = priorRuntimeEnv.externalRest
  if (priorRuntimeEnv?.rpcProxy === undefined) delete process.env.RPC_PROXY_BASE_URL
  else process.env.RPC_PROXY_BASE_URL = priorRuntimeEnv.rpcProxy
  priorRuntimeEnv = undefined
  vi.resetModules()
})

async function createService(options: { isolated?: boolean } = {}) {
  const [{ AppService }, { TokenStore }, config, markers] = await Promise.all([
    import('../appService.js'),
    import('../tokenStore.js'),
    import('../config.js'),
    import('../pendingExternalLogout.js'),
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
  const envKey = config.getActiveEnvKey()
  const markerPath = path.join(
    runtime.directory,
    `pending-external-logout-${createHash('sha256').update(envKey).digest('hex')}`
  )
  // Only the external auth boundary is stubbed; marker and credential producers are real.
  const authClient = (
    service as unknown as {
      authClient: {
        getMe: (token: string) => Promise<typeof me>
        switchTeam: (token: string, teamId: string) => Promise<{ token: string }>
        passwordLogin: (
          email: string,
          password: string
        ) => Promise<{ token: string; me: typeof me }>
      }
    }
  ).authClient
  vi.spyOn(authClient, 'getMe').mockResolvedValue(me)
  const passwordLogin = vi.spyOn(authClient, 'passwordLogin')
  const login = (token = expectedFreshToken) => {
    passwordLogin.mockResolvedValueOnce({ token, me })
    return service.passwordLogin(me.email, 'fixture-password')
  }
  return { service, tokenStore, reportFailure, markers, envKey, markerPath, authClient, login }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(innerResolve => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

describe('explicit login repair uses the pending-logout storage plan', () => {
  it('keeps logout denial after malformed-marker recovery and uncertain Keytar publication', async () => {
    const harness = await createService()
    await fs.writeFile(harness.markerPath, '{malformed')
    keytarMock.setPassword.mockImplementationOnce(async (service, account, token) => {
      keychain.set(keyOf(service, account), token)
      throw new Error('fixture-Keytar publication outcome uncertain')
    })
    keytarMock.deletePassword.mockRejectedValue(
      new Error('fixture-Keytar candidate cleanup unavailable')
    )

    await expect(harness.login()).rejects.toThrow('fixture-Keytar publication outcome uncertain')

    expect(harness.service.getCachedUserId()).toBeNull()
    await expect(harness.tokenStore.getSafeStorageSessionToken(harness.envKey)).resolves.toBeNull()
    expect(
      harness.markers.readPendingExternalLogoutIntent(runtime.directory, harness.envKey)
    ).toEqual({ intent: 'logout-pending' })
    const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
    await expect(
      readSessionAuthoritySourceSelection({
        tokenStore: harness.tokenStore,
        envKey: harness.envKey,
      })
    ).resolves.toMatchObject({ status: 'denied', frameMode: 'logged-out' })
    expect(harness.reportFailure).toHaveBeenCalled()
    const restarted = await createService()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(restarted.authClient.getMe).not.toHaveBeenCalledWith(expectedFreshToken)
  })

  it('accepts fresh V1 authority when legacy Keytar inventory is unavailable', async () => {
    keytarMock.getPassword.mockRejectedValue(
      Object.assign(new Error('fixture-Keytar access denied'), { code: 'EACCES' })
    )
    const harness = await createService()
    await fs.writeFile(harness.markerPath, '{malformed')

    await expect(harness.login()).resolves.toMatchObject({ authenticated: true, me })

    const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
    const selected = await readSessionAuthoritySourceSelection({
      tokenStore: harness.tokenStore,
      envKey: harness.envKey,
    })
    expect(selected.status).toBe('accepted')
    if (selected.status !== 'accepted') throw new Error('Expected a fresh V1 session')
    expect(selected.session.accepted.record.frame.source).toMatchObject({
      format: 'v1',
      kind: 'safe-storage',
    })
    expect(selected.session.token).toBe(expectedFreshToken)
    expect(harness.service.getCachedUserId()).toBe(me.id)
    expect(await fs.readFile(harness.markerPath, 'utf8')).not.toBe('{malformed')
    expect(keytarMock.getPassword).not.toHaveBeenCalledWith(
      expect.any(String),
      `session-token::${harness.envKey}`
    )
  })

  it('does not require legacy namespace enumeration for fresh V1 authority', async () => {
    const config = await import('../config.js')
    vi.spyOn(config, 'getActiveLegacyEnvKeyInventory').mockReturnValue({
      keys: [],
      complete: false,
    })
    const harness = await createService()
    await fs.writeFile(harness.markerPath, '{malformed')

    await expect(harness.login()).resolves.toMatchObject({ authenticated: true, me })

    const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
    const selected = await readSessionAuthoritySourceSelection({
      tokenStore: harness.tokenStore,
      envKey: harness.envKey,
    })
    expect(selected.status).toBe('accepted')
    if (selected.status !== 'accepted') throw new Error('Expected a fresh V1 session')
    expect(selected.session.token).toBe(expectedFreshToken)
    expect(harness.service.getCachedUserId()).toBe(me.id)
    expect(await fs.readFile(harness.markerPath, 'utf8')).not.toBe('{malformed')
  })

  it('accepts fresh persistent V1 authority without legacy environment enumeration', async () => {
    const config = await import('../config.js')
    vi.spyOn(config, 'getActiveLegacyEnvKeyInventory').mockReturnValue({
      keys: [],
      complete: false,
    })
    const harness = await createService()

    await expect(harness.login()).resolves.toMatchObject({ authenticated: true, me })

    const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
    const selected = await readSessionAuthoritySourceSelection({
      tokenStore: harness.tokenStore,
      envKey: harness.envKey,
    })
    expect(selected.status).toBe('accepted')
    if (selected.status !== 'accepted') throw new Error('Expected a fresh persistent session')
    expect(selected.session.token).toBe(expectedFreshToken)
    expect(selected.session.accepted.record.frame.source?.format).toBe('v1')
  })

  it('does not use memory-only fallback after an active-Keytar candidate write fails', async () => {
    const harness = await createService()
    await fs.writeFile(harness.markerPath, '{malformed')
    keytarMock.deletePassword.mockImplementation(async (service, account) => {
      if (account === `session-token::${harness.envKey}`)
        throw new Error('fixture-active delete failed')
      return keychain.delete(keyOf(service, account))
    })
    keytarMock.setPassword.mockRejectedValue(new Error('fixture-active write failed'))

    await expect(harness.login()).rejects.toThrow('fixture-active write failed')

    expect(harness.service.getCachedUserId()).toBeNull()
    await expect(harness.tokenStore.getSafeStorageSessionToken(harness.envKey)).resolves.toBeNull()
    expect(
      harness.markers.readPendingExternalLogoutIntent(runtime.directory, harness.envKey)
    ).toEqual({ intent: 'logout-pending' })
    const restarted = await createService()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(restarted.authClient.getMe).not.toHaveBeenCalledWith(expectedFreshToken)
  })

  it('allows a first isolated-development login without secure storage after malformed repair', async () => {
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    const harness = await createService({ isolated: true })
    await fs.writeFile(harness.markerPath, '{malformed')

    await expect(harness.login()).resolves.toMatchObject({
      authenticated: true,
      me,
      sessionMode: 'temporary',
    })

    expect(await harness.tokenStore.getSessionToken(harness.envKey)).toBeNull()
    const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
    const selected = await readSessionAuthoritySourceSelection({
      tokenStore: harness.tokenStore,
      envKey: harness.envKey,
    })
    expect(selected).toEqual({ status: 'denied', frameMode: 'memory-only' })
    const marker = harness.markers.readPendingExternalLogoutMarker(
      runtime.directory,
      harness.envKey
    )
    expect(marker?.intent.intent).toBe('acceptance-pending')
    expect(marker?.intent).toMatchObject({
      expectedAuthorityRevision: expect.any(String),
      expectedAuthorityDigest: expect.any(String),
    })
    expect(keytarMock.setPassword).not.toHaveBeenCalled()
    expect(await fs.readdir(runtime.directory)).not.toContain(
      `session-token-${harness.envKey}.json`
    )
    expect(await fs.readdir(runtime.directory)).not.toContain(`session-token-${harness.envKey}.enc`)
  })

  it('repairs a malformed marker before publishing a fresh credential candidate', async () => {
    const harness = await createService()
    await fs.writeFile(harness.markerPath, '{malformed')
    let markerAtCandidateWrite: ReturnType<
      typeof harness.markers.readPendingExternalLogoutMarker
    > | null = null
    keytarMock.setPassword.mockImplementationOnce(async (service, account, token) => {
      markerAtCandidateWrite = harness.markers.readPendingExternalLogoutMarker(
        runtime.directory,
        harness.envKey
      )
      keychain.set(keyOf(service, account), token)
    })

    await expect(harness.login()).resolves.toMatchObject({ authenticated: true, me })

    expect(markerAtCandidateWrite?.intent).toEqual({ intent: 'logout-pending' })
    expect(markerAtCandidateWrite?.revision).toEqual(expect.any(String))
  })

  it('preserves the exact newer logout revision during a secure login write', async () => {
    const harness = await createService()
    harness.markers.recordPendingExternalLogout(runtime.directory, harness.envKey)
    let newerMarker: ReturnType<typeof harness.markers.readPendingExternalLogoutMarker> | undefined
    keytarMock.setPassword.mockImplementation(async (service, account, token) => {
      keychain.set(keyOf(service, account), token)
      harness.markers.recordPendingExternalLogout(runtime.directory, harness.envKey)
      newerMarker = harness.markers.readPendingExternalLogoutMarker(
        runtime.directory,
        harness.envKey
      )
    })

    const error = await harness.login().then(
      () => null,
      error => error
    )

    expect(
      harness.markers.readPendingExternalLogoutMarker(runtime.directory, harness.envKey)
    ).toEqual(newerMarker)
    expect(harness.service.getCachedUserId()).toBeNull()
    expect(await harness.tokenStore.getKeytarSessionToken(harness.envKey)).toBeNull()
    const restarted = await createService()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(restarted.authClient.getMe).not.toHaveBeenCalledWith(expectedFreshToken)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toMatch(/Pending logout intent changed|mutation was superseded/)
  })
})

describe('team persistence respects pending-marker authority', () => {
  it.each([
    { keytarState: 'failed', safeStorageAvailable: true },
    { keytarState: 'failed', safeStorageAvailable: false },
  ])(
    'keeps source-bound team persistence with $keytarState Keytar and safeStorage=$safeStorageAvailable',
    async ({ keytarState, safeStorageAvailable }) => {
      const harness = await createService()
      await harness.login()
      const { safeStorage } = await import('electron')
      vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(safeStorageAvailable)
      const markerBefore = harness.markers.readPendingExternalLogoutMarker(
        runtime.directory,
        harness.envKey
      )
      const { readSessionAuthoritySourceSelection } =
        await import('../sessionAuthorityAcceptance.js')
      const priorSelection = await readSessionAuthoritySourceSelection({
        tokenStore: harness.tokenStore,
        envKey: harness.envKey,
      })
      expect(priorSelection.status).toBe('accepted')
      if (priorSelection.status !== 'accepted') throw new Error('Expected prior accepted source')
      const priorSource = priorSelection.session.accepted.record.frame.source
      keytarMock.setPassword.mockRejectedValue(new Error('fixture-team Keytar write failed'))
      vi.spyOn(harness.authClient, 'switchTeam').mockResolvedValue({
        token: 'fixture-other-team-session',
      })
      const switchedMe = { ...me, teamId: 'fixture-other-team', teamName: 'Fixture other team' }
      vi.mocked(harness.authClient.getMe).mockResolvedValue(switchedMe)
      await expect(harness.service.switchTeam('fixture-other-team')).rejects.toThrow()
      // Team persistence is source-bound. A recovered or available S provider does not silently
      // replace the selected K source after an uncertain native write.
      await expect(
        harness.tokenStore.getSafeStorageSessionToken(harness.envKey)
      ).resolves.toBeNull()
      expect(harness.service.getCachedUserId()).toBe(me.id)
      // Team operations remain source-bound and preserve the exact V2 projection receipt.
      expect(harness.reportFailure).not.toHaveBeenCalled()
      expect(
        harness.markers.readPendingExternalLogoutMarker(runtime.directory, harness.envKey)
      ).toEqual(markerBefore)
      expect(await fs.readdir(runtime.directory)).not.toContain(
        `session-token-${harness.envKey}.enc`
      )
      expect(await fs.readdir(runtime.directory)).not.toContain(
        `session-token-${harness.envKey}.json`
      )
      const selected = await readSessionAuthoritySourceSelection({
        tokenStore: harness.tokenStore,
        envKey: harness.envKey,
      })
      expect(selected.status).toBe('accepted')
      if (selected.status !== 'accepted')
        throw new Error('Failed team transition displaced authority')
      expect(selected.session.token).toBe(expectedFreshToken)
      expect(selected.session.accepted.record.frame.source).toEqual(priorSource)
    }
  )

  // Characterization: only the exact accepted Keytar source is selected or retired.
  it('keeps V0 safeStorage residue outside accepted V1 team ownership', async () => {
    const harness = await createService()
    await harness.login()
    await harness.tokenStore.setSafeStorageSessionToken(
      'fixture-unrelated-file-token',
      harness.envKey
    )
    const switchedMe = { ...me, teamId: 'fixture-other-team', teamName: 'Fixture other team' }
    vi.mocked(harness.authClient.getMe).mockResolvedValue(switchedMe)
    vi.spyOn(harness.authClient, 'switchTeam').mockResolvedValue({
      token: 'fixture-other-team-session',
    })

    await expect(harness.service.switchTeam('fixture-other-team')).resolves.toMatchObject({
      authenticated: true,
      me: switchedMe,
    })

    const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
    const selected = await readSessionAuthoritySourceSelection({
      tokenStore: harness.tokenStore,
      envKey: harness.envKey,
    })
    expect(selected.status).toBe('accepted')
    if (selected.status !== 'accepted') throw new Error('Expected accepted team source')
    expect(selected.session.token).toBe('fixture-other-team-session')
    expect(selected.session.accepted.record.frame.source).toMatchObject({
      kind: 'keytar',
      format: 'v1',
    })
    expect(
      harness.markers.readPendingExternalLogoutMarker(runtime.directory, harness.envKey)?.intent
        .intent
    ).toBe('acceptance-pending')
    await expect(harness.tokenStore.getSafeStorageSessionToken(harness.envKey)).resolves.toBe(
      'fixture-unrelated-file-token'
    )
    const restarted = await createService()
    vi.mocked(restarted.authClient.getMe).mockResolvedValue(switchedMe)
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: switchedMe,
    })
    expect(restarted.authClient.getMe).not.toHaveBeenCalledWith('fixture-unrelated-file-token')
    await expect(restarted.tokenStore.getSafeStorageSessionToken(restarted.envKey)).resolves.toBe(
      'fixture-unrelated-file-token'
    )
    keytarMock.getPassword.mockRejectedValue(
      Object.assign(new Error('fixture-Keytar access denied'), { code: 'EACCES' })
    )
    const unavailable = await createService()
    await expect(unavailable.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(unavailable.service.getCachedUserId()).toBeNull()
    expect(unavailable.authClient.getMe).not.toHaveBeenCalledWith('fixture-unrelated-file-token')
  })

  it('reports marker corruption and clears runtime authentication before team persistence', async () => {
    const harness = await createService()
    await harness.login()
    await fs.writeFile(harness.markerPath, '{malformed')
    const writeToken = vi.spyOn(harness.tokenStore, 'setSessionToken')
    vi.spyOn(harness.authClient, 'switchTeam').mockResolvedValue({
      token: 'fixture-other-team-session',
    })

    await expect(harness.service.switchTeam('fixture-other-team')).rejects.toThrow()

    expect(harness.service.getCachedUserId()).toBeNull()
    expect(harness.authClient.switchTeam).not.toHaveBeenCalled()
    expect(writeToken).not.toHaveBeenCalled()
    expect(harness.reportFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'SessionAuthorityProjectionIntegrityError',
        source: 'marker',
        cause: expect.objectContaining({ message: 'Pending logout marker has an invalid format' }),
      })
    )
    expect(notifySessionChanged).toHaveBeenCalledWith(false)
    expect(await fs.readFile(harness.markerPath, 'utf8')).toBe('{malformed')
  })
})

describe('durable logout failure policy', () => {
  it('fails closed when logout cannot inspect a malformed marker and keeps restart denied', async () => {
    const harness = await createService()
    await expect(harness.login()).resolves.toMatchObject({ authenticated: true, me })
    expect(harness.service.getCachedUserId()).toBe(me.id)
    await fs.writeFile(harness.markerPath, '{malformed')
    vi.mocked(harness.authClient.getMe).mockClear()

    await expect(harness.service.logout()).resolves.toMatchObject({ kind: 'not-committed' })

    expect(harness.service.getCachedUserId()).toBeNull()
    expect((harness.service as unknown as { sessionToken: string | null }).sessionToken).toBeNull()
    const { requireChatStore } = await import('../chatStoreBinding.js')
    expect(() => requireChatStore()).toThrow('Not authenticated')
    expect(await fs.readFile(harness.markerPath, 'utf8')).toBe('{malformed')

    const restarted = await createService()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(restarted.authClient.getMe).not.toHaveBeenCalled()
    expect(() => requireChatStore()).toThrow('Not authenticated')
  })

  it.each(['active-keytar', 'safe-storage'] as const)(
    'uses only the approved %s source while resolving a legacy cleanup marker',
    async source => {
      const harness = await createService()
      harness.markers.recordPendingKeytarCleanup(runtime.directory, harness.envKey, source)
      const marker = harness.markers.readPendingExternalLogoutMarker(
        runtime.directory,
        harness.envKey
      )
      expect(marker).not.toBeNull()
      const denied = Object.assign(new Error('fixture-Keytar access denied'), { code: 'EACCES' })
      keytarMock.getPassword.mockRejectedValue(denied)
      keytarMock.setPassword.mockRejectedValue(denied)
      keytarMock.deletePassword.mockRejectedValue(denied)
      const candidateWrite = vi.spyOn(harness.tokenStore, 'writeSessionTokenCandidate')

      const { readSessionAuthoritySourceSelection } =
        await import('../sessionAuthorityAcceptance.js')
      await expect(harness.login()).resolves.toMatchObject({ authenticated: true, me })
      expect(harness.service.getCachedUserId()).toBe(me.id)
      expect(candidateWrite).toHaveBeenCalledOnce()
      expect(harness.authClient.getMe).toHaveBeenCalledWith(expectedFreshToken)
      expect(harness.authClient.getMe).not.toHaveBeenCalledWith('fixture-v0-legacy-keytar-session')
      expect(
        harness.markers.readPendingExternalLogoutIntent(runtime.directory, harness.envKey)
      ).toMatchObject({ intent: 'acceptance-pending' })
      const selected = await readSessionAuthoritySourceSelection({
        tokenStore: harness.tokenStore,
        envKey: harness.envKey,
      })
      expect(selected.status).toBe('accepted')
      if (selected.status !== 'accepted') throw new Error('Expected a fresh V1 session')
      expect(selected.session.token).toBe(expectedFreshToken)
      expect(selected.session.accepted.record.frame.source).toMatchObject({
        format: 'v1',
        kind: 'safe-storage',
      })

      const restarted = await createService()
      await expect(restarted.service.initialize()).resolves.toEqual({
        authenticated: true,
        me,
      })
      expect(restarted.authClient.getMe).toHaveBeenCalledWith(expectedFreshToken)
      expect(restarted.authClient.getMe).not.toHaveBeenCalledWith(
        'fixture-v0-legacy-keytar-session'
      )
    }
  )

  it('signs out at durable LP plus exact debt while cleanup retries', async () => {
    const harness = await createService()
    await harness.login()
    const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
    const before = await readSessionAuthoritySourceSelection({
      tokenStore: harness.tokenStore,
      envKey: harness.envKey,
    })
    expect(before.status).toBe('accepted')
    if (before.status !== 'accepted') throw new Error('Expected an accepted source before logout')
    const priorSource = before.session.accepted.record.frame.source
    const entered = deferred()
    const release = deferred()
    const cleanupSettled = deferred<void>()
    const deleteSource = harness.tokenStore.deleteSessionCredentialSourceIfUnselectedWithProof.bind(
      harness.tokenStore
    )
    let cleanupSource: unknown
    vi.spyOn(
      harness.tokenStore,
      'deleteSessionCredentialSourceIfUnselectedWithProof'
    ).mockImplementationOnce(async (...args) => {
      cleanupSource = args[0]
      entered.resolve()
      await release.promise
      try {
        return await deleteSource(...args)
      } finally {
        cleanupSettled.resolve()
      }
    })

    try {
      await expect(harness.service.logout()).resolves.toMatchObject({
        kind: 'committed',
        cleanup: 'pending',
      })
      await entered.promise
      expect(harness.service.getCachedUserId()).toBeNull()
      expect(
        harness.markers.readPendingExternalLogoutIntent(runtime.directory, harness.envKey)
      ).toEqual({ intent: 'logout-pending' })
      await expect(
        readSessionAuthoritySourceSelection({
          tokenStore: harness.tokenStore,
          envKey: harness.envKey,
        })
      ).resolves.toMatchObject({ status: 'denied', frameMode: 'logged-out' })
      expect(cleanupSource).toEqual(priorSource)
    } finally {
      release.resolve()
      await cleanupSettled.promise
    }

    const nextToken = sessionToken('fixture-session-after-logout')
    await expect(harness.login(nextToken)).resolves.toEqual({ authenticated: true, me })
    const restarted = await createService()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me,
    })
    expect(restarted.authClient.getMe).toHaveBeenCalledWith(nextToken)
    expect(harness.service.getCachedUserId()).toBe(me.id)
    const after = await readSessionAuthoritySourceSelection({
      tokenStore: harness.tokenStore,
      envKey: harness.envKey,
    })
    expect(after.status).toBe('accepted')
    if (after.status !== 'accepted') throw new Error('Fresh login did not replace logout denial')
    expect(after.session.token).toBe(nextToken)
    expect(after.session.accepted.record.frame.source?.sourceRef).not.toBe(priorSource?.sourceRef)
  })

  it('allows temporary login without reading unavailable legacy source inventory', async () => {
    const harness = await createService()
    await harness.login()
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    const denied = Object.assign(new Error('fixture-Keytar access denied'), { code: 'EACCES' })
    keytarMock.getPassword.mockRejectedValue(denied)
    keytarMock.setPassword.mockRejectedValue(denied)
    keytarMock.deletePassword.mockRejectedValue(denied)

    await expect(harness.service.logout()).resolves.toMatchObject({ kind: 'committed' })
    const temporaryToken = sessionToken('temporary-after-logout')
    await expect(harness.login(temporaryToken)).resolves.toMatchObject({
      authenticated: true,
      me,
      sessionMode: 'temporary',
    })
    expect(harness.service.getCachedUserId()).toBe(me.id)
    const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
    expect(
      await readSessionAuthoritySourceSelection({
        tokenStore: harness.tokenStore,
        envKey: harness.envKey,
      })
    ).toMatchObject({ status: 'denied', frameMode: 'memory-only' })
    expect(keytarMock.setPassword).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('session-v1-'),
      expect.anything()
    )
  })

  it('keeps durable LP and exact source debt when cleanup fails after local sign-out', async () => {
    const harness = await createService()
    await harness.login()
    const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
    const prior = await readSessionAuthoritySourceSelection({
      tokenStore: harness.tokenStore,
      envKey: harness.envKey,
    })
    expect(prior.status).toBe('accepted')
    if (prior.status !== 'accepted') throw new Error('Expected a selected credential source')
    const priorSource = prior.session.accepted.record.frame.source
    const cleanupSettled = deferred<void>()
    vi.spyOn(
      harness.tokenStore,
      'deleteSessionCredentialSourceIfUnselectedWithProof'
    ).mockImplementationOnce(async () => {
      cleanupSettled.resolve()
      throw Object.assign(new Error('fixture-Keytar cleanup failed'), { code: 'EIO' })
    })

    await expect(harness.service.logout()).resolves.toMatchObject({
      kind: 'committed',
      cleanup: 'pending',
    })
    await cleanupSettled.promise
    await vi.waitFor(() => {
      expect(harness.reportFailure).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'fixture-Keytar cleanup failed', code: 'EIO' })
      )
    })

    expect(harness.service.getCachedUserId()).toBeNull()
    expect(
      harness.markers.readPendingExternalLogoutIntent(runtime.directory, harness.envKey)
    ).toEqual({
      intent: 'logout-pending',
    })
    expect(notifySessionChanged).toHaveBeenCalledWith(false)
    const lease = harness.tokenStore.beginSessionAuthorityTransaction()
    try {
      const observed = await harness.tokenStore.runWithSessionAuthorityTransaction(
        lease,
        async () => {
          const scope = await harness.tokenStore.createSessionAuthorityStorageScope()
          const { SessionAuthorityRecordRepository } = await import('../sessionAuthorityRecord.js')
          const repository = new SessionAuthorityRecordRepository(
            scope,
            harness.envKey,
            harness.tokenStore,
            lease
          )
          return repository.observe()
        }
      )
      expect(observed.status).toBe('observed')
      if (observed.status !== 'observed') throw new Error('Expected durable logout authority')
      expect(observed.record.frame.mode).toBe('logged-out')
      expect(observed.record.cleanupDebts).toEqual(
        expect.arrayContaining([expect.objectContaining({ source: priorSource })])
      )
    } finally {
      harness.tokenStore.finishSessionAuthorityTransaction(lease)
    }
    const restarted = await createService()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(restarted.authClient.getMe).not.toHaveBeenCalledWith(expectedFreshToken)
  })
})
