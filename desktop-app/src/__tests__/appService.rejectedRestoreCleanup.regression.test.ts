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

describe('R9-M2 rejected restore cleanup preserves independent accepted producers', () => {
  it('preserves a fresh encrypted CP-S login while older rejected cleanup awaits dispatch', async () => {
    const old = await harness()
    await old.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    const { ApiError } = await import('../httpClient.js')
    const started = deferred()
    const release = deferred()
    const fresh = 'fixture-newer-encrypted-login'
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
    // Delegate to the real cleanup. The response boundary is version-neutral:
    // old heads broad-clear; the corrected source-owned flow uses native-only cleanup.
    const clearAll = old.tokenStore.clearSessionToken.bind(old.tokenStore)
    vi.spyOn(old.tokenStore, 'clearSessionToken').mockImplementation(async (...args) => {
      await delayRejectedCleanup()
      return clearAll(...args)
    })
    const clearNative = old.tokenStore.clearKeytarSessionTokensStrictly.bind(old.tokenStore)
    vi.spyOn(old.tokenStore, 'clearKeytarSessionTokensStrictly').mockImplementation(
      async (...args) => {
        await delayRejectedCleanup()
        return clearNative(...args)
      }
    )
    vi.mocked(old.state.authClient.getMe).mockImplementationOnce(async () => {
      rejected = true
      throw new ApiError('fixture-expired saved Home', 401, 'unauthorized')
    })
    const restore = old.service.initialize()
    let login: Promise<unknown> | undefined
    const newer = await harness()
    let winningMarker: ReturnType<typeof old.markers.readPendingExternalLogoutMarker>
    try {
      await enteredWithin(started.promise, 'old 401 cleanup awaiting real dispatch')
      boundary.setPassword.mockImplementation(async () => {
        throw new Error('fixture-native setter unavailable before replacement')
      })
      login = newer.state.installAuthenticatedLogin({ token: fresh, me: freshMe })
      await expect(login).resolves.toEqual({ authenticated: true, me: freshMe })
      await expect(newer.tokenStore.getSafeStorageSessionToken(newer.envKey)).resolves.toBe(fresh)
      expect(newer.state.sessionToken).toBe(fresh)
      winningMarker = newer.markers.readPendingExternalLogoutMarker(runtime.directory, newer.envKey)
    } finally {
      release.resolve()
      await Promise.allSettled([restore, login])
    }
    expect(held).toBe(true)
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
    expect(winningMarker?.intent).toEqual({
      intent: 'keytar-cleanup-pending',
      credentialSource: 'safe-storage',
    })
    await expect(newer.tokenStore.getSafeStorageSessionToken(newer.envKey)).resolves.toBe(fresh)
    expect(newer.state.sessionToken).toBe(fresh)
    expect(newer.state.me).toEqual(freshMe)
  })

  it('preserves fresh native authority even when its marker remains absent', async () => {
    const old = await harness()
    await old.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
    const { ApiError } = await import('../httpClient.js')
    const started = deferred()
    const release = deferred()
    const fresh = 'fixture-newer-native-login'
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
      login = newer.state.installAuthenticatedLogin({ token: fresh, me: freshMe })
      await expect(login).resolves.toEqual({ authenticated: true, me: freshMe })
      await expect(newer.tokenStore.getKeytarSessionToken(newer.envKey)).resolves.toBe(fresh)
      expect(
        newer.markers.readPendingExternalLogoutMarker(runtime.directory, newer.envKey)
      ).toBeNull()
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
    await expect(newer.tokenStore.getKeytarSessionToken(newer.envKey)).resolves.toBe(fresh)
    expect(
      newer.markers.readPendingExternalLogoutMarker(runtime.directory, newer.envKey)
    ).toBeNull()
    expect(newer.state.sessionToken).toBe(fresh)
    expect(newer.state.me).toEqual(freshMe)
  })
})

describe('R9-M2 identical-value publication still has a newer owner', () => {
  it.each(['native', 'isolated-plaintext'] as const)(
    'preserves newly accepted same-value %s authority after an older stored-session 401',
    async source => {
      const isolated = source === 'isolated-plaintext'
      if (isolated) {
        const { safeStorage } = await import('electron')
        vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
      }
      const old = await harness({ isolated })
      await old.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
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
      const newer = await harness({ isolated })
      try {
        await enteredWithin(started.promise, 'older same-value getMe')
        login = newer.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
        await expect(login).resolves.toEqual({ authenticated: true, me: homeMe })
        await expect(
          newer.tokenStore.getSessionToken(newer.envKey, {
            allowLegacyMigration: false,
          })
        ).resolves.toBe(homeToken)
        expect(
          newer.markers.readPendingExternalLogoutMarker(runtime.directory, newer.envKey)
        ).toBeNull()
      } finally {
        release.resolve()
        await Promise.allSettled([restore, login])
      }
      const restarted = await harness({ isolated })
      await expect(restarted.service.initialize()).resolves.toEqual({
        authenticated: true,
        me: homeMe,
      })
      await expect(
        newer.tokenStore.getSessionToken(newer.envKey, {
          allowLegacyMigration: false,
        })
      ).resolves.toBe(homeToken)
      expect(newer.state.sessionToken).toBe(homeToken)
      expect(newer.state.me).toEqual(homeMe)
      expect(
        newer.markers.readPendingExternalLogoutMarker(runtime.directory, newer.envKey)
      ).toBeNull()
    }
  )
})
