import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import fsSync from 'node:fs'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const runtime = vi.hoisted(() => ({ directory: '' }))
const { notifySessionChanged } = vi.hoisted(() => ({ notifySessionChanged: vi.fn() }))
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
vi.mock('../chatStoreBinding.js', () => ({
  bindChatStoreForUser: vi.fn(),
  unbindChatStore: vi.fn(),
  __setChatStoreBaseDirForTests: vi.fn(),
}))
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
      }
    }
  ).authClient
  vi.spyOn(authClient, 'getMe').mockResolvedValue(me)
  const login = (token = expectedFreshToken) =>
    (
      service as unknown as {
        installAuthenticatedLogin: (result: { token: string; me: typeof me }) => Promise<unknown>
      }
    ).installAuthenticatedLogin({ token, me })
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
  it('recovers malformed regular bytes with failing Keytar and verified safeStorage', async () => {
    const harness = await createService()
    await fs.writeFile(harness.markerPath, '{malformed')
    keytarMock.getPassword.mockRejectedValue(new Error('fixture-Keytar unavailable'))
    keytarMock.setPassword.mockRejectedValue(new Error('fixture-Keytar unavailable'))
    keytarMock.deletePassword.mockRejectedValue(new Error('fixture-Keytar unavailable'))

    await expect(harness.login()).resolves.toEqual({ authenticated: true, me })

    expect(await harness.tokenStore.getSafeStorageSessionToken(harness.envKey)).toBe(
      expectedFreshToken
    )
    expect(
      harness.markers.readPendingExternalLogoutIntent(runtime.directory, harness.envKey)
    ).toEqual({
      intent: 'keytar-cleanup-pending',
      credentialSource: 'safe-storage',
    })
    expect(harness.service.getCachedUserId()).toBe(me.id)
    expect(harness.reportFailure).toHaveBeenCalled()
    expect(await fs.readdir(runtime.directory)).not.toContain(
      `session-token-${harness.envKey}.json`
    )
    const restarted = await createService()
    await expect(restarted.service.initialize()).resolves.toEqual({ authenticated: true, me })
    expect(restarted.authClient.getMe).toHaveBeenCalledWith(expectedFreshToken)
  })

  it('recovers malformed regular bytes when the Keytar module is absent', async () => {
    vi.doMock('keytar', () => ({}))
    const harness = await createService()
    await fs.writeFile(harness.markerPath, '{malformed')

    await expect(harness.login()).resolves.toEqual({ authenticated: true, me })

    expect(await harness.tokenStore.getSafeStorageSessionToken(harness.envKey)).toBe(
      expectedFreshToken
    )
    expect(
      harness.markers.readPendingExternalLogoutIntent(runtime.directory, harness.envKey)
    ).toEqual({
      intent: 'keytar-cleanup-pending',
      credentialSource: 'safe-storage',
    })
    expect(await fs.readdir(runtime.directory)).not.toContain(
      `session-token-${harness.envKey}.json`
    )
  })

  it('converts normalized logout intent after an active-Keytar replacement write fails', async () => {
    const harness = await createService()
    await fs.writeFile(harness.markerPath, '{malformed')
    keytarMock.deletePassword.mockImplementation(async (service, account) => {
      if (account === `session-token::${harness.envKey}`)
        throw new Error('fixture-active delete failed')
      return keychain.delete(keyOf(service, account))
    })
    keytarMock.setPassword.mockRejectedValue(new Error('fixture-active write failed'))

    await expect(harness.login()).resolves.toEqual({ authenticated: true, me })

    expect(await harness.tokenStore.getSafeStorageSessionToken(harness.envKey)).toBe(
      expectedFreshToken
    )
    expect(
      harness.markers.readPendingExternalLogoutIntent(runtime.directory, harness.envKey)
    ).toEqual({
      intent: 'keytar-cleanup-pending',
      credentialSource: 'safe-storage',
    })
  })

  it('allows a first isolated-development login without secure storage after malformed repair', async () => {
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    const harness = await createService({ isolated: true })
    await fs.writeFile(harness.markerPath, '{malformed')

    await expect(harness.login()).resolves.toEqual({ authenticated: true, me })

    expect(await harness.tokenStore.getSessionToken(harness.envKey)).toBe(expectedFreshToken)
    expect(
      harness.markers.readPendingExternalLogoutMarker(runtime.directory, harness.envKey)
    ).toBeNull()
    expect(keytarMock.setPassword).not.toHaveBeenCalled()
    expect(await fs.readdir(runtime.directory)).toContain(`session-token-${harness.envKey}.json`)
  })

  it('normalizes the content hash before asynchronous cleanup begins', async () => {
    const harness = await createService()
    await fs.writeFile(harness.markerPath, '{malformed')
    const entered = deferred()
    const release = deferred()
    const snapshot = harness.tokenStore.snapshotSessionTokenFallbackFiles.bind(harness.tokenStore)
    vi.spyOn(harness.tokenStore, 'snapshotSessionTokenFallbackFiles').mockImplementationOnce(
      async (...args) => {
        entered.resolve()
        await release.promise
        return snapshot(...args)
      }
    )
    const result = harness.login()
    await entered.promise
    let marker: ReturnType<typeof harness.markers.readPendingExternalLogoutMarker> | undefined
    let inspectionError: unknown
    try {
      marker = harness.markers.readPendingExternalLogoutMarker(runtime.directory, harness.envKey)
    } catch (error) {
      inspectionError = error
    } finally {
      release.resolve()
      await result
    }

    expect(inspectionError).toBeUndefined()
    expect(marker?.intent).toEqual({ intent: 'logout-pending' })
    expect(marker?.revision).toEqual(expect.any(String))
  })

  it('preserves the exact newer logout revision during a secure login write', async () => {
    const harness = await createService()
    await fs.writeFile(harness.markerPath, '{malformed')
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
    expect(notifySessionChanged).toHaveBeenCalledWith(false)
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
    { keytarState: 'absent', safeStorageAvailable: true },
    { keytarState: 'absent', safeStorageAvailable: false },
  ])(
    'keeps source-bound team persistence with $keytarState Keytar and safeStorage=$safeStorageAvailable',
    async ({ keytarState, safeStorageAvailable }) => {
      const harness = await createService()
      await harness.login()
      const { safeStorage } = await import('electron')
      vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(safeStorageAvailable)
      harness.markers.recordPendingKeytarCleanup(runtime.directory, harness.envKey, 'active-keytar')
      if (keytarState === 'absent') {
        vi.doMock('keytar', () => ({}))
      } else {
        keytarMock.setPassword.mockRejectedValue(new Error('fixture-team Keytar write failed'))
      }
      vi.spyOn(harness.authClient, 'switchTeam').mockResolvedValue({
        token: 'fixture-other-team-session',
      })
      const switchedMe = { ...me, teamId: 'fixture-other-team', teamName: 'Fixture other team' }
      vi.mocked(harness.authClient.getMe).mockResolvedValue(switchedMe)
      if (safeStorageAvailable) {
        await expect(harness.service.switchTeam('fixture-other-team')).resolves.toEqual({
          authenticated: true,
          me: switchedMe,
        })
        expect(await harness.tokenStore.getSafeStorageSessionToken(harness.envKey)).toBe(
          'fixture-other-team-session'
        )
      } else {
        await expect(harness.service.switchTeam('fixture-other-team')).rejects.toThrow(
          /Keytar|safeStorage/
        )
        // Missing Keytar cannot mutate its slot; an ordinary failed setter's
        // working reader verifies the old slot. Neither case destroys the old session.
        if (keytarState === 'failed')
          expect(await harness.tokenStore.getKeytarSessionToken(harness.envKey)).toBe(
            expectedFreshToken
          )
      }
      expect(harness.service.getCachedUserId()).toBe(me.id)
      expect(harness.reportFailure).toHaveBeenCalled()
      expect(notifySessionChanged).not.toHaveBeenCalledWith(false)
      expect(
        harness.markers.readPendingExternalLogoutIntent(runtime.directory, harness.envKey)
      ).toEqual({
        intent: 'keytar-cleanup-pending',
        credentialSource: safeStorageAvailable ? 'safe-storage' : 'active-keytar',
      })
      if (!safeStorageAvailable)
        expect(await fs.readdir(runtime.directory)).not.toContain(
          `session-token-${harness.envKey}.enc`
        )
      expect(await fs.readdir(runtime.directory)).not.toContain(
        `session-token-${harness.envKey}.json`
      )
    }
  )

  // Characterization: successful source-bound team writes retain the established restore path.
  it('restores a successful active-Keytar team switch and retires unrelated safeStorage bytes', async () => {
    const harness = await createService()
    await harness.login()
    harness.markers.recordPendingKeytarCleanup(runtime.directory, harness.envKey, 'active-keytar')
    await harness.tokenStore.setSafeStorageSessionToken(
      'fixture-unrelated-file-token',
      harness.envKey
    )
    const switchedMe = { ...me, teamId: 'fixture-other-team', teamName: 'Fixture other team' }
    vi.mocked(harness.authClient.getMe).mockResolvedValue(switchedMe)
    vi.spyOn(harness.authClient, 'switchTeam').mockResolvedValue({
      token: 'fixture-other-team-session',
    })

    await expect(harness.service.switchTeam('fixture-other-team')).resolves.toEqual({
      authenticated: true,
      me: switchedMe,
    })

    expect(await harness.tokenStore.getKeytarSessionToken(harness.envKey)).toBe(
      'fixture-other-team-session'
    )
    expect(await harness.tokenStore.getSafeStorageSessionToken(harness.envKey)).toBeNull()
    const restarted = await createService()
    vi.mocked(restarted.authClient.getMe).mockResolvedValue(switchedMe)
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: switchedMe,
    })
    expect(restarted.authClient.getMe).toHaveBeenCalledWith('fixture-other-team-session')
    expect(restarted.authClient.getMe).not.toHaveBeenCalledWith('fixture-unrelated-file-token')
    vi.doMock('keytar', () => ({}))
    const unavailable = await createService()
    await expect(unavailable.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
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

    await expect(harness.service.switchTeam('fixture-other-team')).rejects.toThrow('invalid format')

    expect(harness.service.getCachedUserId()).toBeNull()
    expect(writeToken).not.toHaveBeenCalled()
    expect(harness.reportFailure).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Pending logout marker has an invalid format' })
    )
    expect(notifySessionChanged).toHaveBeenCalledWith(false)
    expect(await fs.readFile(harness.markerPath, 'utf8')).toBe('{malformed')
  })
})

