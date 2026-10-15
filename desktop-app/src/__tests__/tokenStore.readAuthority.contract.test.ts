import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  type SessionTokenReadAuthority,
  TokenStore,
  focusSessionTokenReadAuthority,
  isSessionTokenReadAuthorityCurrent,
} from '../tokenStore.js'

const fixture = vi.hoisted(() => ({
  directory: '',
  encryptionAvailable: true,
  keychain: new Map<string, string>(),
}))
vi.mock('electron', () => ({
  app: { isReady: () => true, getPath: () => fixture.directory },
  safeStorage: {
    isEncryptionAvailable: () => fixture.encryptionAvailable,
    encryptString: (token: string) => Buffer.from(`encrypted:${token}`),
    decryptString: (value: Buffer) => value.toString().slice('encrypted:'.length),
  },
}))
vi.mock('keytar', () => ({
  getPassword: vi.fn(async (_service, account) => fixture.keychain.get(account) ?? null),
  setPassword: vi.fn(async (_service, account, token) => {
    fixture.keychain.set(account, token)
  }),
  deletePassword: vi.fn(async (_service, account) => fixture.keychain.delete(account)),
}))
const ENV = 'active-111111111111'
const LEGACY_ENV = 'legacy-222222222222'
beforeEach(async () => {
  fixture.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-fallback-retirement-'))
  fixture.encryptionAvailable = true
  fixture.keychain.clear()
  vi.clearAllMocks()
  const keytar = await import('keytar')
  vi.mocked(keytar.getPassword)
    .mockReset()
    .mockImplementation(async (_service, account) => fixture.keychain.get(account) ?? null)
  vi.mocked(keytar.setPassword)
    .mockReset()
    .mockImplementation(async (_service, account, token) => {
      fixture.keychain.set(account, token)
    })
  vi.mocked(keytar.deletePassword)
    .mockReset()
    .mockImplementation(async (_service, account) => fixture.keychain.delete(account))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(fixture.directory, { recursive: true, force: true })
})
type Source = 'native' | 'encrypted' | 'plaintext'
async function fixtureStore(source: Source) {
  if (source === 'plaintext') fixture.encryptionAvailable = false
  return new TokenStore(source === 'plaintext' ? { isolatedUserDataPath: fixture.directory } : {})
}
async function produce(store: TokenStore, source: Source, token: string) {
  if (source === 'encrypted') await store.setSafeStorageSessionToken(token, ENV)
  else await store.setSessionToken(token, ENV, { requireKeytar: source === 'native' })
}
async function select(store: TokenStore) {
  let authority: SessionTokenReadAuthority | undefined
  const token = await store.getSessionToken(ENV, {
    legacyEnvKeys: [LEGACY_ENV],
    allowLegacyMigration: false,
    onTokenRead: (_source, observed) => {
      authority = observed
    },
  })
  expect(authority).toBeDefined()
  expect(Object.isFrozen(authority)).toBe(true)
  expect(Object.keys(authority!)).toEqual([])
  return { token, authority: authority! }
}
async function cleanup(store: TokenStore, source: Source, authority: SessionTokenReadAuthority) {
  if (source === 'native')
    return (
      await store.clearKeytarSessionTokensStrictly(ENV, {
        legacyEnvKeys: [LEGACY_ENV],
        onlyIfMatches: 'fixture-rejected',
        readAuthority: authority,
      })
    ).sourceAuthorityVerified
  const snapshot = await store.snapshotSessionTokenFallbackFiles(ENV, {
    legacyEnvKeys: [LEGACY_ENV],
  })
  return store.retireSessionTokenFallbackFilesIfUnchanged(snapshot, {
    onlyIfMatches: 'fixture-rejected',
    readAuthority: authority,
  })
}

