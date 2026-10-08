import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

let testHome = ''
let restoreHomedir: (() => void) | undefined

// In-memory keychain backing the mocked keytar module. Keyed by service:account
// so per-environment account isolation is directly observable.
const keychain = new Map<string, string>()
const keyOf = (service: string, account: string) => `${service}::${account}`

vi.mock('keytar', () => ({
  getPassword: vi.fn(async (service: string, account: string) =>
    keychain.has(keyOf(service, account)) ? keychain.get(keyOf(service, account))! : null
  ),
  setPassword: vi.fn(async (service: string, account: string, password: string) => {
    keychain.set(keyOf(service, account), password)
  }),
  deletePassword: vi.fn(async (service: string, account: string) =>
    keychain.delete(keyOf(service, account))
  ),
}))

// app.isReady()=false + safeStorage unavailable keeps keytar in memory and
// routes plain-file fallback reads under the temporary home directory below.
vi.mock('electron', () => ({
  app: { isReady: vi.fn(() => false), getPath: vi.fn(() => '/tmp/evenfire-test') },
  safeStorage: { isEncryptionAvailable: vi.fn(() => false) },
}))

const SERVICE = 'Evenfire'
const LEGACY_ACCOUNT = 'session-token'
// Realistic env keys: `resolveEnvKey` emits `<slug>-<12 hex>` where the slug is
// `[a-z0-9_]+` (non-alphanumerics collapsed to `_`), so the ONLY `-` is the
// hash separator.
const ENV_A = 'env_a-000000000000'
const ENV_B = 'env_b-111111111111'
const ENV_A_WITH_RPC = 'env_a_rpc-222222222222'

let TokenStore: typeof import('../tokenStore.js').TokenStore

beforeAll(async () => {
  testHome = await mkdtemp(path.join(os.tmpdir(), 'evenfire-token-store-test-'))
  const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(testHome)
  restoreHomedir = () => homedirSpy.mockRestore()
})

afterAll(async () => {
  restoreHomedir?.()
  if (testHome) await rm(testHome, { recursive: true, force: true })
})

beforeEach(async () => {
  keychain.clear()
  vi.clearAllMocks()
  TokenStore = (await import('../tokenStore.js')).TokenStore
})

