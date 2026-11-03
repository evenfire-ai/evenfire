import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  disposeTokenStorePersistenceFixture,
  tokenStorePersistenceFixture as fixture,
  resetTokenStorePersistenceFixture,
} from '../../testSupport/tokenStorePersistenceFixture.js'
import { type SessionTokenReadAuthority, TokenStore } from '../tokenStore.js'

vi.mock('electron', async () => {
  const { createTokenStoreElectronFixture } =
    await import('../../testSupport/tokenStorePersistenceFixture.js')
  return createTokenStoreElectronFixture()
})
vi.mock('keytar', async () => {
  const { tokenStoreKeytarFixture } =
    await import('../../testSupport/tokenStorePersistenceFixture.js')
  return tokenStoreKeytarFixture
})
const ENV = 'active-111111111111'
const LEGACY_ENV = 'legacy-222222222222'
const GLOBAL_PRODUCER_ENV = 'global-333333333333'
const encrypted = (env = ENV) => path.join(fixture.directory, `session-token-${env}.enc`)
const plaintext = (env = ENV) => path.join(fixture.directory, `session-token-${env}.json`)
beforeEach(async () => {
  await resetTokenStorePersistenceFixture('evenfire-rejected-cleanup-')
  vi.clearAllMocks()
})
afterEach(async () => {
  vi.restoreAllMocks()
  await disposeTokenStorePersistenceFixture()
})
async function producePlaintext(env: string, token: string) {
  fixture.encryptionAvailable = false
  try {
    await new TokenStore({ isolatedUserDataPath: fixture.directory }).setSessionToken(token, env)
  } finally {
    fixture.encryptionAvailable = true
  }
}

async function observeReadAuthority(store: TokenStore): Promise<SessionTokenReadAuthority> {
  let authority: SessionTokenReadAuthority | undefined
  const options = {
    legacyEnvKeys: [LEGACY_ENV],
    allowLegacyMigration: false,
    onTokenRead: (_source: string, observed: SessionTokenReadAuthority) => {
      authority = observed
    },
  }
  await store.getSessionToken(ENV, options)
  if (!authority) {
    await store.setSessionToken('fixture-observed-reader', ENV, { requireKeytar: true })
    await store.getSessionToken(ENV, options)
  }
  expect(authority).toBeDefined()
  return authority!
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}
async function reached(boundary: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    expect(
      await Promise.race([
        boundary.then(() => true),
        new Promise<boolean>(done => {
          timer = setTimeout(() => done(false), 2000)
        }),
      ]),
      'real producer must enter its controlled storage boundary'
    ).toBe(true)
  } finally {
    clearTimeout(timer)
  }
}

