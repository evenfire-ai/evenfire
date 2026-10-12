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
  const login = (token = 'fixture-fresh-session') =>
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
      'fixture-fresh-session'
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
    expect(restarted.authClient.getMe).toHaveBeenCalledWith('fixture-fresh-session')
  })

  it('recovers malformed regular bytes when the Keytar module is absent', async () => {
    vi.doMock('keytar', () => ({}))
    const harness = await createService()
    await fs.writeFile(harness.markerPath, '{malformed')

    await expect(harness.login()).resolves.toEqual({ authenticated: true, me })

    expect(await harness.tokenStore.getSafeStorageSessionToken(harness.envKey)).toBe(
      'fixture-fresh-session'
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
      'fixture-fresh-session'
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

    expect(await harness.tokenStore.getSessionToken(harness.envKey)).toBe('fixture-fresh-session')
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
    keytarMock.deletePassword.mockImplementationOnce(async () => {
      entered.resolve()
      await release.promise
      return false
    })
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

    await expect(harness.login()).rejects.toThrow('Pending logout intent changed')

    expect(
      harness.markers.readPendingExternalLogoutMarker(runtime.directory, harness.envKey)
    ).toEqual(newerMarker)
    expect(harness.service.getCachedUserId()).toBeNull()
    expect(await harness.tokenStore.getKeytarSessionToken(harness.envKey)).toBeNull()
    expect(notifySessionChanged).toHaveBeenCalledWith(false)
  })
})

describe('team persistence respects pending-marker authority', () => {
  it.each([
    { keytarState: 'failed', safeStorageAvailable: true },
    { keytarState: 'failed', safeStorageAvailable: false },
    { keytarState: 'absent', safeStorageAvailable: true },
    { keytarState: 'absent', safeStorageAvailable: false },
  ])(
    'rejects an active-Keytar team write with $keytarState Keytar and safeStorage=$safeStorageAvailable',
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

      await expect(harness.service.switchTeam('fixture-other-team')).rejects.toThrow(/Keytar/)

      expect(harness.service.getCachedUserId()).toBeNull()
      expect(harness.reportFailure).toHaveBeenCalled()
      expect(notifySessionChanged).toHaveBeenCalledWith(false)
      expect(
        harness.markers.readPendingExternalLogoutIntent(runtime.directory, harness.envKey)
      ).toEqual({
        intent: 'keytar-cleanup-pending',
        credentialSource: 'active-keytar',
      })
      expect(await fs.readdir(runtime.directory)).not.toContain(
        `session-token-${harness.envKey}.enc`
      )
      expect(await fs.readdir(runtime.directory)).not.toContain(
        `session-token-${harness.envKey}.json`
      )
    }
  )

  // Characterization: successful source-bound team writes retain the established restore path.
  it('restores a successful active-Keytar team switch instead of an unrelated safeStorage token', async () => {
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
    expect(await harness.tokenStore.getSafeStorageSessionToken(harness.envKey)).toBe(
      'fixture-unrelated-file-token'
    )
    const restarted = await createService()
    vi.mocked(restarted.authClient.getMe).mockResolvedValue(switchedMe)
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: switchedMe,
    })
    expect(restarted.authClient.getMe).toHaveBeenCalledWith('fixture-other-team-session')
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

      await expect(harness.login()).rejects.toThrow('fixture-owned cleanup')

      expect(failureInjected).toBe(true)
      expect(harness.service.getCachedUserId()).toBeNull()
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

  it('keeps logout durable when a concurrent login retires its upgraded marker', async () => {
    const harness = await createService()
    await harness.login()
    harness.markers.recordPendingKeytarCleanup(runtime.directory, harness.envKey, 'active-keytar')
    const entered = deferred()
    const release = deferred()
    keytarMock.deletePassword.mockImplementationOnce(async () => {
      entered.resolve()
      await release.promise
      throw new Error('fixture-logout active delete failed')
    })
    const originalRead = fsSync.readFileSync.bind(fsSync)
    let reads = 0
    vi.spyOn(fsSync, 'readFileSync').mockImplementation(((
      file: Parameters<typeof originalRead>[0],
      options: Parameters<typeof originalRead>[1]
    ) => {
      if (typeof file === 'number' && ++reads === 2) {
        throw Object.assign(new Error('fixture-marker reread failed'), { code: 'EIO' })
      }
      return originalRead(file, options)
    }) as typeof fsSync.readFileSync)
    const logout = harness.service.logout()
    await entered.promise
    try {
      await expect(harness.login('fixture-concurrent-session')).resolves.toEqual({
        authenticated: true,
        me,
      })
      expect(
        harness.markers.readPendingExternalLogoutMarker(runtime.directory, harness.envKey)
      ).toBeNull()
    } finally {
      release.resolve()
      await logout
    }

    expect(harness.service.getCachedUserId()).toBeNull()
    const restarted = await createService()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
  })

  // Characterization: the owner retained this policy for ordinary UI logout too.
  it('blocks login after ordinary logout until secure storage recovers', async () => {
    const harness = await createService()
    await harness.login()
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    keytarMock.getPassword.mockRejectedValue(new Error('fixture-Keytar unavailable'))
    keytarMock.setPassword.mockRejectedValue(new Error('fixture-Keytar unavailable'))
    keytarMock.deletePassword.mockRejectedValue(new Error('fixture-Keytar unavailable'))

    await expect(harness.service.logout()).resolves.toBeUndefined()
    await expect(harness.login()).rejects.toThrow('safeStorage is unavailable')

    expect(harness.service.getCachedUserId()).toBeNull()
    expect(
      harness.markers.readPendingExternalLogoutIntent(runtime.directory, harness.envKey)
    ).toEqual({
      intent: 'logout-pending',
    })
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
      harness.markers.readPendingExternalLogoutMarker(runtime.directory, harness.envKey)
    ).toBeNull()
    expect(await harness.tokenStore.getKeytarSessionToken(harness.envKey)).toBe(
      'fixture-fresh-session'
    )
  })

  it('resolves logout after a durable upgrade even when reread and redundant rewrite would fail', async () => {
    const harness = await createService()
    await harness.login()
    harness.markers.recordPendingKeytarCleanup(runtime.directory, harness.envKey, 'active-keytar')
    keytarMock.deletePassword.mockRejectedValue(new Error('fixture-Keytar cleanup failed'))
    const originalRead = fsSync.readFileSync.bind(fsSync)
    let markerReads = 0
    vi.spyOn(fsSync, 'readFileSync').mockImplementation(((
      file: Parameters<typeof originalRead>[0],
      options: Parameters<typeof originalRead>[1]
    ) => {
      if (typeof file === 'number' && ++markerReads === 2) {
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

    await expect(harness.service.logout()).resolves.toBeUndefined()

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
  })
})