describe('durable logout failure policy', () => {
  it.each(['read-back', 'conversion-rename'] as const)(
    'blocks rejected login restore when its original cleanup marker survives a %s failure',
    async failureStage => {
      const harness = await createService()
      await harness.tokenStore.setSafeStorageSessionToken(
        'fixture-previous-session',
        harness.envKey
      )
      harness.markers.recordPendingKeytarCleanup(runtime.directory, harness.envKey, 'safe-storage')
      keytarMock.getPassword.mockRejectedValue(new Error('fixture-Keytar unavailable'))
      keytarMock.setPassword.mockRejectedValue(new Error('fixture-Keytar unavailable'))
      keytarMock.deletePassword.mockRejectedValue(new Error('fixture-Keytar unavailable'))
      let failureInjected = false
      if (failureStage === 'read-back') {
        const { safeStorage } = await import('electron')
        vi.mocked(safeStorage.decryptString).mockImplementationOnce(() => {
          failureInjected = true
          throw new Error('fixture-owned cleanup read-back failed')
        })
      } else {
        const rename = fsSync.renameSync.bind(fsSync)
        vi.spyOn(fsSync, 'renameSync').mockImplementation((source, destination) => {
          if (!failureInjected && String(destination) === harness.markerPath) {
            failureInjected = true
            throw new Error('fixture-owned cleanup conversion rename failed')
          }
          rename(source, destination)
        })
      }
      const unlink = fs.unlink.bind(fs)
      vi.spyOn(fs, 'unlink').mockImplementation(async file => {
        if (failureInjected && String(file).endsWith(`session-token-${harness.envKey}.enc`)) {
          throw Object.assign(new Error('fixture-fresh credential rollback failed'), {
            code: 'EACCES',
          })
        }
        return unlink(file)
      })

      if (failureStage === 'read-back') {
        await expect(harness.login()).resolves.toMatchObject({
          authenticated: true,
          me,
          sessionMode: 'temporary',
        })
        expect(
          harness.markers.readPendingExternalLogoutIntent(runtime.directory, harness.envKey)
        ).toMatchObject({ intent: 'memory-only-session' })
        expect(harness.service.getCachedUserId()).toBe(me.id)
      } else {
        await expect(harness.login()).rejects.toThrow('fixture-owned cleanup')
        expect(harness.service.getCachedUserId()).toBeNull()
      }
      expect(failureInjected).toBe(true)
      const restarted = await createService()
      await expect(restarted.service.initialize()).resolves.toEqual({
        authenticated: false,
        me: null,
      })
    }
  )

  // Ownership guard: a different producer's successful conversion must survive rollback.
  it('preserves a newer cleanup revision when its own conversion durability fails', async () => {
    const harness = await createService()
    harness.markers.recordPendingExternalLogout(runtime.directory, harness.envKey)
    keytarMock.getPassword.mockRejectedValue(new Error('fixture-Keytar unavailable'))
    keytarMock.setPassword.mockRejectedValue(new Error('fixture-Keytar unavailable'))
    keytarMock.deletePassword.mockRejectedValue(new Error('fixture-Keytar unavailable'))
    let conversionFailed = false
    let newerMarker: ReturnType<typeof harness.markers.readPendingExternalLogoutMarker> | undefined
    const sync = fsSync.fsyncSync.bind(fsSync)
    vi.spyOn(fsSync, 'fsyncSync').mockImplementation(descriptor => {
      const current = harness.markers.readPendingExternalLogoutMarker(
        runtime.directory,
        harness.envKey
      )
      if (
        !conversionFailed &&
        fsSync.fstatSync(descriptor).isDirectory() &&
        current?.intent.intent === 'keytar-cleanup-pending'
      ) {
        conversionFailed = true
        harness.markers.recordPendingKeytarCleanupIfUnchanged(
          runtime.directory,
          harness.envKey,
          current,
          'safe-storage'
        )
        newerMarker = harness.markers.readPendingExternalLogoutMarker(
          runtime.directory,
          harness.envKey
        )
        throw new Error('fixture-cleanup conversion fsync failed')
      }
      return sync(descriptor)
    })

    await expect(harness.login()).rejects.toThrow('fixture-cleanup conversion fsync failed')

    expect(conversionFailed).toBe(true)
    expect(newerMarker?.intent).toEqual({
      intent: 'keytar-cleanup-pending',
      credentialSource: 'safe-storage',
    })
    expect(
      harness.markers.readPendingExternalLogoutMarker(runtime.directory, harness.envKey)
    ).toEqual(newerMarker)
    expect(harness.service.getCachedUserId()).toBeNull()
  })

  it('preserves logout intent when cleanup conversion and rollback durability fail', async () => {
    const harness = await createService()
    harness.markers.recordPendingExternalLogout(runtime.directory, harness.envKey)
    keytarMock.getPassword.mockRejectedValue(new Error('fixture-Keytar unavailable'))
    keytarMock.setPassword.mockRejectedValue(new Error('fixture-Keytar unavailable'))
    keytarMock.deletePassword.mockRejectedValue(new Error('fixture-Keytar unavailable'))
    let conversionFailed = false
    const sync = fsSync.fsyncSync.bind(fsSync)
    vi.spyOn(fsSync, 'fsyncSync').mockImplementation(descriptor => {
      if (
        !conversionFailed &&
        fsSync.fstatSync(descriptor).isDirectory() &&
        harness.markers.readPendingExternalLogoutIntent(runtime.directory, harness.envKey)
          ?.intent === 'keytar-cleanup-pending'
      ) {
        conversionFailed = true
        throw new Error('fixture-cleanup conversion fsync failed')
      }
      return sync(descriptor)
    })
    const unlink = fs.unlink.bind(fs)
    vi.spyOn(fs, 'unlink').mockImplementation(async file => {
      if (conversionFailed && String(file).endsWith(`session-token-${harness.envKey}.enc`)) {
        throw Object.assign(new Error('fixture-fresh credential rollback failed'), {
          code: 'EACCES',
        })
      }
      return unlink(file)
    })

    await expect(harness.login()).rejects.toThrow('fixture-cleanup conversion fsync failed')

    expect(harness.service.getCachedUserId()).toBeNull()
    expect(conversionFailed).toBe(true)
    const restarted = await createService()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
  })

  it('orders a queued fresh login after durable logout cleanup without clearing its session', async () => {
    const harness = await createService()
    await harness.login()
    harness.markers.recordPendingKeytarCleanup(runtime.directory, harness.envKey, 'active-keytar')
    const entered = deferred()
    const release = deferred()
    keytarMock.deletePassword.mockRejectedValueOnce(
      new Error('fixture-logout active delete failed')
    )
    const clear = harness.tokenStore.clearSessionTokenStrictly.bind(harness.tokenStore)
    let cleanupSettled = false
    vi.spyOn(harness.tokenStore, 'clearSessionTokenStrictly').mockImplementationOnce(
      async (...args) => {
        const outcome = await clear(...args).then(
          value => ({ value }),
          error => ({ error })
        )
        cleanupSettled = true
        entered.resolve()
        await release.promise
        if ('error' in outcome) throw outcome.error
        return outcome.value
      }
    )
    const originalRead = fsSync.readFileSync.bind(fsSync)
    const originalOpen = fsSync.openSync.bind(fsSync)
    const markerDescriptors = new Set<number>()
    let rereadFailed = false
    vi.spyOn(fsSync, 'openSync').mockImplementation((file, flags, mode) => {
      const descriptor = originalOpen(file, flags, mode)
      if (String(file) === harness.markerPath) markerDescriptors.add(descriptor)
      else markerDescriptors.delete(descriptor)
      return descriptor
    })
    vi.spyOn(fsSync, 'readFileSync').mockImplementation(((
      file: Parameters<typeof originalRead>[0],
      options: Parameters<typeof originalRead>[1]
    ) => {
      if (
        cleanupSettled &&
        !rereadFailed &&
        typeof file === 'number' &&
        markerDescriptors.has(file)
      ) {
        rereadFailed = true
        throw Object.assign(new Error('fixture-marker reread failed'), { code: 'EIO' })
      }
      return originalRead(file, options)
    }) as typeof fsSync.readFileSync)
    const logout = harness.service.logout()
    const logoutOutcome = logout.then(
      () => null,
      error => error
    )
    let loginOutcome: Promise<unknown> | undefined
    let phaseTimer: ReturnType<typeof setTimeout> | undefined
    try {
      const phase = await Promise.race([
        entered.promise.then(() => 'entered'),
        logout.then(
          () => 'settled',
          () => 'settled'
        ),
        new Promise<string>(resolve => {
          phaseTimer = setTimeout(() => resolve('deadline'), 5_000)
        }),
      ])
      expect(phase, 'Native cleanup must settle before its response is held').toBe('entered')
      const state = harness.service as unknown as {
        runSessionPersistence: <T>(operation: () => Promise<T>) => Promise<T>
      }
      const queued = deferred()
      const persist = state.runSessionPersistence.bind(state)
      vi.spyOn(state, 'runSessionPersistence').mockImplementationOnce(operation => {
        queued.resolve()
        return persist(operation)
      })
      keytarMock.setPassword.mockClear()
      const login = harness.login('fixture-concurrent-session')
      loginOutcome = login.then(
        value => value,
        error => error
      )
      if (phaseTimer) clearTimeout(phaseTimer)
      const queuedPhase = await Promise.race([
        queued.promise.then(() => 'entered'),
        loginOutcome.then(() => 'settled'),
        new Promise<string>(resolve => {
          phaseTimer = setTimeout(() => resolve('deadline'), 5_000)
        }),
      ])
      expect(queuedPhase, 'Fresh login must queue behind the held logout transaction').toBe(
        'entered'
      )
      expect(keytarMock.setPassword).not.toHaveBeenCalled()
    } finally {
      if (phaseTimer) clearTimeout(phaseTimer)
      release.resolve()
      await logoutOutcome
      if (loginOutcome) await loginOutcome
    }

    const logoutError = await logoutOutcome
    const loginResult = await loginOutcome
    const restarted = await createService()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me,
    })
    expect(restarted.authClient.getMe).toHaveBeenCalledWith('fixture-concurrent-session')
    expect(harness.service.getCachedUserId()).toBe(me.id)
    expect(await harness.tokenStore.getKeytarSessionToken(harness.envKey)).toBe(
      'fixture-concurrent-session'
    )
    expect(
      harness.markers.readPendingExternalLogoutMarker(runtime.directory, harness.envKey)
    ).toBeNull()
    expect(loginResult).toEqual({ authenticated: true, me })
    expect(rereadFailed).toBe(true)
    expect(logoutError).toMatchObject({ code: 'EIO', message: 'fixture-marker reread failed' })
  })

  it('admits a temporary login after ordinary logout while secure storage is unavailable', async () => {
    const harness = await createService()
    await harness.login()
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    keytarMock.getPassword.mockRejectedValue(new Error('fixture-Keytar unavailable'))
    keytarMock.setPassword.mockRejectedValue(new Error('fixture-Keytar unavailable'))
    keytarMock.deletePassword.mockRejectedValue(new Error('fixture-Keytar unavailable'))

    await expect(harness.service.logout()).resolves.toBeUndefined()
    const temporaryToken = sessionToken('temporary-after-logout')
    await expect(harness.login(temporaryToken)).resolves.toMatchObject({
      authenticated: true,
      me,
      sessionMode: 'temporary',
    })

    expect(harness.service.getCachedUserId()).toBe(me.id)
    expect(
      harness.markers.readPendingExternalLogoutIntent(runtime.directory, harness.envKey)
    ).toMatchObject({ intent: 'memory-only-session' })
    expect(await fs.readdir(runtime.directory)).not.toContain(
      `session-token-${harness.envKey}.json`
    )
    keytarMock.getPassword.mockImplementation(
      async (service, account) => keychain.get(keyOf(service, account)) ?? null
    )
    keytarMock.setPassword.mockImplementation(async (service, account, token) => {
      keychain.set(keyOf(service, account), token)
    })
    keytarMock.deletePassword.mockImplementation(async (service, account) =>
      keychain.delete(keyOf(service, account))
    )

    await expect(harness.login()).resolves.toEqual({ authenticated: true, me })
    expect(
      harness.markers.readPendingExternalLogoutIntent(runtime.directory, harness.envKey)
    ).toEqual({
      intent: 'keytar-cleanup-pending',
      credentialSource: 'active-keytar',
    })
    expect(await harness.tokenStore.getKeytarSessionToken(harness.envKey)).toBe(expectedFreshToken)
    const recovered = await createService()
    await expect(recovered.service.initialize()).resolves.toEqual({ authenticated: true, me })
  })

  it('rejects logout when durable intent cannot be reverified after cleanup fails', async () => {
    const harness = await createService()
    await harness.login()
    harness.markers.recordPendingKeytarCleanup(runtime.directory, harness.envKey, 'active-keytar')
    keytarMock.deletePassword.mockRejectedValue(new Error('fixture-Keytar cleanup failed'))
    const clear = harness.tokenStore.clearSessionTokenStrictly.bind(harness.tokenStore)
    let cleanupSettled = false
    vi.spyOn(harness.tokenStore, 'clearSessionTokenStrictly').mockImplementationOnce(
      async (...args) => {
        try {
          return await clear(...args)
        } finally {
          cleanupSettled = true
        }
      }
    )
    const originalRead = fsSync.readFileSync.bind(fsSync)
    const originalOpen = fsSync.openSync.bind(fsSync)
    const markerDescriptors = new Set<number>()
    let rereadFailed = false
    vi.spyOn(fsSync, 'openSync').mockImplementation((file, flags, mode) => {
      const descriptor = originalOpen(file, flags, mode)
      if (String(file) === harness.markerPath) markerDescriptors.add(descriptor)
      else markerDescriptors.delete(descriptor)
      return descriptor
    })
    vi.spyOn(fsSync, 'readFileSync').mockImplementation(((
      file: Parameters<typeof originalRead>[0],
      options: Parameters<typeof originalRead>[1]
    ) => {
      if (
        cleanupSettled &&
        !rereadFailed &&
        typeof file === 'number' &&
        markerDescriptors.has(file)
      ) {
        rereadFailed = true
        throw Object.assign(new Error('fixture-marker reread failed'), { code: 'EIO' })
      }
      return originalRead(file, options)
    }) as typeof fsSync.readFileSync)
    const originalRename = fsSync.renameSync.bind(fsSync)
    let markerWrites = 0
    vi.spyOn(fsSync, 'renameSync').mockImplementation((source, destination) => {
      if (String(destination) === harness.markerPath && ++markerWrites > 1) {
        throw Object.assign(new Error('fixture-redundant marker write failed'), { code: 'EIO' })
      }
      originalRename(source, destination)
    })

    const error = await harness.service.logout().then(
      () => null,
      error => error
    )

    expect(harness.service.getCachedUserId()).toBeNull()
    expect(
      harness.markers.readPendingExternalLogoutIntent(runtime.directory, harness.envKey)
    ).toEqual({
      intent: 'logout-pending',
    })
    expect(harness.reportFailure).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'fixture-marker reread failed' })
    )
    expect(harness.reportFailure).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Failed to clear session token storage' })
    )
    expect(notifySessionChanged).toHaveBeenCalledWith(false)
    expect(markerWrites).toBe(1)
    expect(rereadFailed).toBe(true)
    const restarted = await createService()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(restarted.authClient.getMe).not.toHaveBeenCalledWith(expectedFreshToken)
    expect(error).toMatchObject({ code: 'EIO', message: 'fixture-marker reread failed' })
  })
})
