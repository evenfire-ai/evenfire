import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
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
    externalRestApiBaseUrl: 'https://auth.r21-l1.example.test',
    rpcProxyBaseUrl: 'https://rpc.r21-l1.example.test',
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
  vi.spyOn(state.authClient, 'passwordLogin').mockResolvedValue({ token: homeToken, me: homeMe })
  const envKey = config.getActiveEnvKey()
  const markerPath = path.join(
    runtime.directory,
    `pending-external-logout-${createHash('sha256').update(envKey).digest('hex')}`
  )
  return { service, tokenStore, markers, config, envKey, markerPath, state, reportFailure }
}

describe('R21-L1 complete stale fallback authority', () => {
  it('ignores V0 residue and accepts a new V1 safeStorage session when Keytar is unavailable', async () => {
    const h = await harness()
    const envKey = h.config.getActiveEnvKey()
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    const isolated = await harness({ isolated: true })
    await isolated.tokenStore.setSessionToken(homeToken, envKey)
    const plaintextPath = path.join(runtime.directory, `session-token-${envKey}.json`)
    const plaintextBefore = await fs.readFile(plaintextPath)
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
    vi.doMock('keytar', () => ({}))
    const freshToken = 'fixture-r21-fresh-encrypted-user'
    const freshMe = { ...homeMe, id: 'fixture-r21-fresh-user' }
    vi.spyOn(h.state.authClient, 'passwordLogin').mockResolvedValue({
      token: freshToken,
      me: freshMe,
    })
    const getMe = vi.spyOn(h.state.authClient, 'getMe').mockResolvedValue(freshMe)
    await expect(h.service.passwordLogin(freshMe.email, 'fixture-password')).resolves.toEqual({
      authenticated: true,
      me: freshMe,
    })
    expect(getMe).toHaveBeenCalledWith(freshToken)
    expect(h.state.sessionToken).toBe(freshToken)
    expect(h.state.me).toEqual(freshMe)
    expect(await fs.readFile(plaintextPath)).toEqual(plaintextBefore)
    const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
    const accepted = await readSessionAuthoritySourceSelection({ tokenStore: h.tokenStore, envKey })
    expect(accepted.status).toBe('accepted')
    if (accepted.status !== 'accepted') throw new Error('Expected accepted V1 source')
    expect(accepted.session.token).toBe(freshToken)
    expect(accepted.session.accepted.record.frame.source).toMatchObject({
      format: 'v1',
      kind: 'safe-storage',
    })
    vi.doMock('keytar', () => boundary)
    const healthy = await harness()
    const restartGetMe = vi.spyOn(healthy.state.authClient, 'getMe').mockResolvedValue(freshMe)
    await expect(healthy.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: freshMe,
    })
    expect(restartGetMe).toHaveBeenCalledWith(freshToken)
    expect(healthy.state.sessionToken).toBe(freshToken)
    expect(healthy.state.me).toEqual(freshMe)
    expect(await fs.readFile(plaintextPath)).toEqual(plaintextBefore)
  })
  it.each([
    { source: 'encrypted', scope: 'active' },
    { source: 'historical-plaintext', scope: 'active' },
    { source: 'encrypted', scope: 'legacy-env' },
    { source: 'historical-plaintext', scope: 'legacy-env' },
    { source: 'encrypted', scope: 'legacy-global' },
    { source: 'historical-plaintext', scope: 'legacy-global' },
  ] as const)(
    'does not authenticate a prior-user $scope $source value after a fresh no-marker native login',
    async ({ source, scope }) => {
      const h = await harness()
      const previousToken = 'fixture-previous-user-session'
      const previousMe = { ...homeMe, id: 'fixture-previous-user' }
      const legacyNamespace = h.config.getActiveLegacyEnvKeyInventory()
      expect(legacyNamespace.complete).toBe(true)
      const legacyEnvKey = legacyNamespace.keys[0]
      if (!legacyEnvKey) throw new Error('Expected a verified pre-RPC environment key')
      const sourceEnvKey = scope === 'legacy-env' ? legacyEnvKey : h.envKey
      if (source === 'encrypted') {
        await h.tokenStore.setSafeStorageSessionToken(previousToken, sourceEnvKey)
      } else {
        const { safeStorage } = await import('electron')
        vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
        const isolated = await harness({ isolated: true })
        await isolated.tokenStore.setSessionToken(previousToken, sourceEnvKey)
        vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
      }
      if (scope === 'legacy-global') {
        const extension = source === 'encrypted' ? 'enc' : 'json'
        await fs.rename(
          path.join(runtime.directory, `session-token-${sourceEnvKey}.${extension}`),
          path.join(runtime.directory, `session-token.${extension}`)
        )
      }
      expect(h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)).toBeNull()
      await h.service.passwordLogin(homeMe.email, 'fixture-password')
      expect(h.state.sessionToken).toBe(homeToken)
      const { readSessionAuthoritySourceSelection } =
        await import('../sessionAuthorityAcceptance.js')
      const selected = await readSessionAuthoritySourceSelection({
        tokenStore: h.tokenStore,
        envKey: h.envKey,
      })
      expect(selected.status).toBe('accepted')
      if (selected.status !== 'accepted') throw new Error('Expected the fresh V1 authority')
      expect(selected.session.token).toBe(homeToken)
      const selectedSource = selected.session.accepted.record.frame.source
      expect(selectedSource).toMatchObject({ format: 'v1', kind: 'keytar', accountId: homeMe.id })
      if (!selectedSource || selectedSource.format !== 'v1' || selectedSource.kind !== 'keytar')
        throw new Error('Expected the selected V1 Keytar source')
      const selectedAccount = `session-v1:${selectedSource.sourceRef}`
      boundary.getPassword.mockImplementation(async (service, account) => {
        if (account === selectedAccount)
          throw Object.assign(new Error('fixture selected source is unavailable'), {
            code: 'EACCES',
          })
        return boundary.keychain.get(keyOf(service, account)) ?? null
      })
      vi.resetModules()
      vi.doMock('keytar', () => boundary)
      const restarted = await harness()
      vi.mocked(restarted.state.authClient.getMe).mockImplementation(async token =>
        token === previousToken ? previousMe : homeMe
      )
      const result = await restarted.service.initialize()
      expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(previousToken)
      expect(result.authenticated).toBe(false)
      expect(restarted.service.getCachedUserId()).toBeNull()
    }
  )
})
