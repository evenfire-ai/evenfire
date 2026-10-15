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
    encryptString: vi.fn((value: string) => Buffer.from(`encrypted:${value}`)),
    decryptString: vi.fn((value: Buffer) => value.toString().replace(/^encrypted:/, '')),
  },
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
    authClient: {
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

describe('R21-L1 complete stale fallback authority', () => {
  it('retires CP-S extras without exposing historical plaintext during a later encryption outage', async () => {
    const h = await harness()
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    const isolated = await harness({ isolated: true })
    await isolated.tokenStore.setSessionToken(homeToken, h.envKey)
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
    vi.doMock('keytar', () => ({}))
    const freshToken = 'fixture-r21-fresh-encrypted-user'
    const freshMe = { ...homeMe, id: 'fixture-r21-fresh-user' }
    await h.state.installAuthenticatedLogin({ token: freshToken, me: freshMe })
    expect(h.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)?.intent).toEqual({
      intent: 'keytar-cleanup-pending',
      credentialSource: 'safe-storage',
    })
    vi.doMock('keytar', () => boundary)
    const healthy = await harness()
    vi.mocked(healthy.state.authClient.getMe).mockImplementation(async token =>
      token === freshToken ? freshMe : homeMe
    )
    await expect(healthy.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: freshMe,
    })
    expect(healthy.markers.readPendingExternalLogoutMarker(runtime.directory, h.envKey)).toBeNull()
    expect(await healthy.tokenStore.getSafeStorageSessionToken(h.envKey)).toBe(freshToken)
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    const outage = await harness()
    vi.mocked(outage.state.authClient.getMe).mockImplementation(async token =>
      token === freshToken ? freshMe : homeMe
    )
    await expect(outage.service.initialize()).resolves.toEqual({ authenticated: false, me: null })
    expect(outage.state.authClient.getMe).not.toHaveBeenCalledWith(homeToken)
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
      const legacyEnvKey = 'fixturelegacy-333333333333'
      const sourceEnvKey = scope === 'legacy-env' ? legacyEnvKey : h.envKey
      if (scope === 'legacy-env') {
        const config = await import('../config.js')
        vi.spyOn(config, 'getActiveLegacyEnvKeys').mockReturnValue([legacyEnvKey])
      }
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
      await h.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
      expect(h.state.sessionToken).toBe(homeToken)
      expect(await h.tokenStore.getKeytarSessionToken(h.envKey)).toBe(homeToken)
      vi.doMock('keytar', () => ({}))
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