describe('original selected-source publication authority', () => {
  it.each(['native', 'encrypted', 'plaintext'] as const)(
    'derives a frozen %s focus without reading storage or advancing original publication',
    async source => {
      const store = await fixtureStore(source)
      await produce(store, source, 'fixture-accepted-home')
      const selected = await select(store)
      const actualSource =
        source === 'native'
          ? 'keytar'
          : source === 'encrypted'
            ? 'safe-storage'
            : 'historical-plaintext'
      const keytar = await import('keytar')
      const nativeReads = vi.mocked(keytar.getPassword).mock.calls.length
      const fileReads = vi.spyOn(fsSync, 'openSync')
      const focused = focusSessionTokenReadAuthority(selected.authority, actualSource, ENV)
      expect(focused).toBeDefined()
      expect(focused).not.toBe(selected.authority)
      expect(Object.isFrozen(focused)).toBe(true)
      expect(Object.keys(focused!)).toEqual([])
      expect(isSessionTokenReadAuthorityCurrent(focused, actualSource, ENV)).toBe(true)
      expect(isSessionTokenReadAuthorityCurrent(selected.authority, actualSource, ENV)).toBe(true)
      expect(vi.mocked(keytar.getPassword).mock.calls).toHaveLength(nativeReads)
      expect(fileReads).not.toHaveBeenCalled()
      fileReads.mockRestore()
      expect((await select(store)).token).toBe('fixture-accepted-home')
    }
  )

  it('focuses only the original observed native publication without adopting a newer same-value write', async () => {
    const store = new TokenStore()
    await produce(store, 'native', 'fixture-accepted-home')
    await produce(store, 'encrypted', 'fixture-accepted-home')
    let acceptedScope: SessionTokenReadAuthority | undefined
    await expect(
      store.getSafeStorageSessionToken(ENV, {
        onTokenRead: (_source, authority) => {
          acceptedScope = authority
        },
      })
    ).resolves.toBe('fixture-accepted-home')
    expect(acceptedScope).toBeDefined()
    const originallyFocused = focusSessionTokenReadAuthority(acceptedScope, 'keytar', ENV)
    expect(isSessionTokenReadAuthorityCurrent(originallyFocused, 'keytar', ENV)).toBe(true)
    expect(isSessionTokenReadAuthorityCurrent(acceptedScope, 'safe-storage', ENV)).toBe(true)

    await new TokenStore().setSessionToken('fixture-accepted-home', ENV, { requireKeytar: true })
    const lateOriginalFocus = focusSessionTokenReadAuthority(acceptedScope, 'keytar', ENV)
    expect(lateOriginalFocus).toBeDefined()
    expect(isSessionTokenReadAuthorityCurrent(lateOriginalFocus, 'keytar', ENV)).toBe(false)
    expect(isSessionTokenReadAuthorityCurrent(originallyFocused, 'keytar', ENV)).toBe(false)
    expect(isSessionTokenReadAuthorityCurrent(acceptedScope, 'safe-storage', ENV)).toBe(true)
    await expect(store.getKeytarSessionToken(ENV)).resolves.toBe('fixture-accepted-home')
  })

  it('preserves observed absence rather than capturing a later active encrypted publication', async () => {
    const store = new TokenStore()
    await produce(store, 'native', 'fixture-accepted-home')
    const selected = await select(store)
    const absentFocus = focusSessionTokenReadAuthority(selected.authority, 'safe-storage', ENV)
    expect(isSessionTokenReadAuthorityCurrent(absentFocus, 'safe-storage', ENV)).toBe(true)
    await expect(store.getSafeStorageSessionToken(ENV)).resolves.toBeNull()

    await store.setSafeStorageSessionToken('fixture-independent', ENV)
    const lateAbsentFocus = focusSessionTokenReadAuthority(selected.authority, 'safe-storage', ENV)
    expect(lateAbsentFocus).toBeDefined()
    expect(isSessionTokenReadAuthorityCurrent(lateAbsentFocus, 'safe-storage', ENV)).toBe(false)
    expect(isSessionTokenReadAuthorityCurrent(selected.authority, 'keytar', ENV)).toBe(true)
    await expect(store.getSafeStorageSessionToken(ENV)).resolves.toBe('fixture-independent')
  })

  it('refuses forged, wrong-environment and unobserved native focus in an isolated scope', async () => {
    const store = await fixtureStore('plaintext')
    await produce(store, 'plaintext', 'fixture-accepted-home')
    const selected = await select(store)
    expect(focusSessionTokenReadAuthority(undefined, 'historical-plaintext', ENV)).toBeUndefined()
    expect(
      focusSessionTokenReadAuthority({} as SessionTokenReadAuthority, 'historical-plaintext', ENV)
    ).toBeUndefined()
    expect(
      focusSessionTokenReadAuthority(selected.authority, 'historical-plaintext', LEGACY_ENV)
    ).toBeUndefined()
    expect(
      focusSessionTokenReadAuthority(selected.authority, 'historical-plaintext', '../invalid')
    ).toBeUndefined()
    expect(focusSessionTokenReadAuthority(selected.authority, 'keytar', ENV)).toBeUndefined()
    const originalPlaintext = focusSessionTokenReadAuthority(
      selected.authority,
      'historical-plaintext',
      ENV
    )
    expect(isSessionTokenReadAuthorityCurrent(originalPlaintext, 'historical-plaintext', ENV)).toBe(
      true
    )
    expect((await select(store)).token).toBe('fixture-accepted-home')
  })

  it.each(['native', 'encrypted', 'plaintext'] as const)(
    'checks only the actual selected %s resource without granting another source authority',
    async source => {
      const store = await fixtureStore(source)
      await produce(store, source, 'fixture-rejected')
      const selected = await select(store)
      const actualSource =
        source === 'native'
          ? 'keytar'
          : source === 'encrypted'
            ? 'safe-storage'
            : 'historical-plaintext'
      expect(isSessionTokenReadAuthorityCurrent(selected.authority, actualSource, ENV)).toBe(true)
      expect(isSessionTokenReadAuthorityCurrent(selected.authority, actualSource, LEGACY_ENV)).toBe(
        false
      )
      expect(
        isSessionTokenReadAuthorityCurrent({} as SessionTokenReadAuthority, actualSource, ENV)
      ).toBe(false)
      expect(isSessionTokenReadAuthorityCurrent(undefined, actualSource, ENV)).toBe(false)
      for (const otherSource of ['keytar', 'safe-storage', 'historical-plaintext'] as const) {
        if (otherSource !== actualSource)
          expect(isSessionTokenReadAuthorityCurrent(selected.authority, otherSource, ENV)).toBe(
            false
          )
      }
      await produce(store, source, 'fixture-rejected')
      expect(isSessionTokenReadAuthorityCurrent(selected.authority, actualSource, ENV)).toBe(false)
    }
  )

  it('does not conflate an unrelated legacy publication with the selected active source', async () => {
    const store = new TokenStore()
    await produce(store, 'native', 'fixture-rejected')
    const selected = await select(store)
    await store.setSessionToken('fixture-new-legacy', LEGACY_ENV, { requireKeytar: true })
    expect(isSessionTokenReadAuthorityCurrent(selected.authority, 'keytar', ENV)).toBe(true)
    expect(await cleanup(store, 'native', selected.authority)).toBe(false)
    await expect(store.getKeytarSessionToken(LEGACY_ENV)).resolves.toBe('fixture-new-legacy')
  })

  it('rejects an original selected receipt during and after an actual in-flight native publication', async () => {
    const store = new TokenStore()
    await produce(store, 'native', 'fixture-rejected')
    const selected = await select(store)
    let releaseWrite!: () => void
    const heldWrite = new Promise<void>(resolve => {
      releaseWrite = resolve
    })
    let dispatched = false
    const keytar = await import('keytar')
    vi.mocked(keytar.setPassword).mockImplementationOnce(async (_service, account, token) => {
      dispatched = true
      await heldWrite
      fixture.keychain.set(account, token)
    })
    const write = store.setSessionToken('fixture-rejected', ENV, { requireKeytar: true })
    try {
      await vi.waitFor(() => expect(dispatched).toBe(true), { timeout: 1000 })
      expect(isSessionTokenReadAuthorityCurrent(selected.authority, 'keytar', ENV)).toBe(false)
    } finally {
      releaseWrite()
      await write
    }
    expect(isSessionTokenReadAuthorityCurrent(selected.authority, 'keytar', ENV)).toBe(false)
  })

  it.each(['native', 'encrypted', 'plaintext'] as const)(
    'preserves a newer identical %s publication even when the late snapshot has identical bytes',
    async source => {
      const store = await fixtureStore(source)
      await produce(store, source, 'fixture-rejected')
      const selected = await select(store)
      await produce(store, source, 'fixture-rejected')
      expect(await cleanup(store, source, selected.authority)).toBe(false)
      expect((await select(store)).token).toBe('fixture-rejected')
    }
  )

  it.each(['native', 'encrypted', 'plaintext'] as const)(
    'pure %s reads retain the original authority for owned conditional cleanup',
    async source => {
      const store = await fixtureStore(source)
      await produce(store, source, 'fixture-rejected')
      const selected = await select(store)
      await select(store)
      expect(await cleanup(store, source, selected.authority)).toBe(true)
      await expect(store.getSessionToken(ENV, { allowLegacyMigration: false })).resolves.toBeNull()
    }
  )

  it.each(['native', 'encrypted'] as const)(
    'does not advance %s publication when the synchronous admission callback declines dispatch',
    async source => {
      const store = await fixtureStore(source)
      await produce(store, source, 'fixture-rejected')
      const selected = await select(store)
      const failure = new Error('fixture-declined admission')
      const options = {
        onMutationDispatched: () => {
          throw failure
        },
      }
      await expect(
        source === 'native'
          ? store.setSessionToken('fixture-rejected', ENV, { ...options, requireKeytar: true })
          : store.setSafeStorageSessionToken('fixture-rejected', ENV, options)
      ).rejects.toBe(failure)
      expect(await cleanup(store, source, selected.authority)).toBe(true)
    }
  )

  it('invalidates old native ownership after a setter rejects after actual publication', async () => {
    const store = new TokenStore()
    await produce(store, 'native', 'fixture-rejected')
    const selected = await select(store)
    const keytar = await import('keytar')
    vi.mocked(keytar.setPassword).mockImplementationOnce(async (_service, account, token) => {
      fixture.keychain.set(account, token)
      throw new Error('fixture-partial native rejection')
    })
    await expect(
      store.setSessionToken('fixture-rejected', ENV, { requireKeytar: true })
    ).rejects.toThrow('Failed to replace session token in Keytar')
    expect(await cleanup(store, 'native', selected.authority)).toBe(false)
    expect((await select(store)).token).toBe('fixture-rejected')
  })

  it('captures native authority before a queued same-value writer leaves the read lane', async () => {
    const store = new TokenStore()
    await produce(store, 'native', 'fixture-rejected')
    let authority: SessionTokenReadAuthority | undefined
    const read = store.getKeytarSessionToken(ENV, {
      legacyEnvKeys: [LEGACY_ENV],
      onTokenRead: (_source, observed) => {
        authority = observed
      },
    })
    const write = new TokenStore().setSessionToken('fixture-rejected', ENV, { requireKeytar: true })
    await expect(read).resolves.toBe('fixture-rejected')
    await write
    expect(authority).toBeDefined()
    expect(await cleanup(store, 'native', authority!)).toBe(false)
    await expect(store.getKeytarSessionToken(ENV)).resolves.toBe('fixture-rejected')
  })

  it.each(['native', 'encrypted'] as const)(
    'rejects missing or forged %s read authority',
    async source => {
      const store = await fixtureStore(source)
      await produce(store, source, 'fixture-rejected')
      const snapshot = await store.snapshotSessionTokenFallbackFiles(ENV)
      for (const authority of [undefined, {} as SessionTokenReadAuthority]) {
        await expect(
          source === 'native'
            ? store.clearKeytarSessionTokensStrictly(ENV, {
                onlyIfMatches: 'fixture-rejected',
                readAuthority: authority,
              })
            : store.retireSessionTokenFallbackFilesIfUnchanged(snapshot, {
                onlyIfMatches: 'fixture-rejected',
                readAuthority: authority,
              })
        ).rejects.toThrow('requires original read authority')
      }
      expect((await select(store)).token).toBe('fixture-rejected')
    }
  )
})