describe('source-owned rejected-value cleanup modes', () => {
  it('cleans only matching native active/legacy/global values and preserves a newer alias', async () => {
    const store = new TokenStore()
    await store.setSessionToken('fixture-rejected', ENV, { requireKeytar: true })
    await store.setSessionToken('fixture-newer', LEGACY_ENV, { requireKeytar: true })
    await store.setSessionToken('fixture-rejected', GLOBAL_PRODUCER_ENV, { requireKeytar: true })
    // Relocate an actually produced native value into the historical global layout.
    fixture.keychain.set('session-token', (await store.getKeytarSessionToken(GLOBAL_PRODUCER_ENV))!)
    fixture.keychain.delete(`session-token::${GLOBAL_PRODUCER_ENV}`)
    const readAuthority = await observeReadAuthority(store)
    await expect(
      store.clearKeytarSessionTokensStrictly(ENV, {
        legacyEnvKeys: [LEGACY_ENV],
        onlyIfMatches: 'fixture-rejected',
        readAuthority,
      })
    ).resolves.toEqual({
      keytarAvailable: true,
      keytarDisabled: false,
      keytarDisposition: 'available',
      sourceAuthorityVerified: true,
    })
    await expect(store.getKeytarSessionToken(ENV)).resolves.toBeNull()
    await expect(store.getKeytarSessionToken(LEGACY_ENV)).resolves.toBe('fixture-newer')
    expect(fixture.keychain.has('session-token')).toBe(false)
    const keytar = await import('keytar')
    expect(keytar.deletePassword).not.toHaveBeenCalledWith(
      'Evenfire',
      `session-token::${LEGACY_ENV}`
    )
  })

  it.each([false, true])(
    'does not certify matching native cleanup on a retained value (%s)',
    async reported => {
      const store = new TokenStore()
      await store.setSessionToken('fixture-rejected', ENV, { requireKeytar: true })
      const keytar = await import('keytar')
      vi.mocked(keytar.deletePassword).mockResolvedValue(reported)
      const readAuthority = await observeReadAuthority(store)
      await expect(
        store.clearKeytarSessionTokensStrictly(ENV, {
          onlyIfMatches: 'fixture-rejected',
          readAuthority,
        })
      ).rejects.toThrow('Failed to clear session token storage')
      await expect(store.getKeytarSessionToken(ENV)).resolves.toBe('fixture-rejected')
    }
  )

  it('retires only rejected values across all six actual file producer formats', async () => {
    const store = new TokenStore()
    await store.setSafeStorageSessionToken('fixture-rejected', ENV)
    await producePlaintext(ENV, 'fixture-newer')
    await store.setSafeStorageSessionToken('fixture-newer', LEGACY_ENV)
    await producePlaintext(LEGACY_ENV, 'fixture-rejected')
    await store.setSafeStorageSessionToken('fixture-rejected', GLOBAL_PRODUCER_ENV)
    await producePlaintext(GLOBAL_PRODUCER_ENV, 'fixture-newer')
    await fs.rename(
      encrypted(GLOBAL_PRODUCER_ENV),
      path.join(fixture.directory, 'session-token.enc')
    )
    await fs.rename(
      plaintext(GLOBAL_PRODUCER_ENV),
      path.join(fixture.directory, 'session-token.json')
    )
    const readAuthority = await observeReadAuthority(store)
    const snapshot = await store.snapshotSessionTokenFallbackFiles(ENV, {
      legacyEnvKeys: [LEGACY_ENV],
    })
    await expect(
      store.retireSessionTokenFallbackFilesIfUnchanged(snapshot, {
        onlyIfMatches: 'fixture-rejected',
        readAuthority,
      })
    ).resolves.toBe(true)
    await expect(store.getSafeStorageSessionToken(ENV)).resolves.toBeNull()
    await expect(store.getSafeStorageSessionToken(LEGACY_ENV)).resolves.toBe('fixture-newer')
    expect(JSON.parse(await fs.readFile(plaintext(), 'utf8')).token).toBe('fixture-newer')
    expect(
      JSON.parse(await fs.readFile(path.join(fixture.directory, 'session-token.json'), 'utf8'))
        .token
    ).toBe('fixture-newer')
    await expect(fs.access(plaintext(LEGACY_ENV))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      fs.access(path.join(fixture.directory, 'session-token.enc'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves a newer file written after the captured observation and reports false', async () => {
    const store = new TokenStore()
    await store.setSafeStorageSessionToken('fixture-rejected', ENV)
    const readAuthority = await observeReadAuthority(store)
    const snapshot = await store.snapshotSessionTokenFallbackFiles(ENV)
    await store.setSafeStorageSessionToken('fixture-newer', ENV)
    await expect(
      store.retireSessionTokenFallbackFilesIfUnchanged(snapshot, {
        onlyIfMatches: 'fixture-rejected',
        readAuthority,
      })
    ).resolves.toBe(false)
    await expect(store.getSafeStorageSessionToken(ENV)).resolves.toBe('fixture-newer')
  })

  it('does not claim cleanup when observed encrypted values cannot be decrypted', async () => {
    const store = new TokenStore()
    await store.setSafeStorageSessionToken('fixture-rejected', ENV)
    await producePlaintext(ENV, 'fixture-rejected')
    const before = await fs.readFile(encrypted())
    const readAuthority = await observeReadAuthority(store)
    const snapshot = await store.snapshotSessionTokenFallbackFiles(ENV)
    fixture.encryptionAvailable = false
    await expect(
      store.retireSessionTokenFallbackFilesIfUnchanged(snapshot, {
        onlyIfMatches: 'fixture-rejected',
        readAuthority,
      })
    ).rejects.toThrow('unavailable for conditional fallback cleanup')
    expect(await fs.readFile(encrypted())).toEqual(before)
    expect(JSON.parse(await fs.readFile(plaintext(), 'utf8')).token).toBe('fixture-rejected')
  })

  it('preserves malformed real files without exposing their contents in the error', async () => {
    const store = new TokenStore()
    await producePlaintext(ENV, 'fixture-rejected')
    const invalid = 'fixture-private-invalid-json'
    await fs.writeFile(plaintext(), invalid)
    const readAuthority = await observeReadAuthority(store)
    const snapshot = await store.snapshotSessionTokenFallbackFiles(ENV)
    const error = await store
      .retireSessionTokenFallbackFilesIfUnchanged(snapshot, {
        onlyIfMatches: 'fixture-rejected',
        readAuthority,
      })
      .then(
        () => null,
        error => error
      )
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe('Session-token fallback has an invalid producer format')
    expect(error.message).not.toContain(invalid)
    expect(await fs.readFile(plaintext(), 'utf8')).toBe(invalid)
  })

  it('rejects mixing rejection cleanup with an active encrypted authority', async () => {
    const store = new TokenStore()
    await store.setSafeStorageSessionToken('fixture-rejected', ENV)
    const readAuthority = await observeReadAuthority(store)
    const snapshot = await store.snapshotSessionTokenFallbackFiles(ENV)
    await expect(
      store.retireSessionTokenFallbackFilesIfUnchanged(snapshot, {
        onlyIfMatches: 'fixture-rejected',
        readAuthority,
        preserveActiveEncryptedToken: 'fixture-rejected',
      })
    ).rejects.toThrow('cannot preserve an encrypted authority')
    await expect(store.getSafeStorageSessionToken(ENV)).resolves.toBe('fixture-rejected')
  })

  it.each(['native', 'files'] as const)('rejects empty matching criteria for %s', async mode => {
    const store = new TokenStore()
    await observeReadAuthority(store)
    const snapshot = await store.snapshotSessionTokenFallbackFiles(ENV)
    await expect(
      mode === 'native'
        ? store.clearKeytarSessionTokensStrictly(ENV, { onlyIfMatches: '' })
        : store.retireSessionTokenFallbackFilesIfUnchanged(snapshot, { onlyIfMatches: '' })
    ).rejects.toThrow('nonempty rejected token')
  })

  it.each(['native', 'files'] as const)(
    'drains accepted matching cleanup held at the actual %s boundary',
    async mode => {
      const store = new TokenStore()
      await store.setSessionToken('fixture-rejected', ENV, { requireKeytar: true })
      await store.setSafeStorageSessionToken('fixture-rejected', ENV)
      const readAuthority = await observeReadAuthority(store)
      const snapshot = await store.snapshotSessionTokenFallbackFiles(ENV)
      const started = deferred()
      const release = deferred()
      if (mode === 'native') {
        const keytar = await import('keytar')
        const remove = vi.mocked(keytar.deletePassword).getMockImplementation()!
        vi.mocked(keytar.deletePassword).mockImplementationOnce(async (service, account) => {
          started.resolve()
          await release.promise
          return remove(service, account)
        })
      } else {
        const open = fs.open.bind(fs)
        vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
          const handle = await open(...args)
          if (args[1] === 'r' && (await handle.stat()).isDirectory()) {
            const sync = handle.sync.bind(handle)
            vi.spyOn(handle, 'sync').mockImplementation(async () => {
              started.resolve()
              await release.promise
              return sync()
            })
          }
          return handle
        })
      }
      const cleanup =
        mode === 'native'
          ? store.clearKeytarSessionTokensStrictly(ENV, {
              onlyIfMatches: 'fixture-rejected',
              readAuthority,
            })
          : store.retireSessionTokenFallbackFilesIfUnchanged(snapshot, {
              onlyIfMatches: 'fixture-rejected',
              readAuthority,
            })
      let draining: Promise<void> | undefined
      let completed = false
      try {
        await reached(started.promise)
        draining = store.prepareForQuit().then(() => {
          completed = true
        })
        await new Promise<void>(done => setImmediate(done))
        expect(completed).toBe(false)
      } finally {
        release.resolve()
        await Promise.allSettled([cleanup, draining])
      }
      expect(completed).toBe(true)
      await expect(cleanup).resolves.toEqual(
        mode === 'native'
          ? {
              keytarAvailable: true,
              keytarDisabled: false,
              keytarDisposition: 'available',
              sourceAuthorityVerified: true,
            }
          : true
      )
    }
  )

  it.each(['native', 'files'] as const)(
    'rejects matching %s cleanup after storage admission closes',
    async mode => {
      const store = new TokenStore()
      await store.setSessionToken('fixture-rejected', ENV, { requireKeytar: true })
      await store.setSafeStorageSessionToken('fixture-rejected', ENV)
      const readAuthority = await observeReadAuthority(store)
      const snapshot = await store.snapshotSessionTokenFallbackFiles(ENV)
      await store.prepareForQuit()
      await expect(
        mode === 'native'
          ? store.clearKeytarSessionTokensStrictly(ENV, {
              onlyIfMatches: 'fixture-rejected',
              readAuthority,
            })
          : store.retireSessionTokenFallbackFilesIfUnchanged(snapshot, {
              onlyIfMatches: 'fixture-rejected',
              readAuthority,
            })
      ).rejects.toThrow('Application is shutting down')
      await expect(new TokenStore().getKeytarSessionToken(ENV)).resolves.toBe('fixture-rejected')
      await expect(new TokenStore().getSafeStorageSessionToken(ENV)).resolves.toBe(
        'fixture-rejected'
      )
    }
  )
})