describe('TokenStore per-environment slots (spec §5.2)', () => {
  it('only permits Keytar replacement for the active account when no files failed', async () => {
    const { SessionTokenStorageClearError } = await import('../tokenStore.js')
    const activeAccount = `${LEGACY_ACCOUNT}::${ENV_A}`
    const activeFailure = new SessionTokenStorageClearError(
      [new Error('keychain locked')],
      [activeAccount],
      0
    )
    const otherAccountFailure = new SessionTokenStorageClearError(
      [new Error('keychain locked')],
      [`${LEGACY_ACCOUNT}::${ENV_B}`],
      0
    )
    const additionalAccountFailure = new SessionTokenStorageClearError(
      [new Error('keychain locked')],
      [activeAccount, `${LEGACY_ACCOUNT}::${ENV_B}`],
      0
    )
    const fileFailure = new SessionTokenStorageClearError(
      [new Error('keychain locked'), new Error('file locked')],
      [activeAccount],
      1
    )
    const noKeytarFailure = new SessionTokenStorageClearError([], [], 0)

    expect(activeFailure.canBeReplacedByFreshLoginCredential(ENV_A)).toBe(true)
    expect(activeFailure.canUseFileFallbackWhileMarkerRemains()).toBe(true)
    expect(otherAccountFailure.canBeReplacedByFreshLoginCredential(ENV_A)).toBe(false)
    expect(additionalAccountFailure.canBeReplacedByFreshLoginCredential(ENV_A)).toBe(false)
    expect(fileFailure.canBeReplacedByFreshLoginCredential(ENV_A)).toBe(false)
    expect(fileFailure.canUseFileFallbackWhileMarkerRemains()).toBe(false)
    expect(noKeytarFailure.canBeReplacedByFreshLoginCredential(ENV_A)).toBe(false)
    expect(noKeytarFailure.canUseFileFallbackWhileMarkerRemains()).toBe(false)
  })

  it('rejects new operations after the TokenStore drain begins', async () => {
    const keytar = await import('keytar')
    let finishWrite!: () => void
    vi.mocked(keytar.setPassword).mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finishWrite = resolve
        })
    )
    const store = new TokenStore()
    const activeWrite = store.setSessionToken('active-token', ENV_A)
    await vi.waitFor(() => {
      expect(keytar.setPassword).toHaveBeenCalledWith(
        SERVICE,
        `${LEGACY_ACCOUNT}::${ENV_A}`,
        'active-token'
      )
    })

    const drain = store.prepareForQuit()
    try {
      await expect(store.setSessionToken('late-token', ENV_A)).rejects.toThrow(
        'Application is shutting down'
      )
      expect(keytar.setPassword).toHaveBeenCalledOnce()
    } finally {
      finishWrite()
      await Promise.all([activeWrite, drain])
    }
  })

  it('accepts a new public operation after quit cancellation reopens admission', async () => {
    const keytar = await import('keytar')
    const store = new TokenStore()
    await store.prepareForQuit()

    await expect(store.getSessionToken(ENV_A)).rejects.toThrow('Application is shutting down')
    store.reopenAdmission()
    await store.setSessionToken('retry-token', ENV_A)

    expect(keytar.setPassword).toHaveBeenCalledWith(
      SERVICE,
      `${LEGACY_ACCOUNT}::${ENV_A}`,
      'retry-token'
    )
    await expect(store.getSessionToken(ENV_A)).resolves.toBe('retry-token')
  })

  it('reports storage failures when clearing a deferred logout intent', async () => {
    const keytar = await import('keytar')
    keychain.set(keyOf(SERVICE, `${LEGACY_ACCOUNT}::${ENV_A}`), 'saved-token')
    vi.mocked(keytar.deletePassword).mockRejectedValueOnce(new Error('keychain unavailable'))

    await expect(
      new TokenStore().clearSessionToken(ENV_A, { throwOnStorageError: true })
    ).rejects.toMatchObject({ message: 'Failed to clear session token storage' })

    expect(keychain.get(keyOf(SERVICE, `${LEGACY_ACCOUNT}::${ENV_A}`))).toBe('saved-token')
  })

  it('allows a strict clear when keychain entries and fallback files are already absent', async () => {
    await expect(
      new TokenStore().clearSessionToken(ENV_A, { throwOnStorageError: true })
    ).resolves.toBeUndefined()
  })

  it('reports strict fallback-file deletion failures while continuing cleanup', async () => {
    const fallbackPath = path.join(testHome, '.evenfire', `session-token-${ENV_A}.json`)
    const otherFilePath = path.join(testHome, '.evenfire', 'session-token.enc')
    await fs.mkdir(path.dirname(fallbackPath), { recursive: true })
    await fs.writeFile(fallbackPath, JSON.stringify({ token: 'fixture-token' }), { mode: 0o600 })
    await fs.writeFile(otherFilePath, Buffer.from('legacy-encrypted-token'), { mode: 0o600 })
    keychain.set(keyOf(SERVICE, `${LEGACY_ACCOUNT}::${ENV_A}`), 'fixture-token')
    const originalUnlink = fs.unlink.bind(fs)
    const unlink = vi.spyOn(fs, 'unlink').mockImplementation(async filePath => {
      if (String(filePath) === fallbackPath) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      }
      return originalUnlink(filePath)
    })

    try {
      await expect(
        new TokenStore().clearSessionToken(ENV_A, { throwOnStorageError: true })
      ).rejects.toMatchObject({ message: 'Failed to clear session token storage' })
      expect(await fs.readFile(fallbackPath, 'utf8')).toContain('fixture-token')
      expect(keychain.has(keyOf(SERVICE, `${LEGACY_ACCOUNT}::${ENV_A}`))).toBe(false)
      await expect(fs.access(otherFilePath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      unlink.mockRestore()
      await fs.rm(fallbackPath, { force: true })
    }
  })

  it('strictly clears the legacy global token files', async () => {
    const storageDirectory = path.join(testHome, '.evenfire')
    const legacyEncryptedFile = path.join(storageDirectory, 'session-token.enc')
    const legacyPlainFile = path.join(storageDirectory, 'session-token.json')
    await fs.mkdir(storageDirectory, { recursive: true })
    await fs.writeFile(legacyEncryptedFile, Buffer.from('legacy-encrypted-token'), { mode: 0o600 })
    await fs.writeFile(legacyPlainFile, JSON.stringify({ token: 'legacy-fixture-token' }), {
      mode: 0o600,
    })

    await expect(
      new TokenStore().clearSessionToken(ENV_A, { throwOnStorageError: true })
    ).resolves.toBeUndefined()

    await expect(fs.access(legacyEncryptedFile)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.access(legacyPlainFile)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('finishes an accepted read migration after admission closes and drains its native write', async () => {
    const keytar = await import('keytar')
    const store = new TokenStore()
    keychain.set(keyOf(SERVICE, LEGACY_ACCOUNT), 'legacy-token')

    let finishLegacyRead!: () => void
    const legacyRead = new Promise<void>(resolve => {
      finishLegacyRead = resolve
    })
    const originalGetPassword = vi.mocked(keytar.getPassword).getMockImplementation()!
    const originalSetPassword = vi.mocked(keytar.setPassword).getMockImplementation()!
    vi.mocked(keytar.getPassword).mockImplementation(async (service, account) => {
      if (account === LEGACY_ACCOUNT) await legacyRead
      return originalGetPassword(service, account)
    })

    let finishWrite!: () => void
    vi.mocked(keytar.setPassword).mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finishWrite = resolve
        })
    )

    const read = store.getSessionToken(ENV_A)
    await vi.waitFor(() => {
      expect(keytar.getPassword).toHaveBeenCalledWith(SERVICE, LEGACY_ACCOUNT)
    })
    let drainFinished = false
    const drain = store.prepareForQuit().then(() => {
      drainFinished = true
    })
    try {
      await expect(store.clearSessionToken(ENV_B)).rejects.toThrow('Application is shutting down')
      finishLegacyRead()
      await vi.waitFor(() => {
        expect(keytar.setPassword).toHaveBeenCalledWith(
          SERVICE,
          `${LEGACY_ACCOUNT}::${ENV_A}`,
          'legacy-token'
        )
      })
      expect(drainFinished).toBe(false)

      finishWrite()
      await expect(read).resolves.toBe('legacy-token')
      await expect(drain).resolves.toBeUndefined()
      expect(drainFinished).toBe(true)
    } finally {
      finishLegacyRead()
      const migrationWriteStarted = await vi
        .waitFor(() => {
          expect(keytar.setPassword).toHaveBeenCalledWith(
            SERVICE,
            `${LEGACY_ACCOUNT}::${ENV_A}`,
            'legacy-token'
          )
        })
        .then(
          () => true,
          () => false
        )
      if (migrationWriteStarted) finishWrite?.()
      else vi.mocked(keytar.setPassword).mockReset().mockImplementation(originalSetPassword)
      await Promise.allSettled([read, drain])
      vi.mocked(keytar.getPassword).mockReset().mockImplementation(originalGetPassword)
      if (migrationWriteStarted) {
        vi.mocked(keytar.setPassword).mockReset().mockImplementation(originalSetPassword)
      }
    }
  })

  it('stores and reads a token under the env-scoped account', async () => {
    const store = new TokenStore()
    await store.setSessionToken('tok-a', ENV_A)
    expect(await store.getSessionToken(ENV_A)).toBe('tok-a')
    // Physically stored under the namespaced account, never the global one.
    expect(keychain.get(keyOf(SERVICE, `${LEGACY_ACCOUNT}::${ENV_A}`))).toBe('tok-a')
    expect(keychain.has(keyOf(SERVICE, LEGACY_ACCOUNT))).toBe(false)
  })

  it('waits for active native credential operations before quitting', async () => {
    const keytar = await import('keytar')
    let finishWrite!: () => void
    vi.mocked(keytar.setPassword).mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finishWrite = resolve
        })
    )
    const store = new TokenStore()
    const write = store.setSessionToken('tok-a', ENV_A)

    await vi.waitFor(() => {
      expect(keytar.setPassword).toHaveBeenCalledWith(
        SERVICE,
        `${LEGACY_ACCOUNT}::${ENV_A}`,
        'tok-a'
      )
    })

    let drainFinished = false
    const prepareForQuit = (store as TokenStore & { prepareForQuit?: () => Promise<void> })
      .prepareForQuit
    const drain = (prepareForQuit ? prepareForQuit.call(store) : Promise.resolve()).then(() => {
      drainFinished = true
    })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(drainFinished).toBe(false)

    finishWrite()
    await expect(write).resolves.toBeUndefined()
    await expect(drain).resolves.toBeUndefined()
    expect(drainFinished).toBe(true)
  })

  it('does not leak env A token into env B', async () => {
    const store = new TokenStore()
    await store.setSessionToken('tok-a', ENV_A)
    expect(await store.getSessionToken(ENV_B)).toBeNull()

    await store.setSessionToken('tok-b', ENV_B)
    expect(await store.getSessionToken(ENV_A)).toBe('tok-a')
    expect(await store.getSessionToken(ENV_B)).toBe('tok-b')
  })

  it('clear only removes the active env slot (other env token survives)', async () => {
    const store = new TokenStore()
    await store.setSessionToken('tok-a', ENV_A)
    await store.setSessionToken('tok-b', ENV_B)

    await store.clearSessionToken(ENV_A)
    expect(await store.getSessionToken(ENV_A)).toBeNull()
    expect(await store.getSessionToken(ENV_B)).toBe('tok-b')
  })

  it('continues scoped cleanup when keytar deletePassword throws synchronously', async () => {
    const keytar = await import('keytar')
    vi.mocked(keytar.deletePassword).mockImplementationOnce(() => {
      throw new Error('synchronous keychain failure')
    })
    const store = new TokenStore()

    await expect(store.clearSessionToken(ENV_A)).resolves.toBeUndefined()
    expect(keytar.deletePassword).toHaveBeenCalledWith(SERVICE, LEGACY_ACCOUNT)
  })

  it('clear removes explicitly supported legacy environment alias slots', async () => {
    const store = new TokenStore()
    await store.setSessionToken('legacy-token', ENV_A)
    await store.setSessionToken('current-token', ENV_A_WITH_RPC)

    await store.clearSessionToken(ENV_A_WITH_RPC, { legacyEnvKeys: [ENV_A] })

    expect(keychain.has(keyOf(SERVICE, `${LEGACY_ACCOUNT}::${ENV_A}`))).toBe(false)
    expect(keychain.has(keyOf(SERVICE, `${LEGACY_ACCOUNT}::${ENV_A_WITH_RPC}`))).toBe(false)
    expect(await store.getSessionToken(ENV_A_WITH_RPC)).toBeNull()
    expect(await store.getSessionToken(ENV_A)).toBeNull()
  })

  it('migrates a legacy global-slot token into the active env slot, then deletes it', async () => {
    // Simulate a pre-per-env install: token in the single global account.
    keychain.set(keyOf(SERVICE, LEGACY_ACCOUNT), 'legacy-tok')
    const store = new TokenStore()

    const migrated = await store.getSessionToken(ENV_A)
    expect(migrated).toBe('legacy-tok')
    // Copied into the env slot and removed from the legacy slot (no cross-env reuse).
    expect(keychain.get(keyOf(SERVICE, `${LEGACY_ACCOUNT}::${ENV_A}`))).toBe('legacy-tok')
    expect(keychain.has(keyOf(SERVICE, LEGACY_ACCOUNT))).toBe(false)

    // A second env no longer sees the (now-consumed) legacy token.
    expect(await store.getSessionToken(ENV_B)).toBeNull()
  })

  it('migrates an older env-scoped token into the active env slot, then deletes it', async () => {
    keychain.set(keyOf(SERVICE, `${LEGACY_ACCOUNT}::${ENV_A}`), 'rest-only-tok')
    const store = new TokenStore()

    const migrated = await store.getSessionToken(ENV_A_WITH_RPC, { legacyEnvKeys: [ENV_A] })
    expect(migrated).toBe('rest-only-tok')
    expect(keychain.get(keyOf(SERVICE, `${LEGACY_ACCOUNT}::${ENV_A_WITH_RPC}`))).toBe(
      'rest-only-tok'
    )
    expect(keychain.has(keyOf(SERVICE, `${LEGACY_ACCOUNT}::${ENV_A}`))).toBe(false)
    expect(await store.getSessionToken(ENV_A)).toBeNull()
  })

  it('clear removes the legacy global slot too (defense against later migration)', async () => {
    keychain.set(keyOf(SERVICE, LEGACY_ACCOUNT), 'legacy-tok')
    const store = new TokenStore()
    await store.setSessionToken('tok-a', ENV_A)

    await store.clearSessionToken(ENV_A)
    expect(keychain.has(keyOf(SERVICE, LEGACY_ACCOUNT))).toBe(false)
  })

  it('rejects a malformed envKey before it reaches account/file names', async () => {
    const store = new TokenStore()
    // Path-separator, traversal, wrong shape, and empty are all refused up front
    // so an attacker-controlled value can never build a keychain account or
    // on-disk filename.
    for (const bad of ['../etc', 'env_a/000000000000', 'env_a', 'ENV_A-000000000000', '']) {
      await expect(store.setSessionToken('tok', bad)).rejects.toThrow(/Invalid envKey/)
      await expect(store.getSessionToken(bad)).rejects.toThrow(/Invalid envKey/)
      await expect(store.clearSessionToken(bad)).rejects.toThrow(/Invalid envKey/)
    }
    // Nothing was written for any rejected key.
    expect(keychain.size).toBe(0)
  })
})
