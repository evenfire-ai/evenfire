import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { TokenStore, isSessionTokenMutationCallbackFailure } from '../tokenStore.js'

const fixture = vi.hoisted(() => ({
  directory: '',
  keychain: new Map<string, string>(),
  nativeReadLocked: false,
  encryptionAvailable: true,
  failNativeDestination: false,
}))
vi.mock('electron', () => ({
  app: { isReady: () => true, getPath: () => fixture.directory },
  safeStorage: {
    isEncryptionAvailable: () => fixture.encryptionAvailable,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (token: string) => Buffer.from(`encrypted:${token}`),
    decryptString: (value: Buffer) => value.toString().slice('encrypted:'.length),
  },
}))
vi.mock('keytar', () => ({
  getPassword: vi.fn(async (_service: string, account: string) => {
    if (fixture.nativeReadLocked) throw new Error('fixture-keyring temporarily locked')
    return fixture.keychain.get(account) ?? null
  }),
  setPassword: vi.fn(async (_service: string, account: string, token: string) => {
    if (fixture.failNativeDestination && account === 'session-token::active-111111111111')
      throw new Error('fixture-active native write unavailable')
    fixture.keychain.set(account, token)
  }),
  deletePassword: vi.fn(async (_service: string, account: string) =>
    fixture.keychain.delete(account)
  ),
}))
const ENV = 'active-111111111111'
const LEGACY_ENV = 'legacy-222222222222'

beforeEach(async () => {
  fixture.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-read-provenance-'))
  fixture.keychain.clear()
  fixture.nativeReadLocked = false
  fixture.encryptionAvailable = true
  fixture.failNativeDestination = false
  vi.clearAllMocks()
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(fixture.directory, { recursive: true, force: true })
})

describe('actual selected credential read provenance', () => {
  it.each([
    { source: 'keytar', scope: 'environment' },
    { source: 'safe-storage', scope: 'environment' },
    { source: 'historical-plaintext', scope: 'environment' },
    { source: 'keytar', scope: 'global' },
    { source: 'safe-storage', scope: 'global' },
    { source: 'historical-plaintext', scope: 'global' },
  ] as const)(
    'does not adopt or mutate a legacy $scope $source during verification-only selection',
    async ({ source, scope }) => {
      const store = new TokenStore()
      if (source === 'keytar')
        await store.setSessionToken('fixture-legacy-only', LEGACY_ENV, { requireKeytar: true })
      else if (source === 'safe-storage')
        await store.setSafeStorageSessionToken('fixture-legacy-only', LEGACY_ENV)
      else {
        fixture.encryptionAvailable = false
        await new TokenStore({ isolatedUserDataPath: fixture.directory }).setSessionToken(
          'fixture-legacy-only',
          LEGACY_ENV
        )
        fixture.encryptionAvailable = true
      }
      const keytar = await import('keytar')
      if (scope === 'global') {
        if (source === 'keytar') {
          // Historical producer topology used one native global account.
          await keytar.setPassword('Evenfire', 'session-token', 'fixture-legacy-only')
          await keytar.deletePassword('Evenfire', `session-token::${LEGACY_ENV}`)
        } else {
          const extension = source === 'safe-storage' ? 'enc' : 'json'
          await fs.rename(
            path.join(fixture.directory, `session-token-${LEGACY_ENV}.${extension}`),
            path.join(fixture.directory, `session-token.${extension}`)
          )
        }
      }
      const files = (await fs.readdir(fixture.directory)).sort()
      vi.mocked(keytar.setPassword).mockClear()
      vi.mocked(keytar.deletePassword).mockClear()
      const onTokenRead = vi.fn()
      const onMutationDispatched = vi.fn()
      await expect(
        store.getSessionToken(ENV, {
          legacyEnvKeys: [LEGACY_ENV],
          allowLegacyMigration: false,
          onTokenRead,
          onMutationDispatched,
        })
      ).resolves.toBeNull()
      expect(onTokenRead).not.toHaveBeenCalled()
      expect(onMutationDispatched).not.toHaveBeenCalled()
      expect(keytar.setPassword).not.toHaveBeenCalled()
      expect(keytar.deletePassword).not.toHaveBeenCalled()
      expect((await fs.readdir(fixture.directory)).sort()).toEqual(files)
      if (scope === 'global' && source === 'keytar')
        expect(await keytar.getPassword('Evenfire', 'session-token')).toBe('fixture-legacy-only')
      else if (scope === 'global' && source === 'safe-storage')
        expect(
          (await fs.readFile(path.join(fixture.directory, 'session-token.enc'))).toString()
        ).toBe('encrypted:fixture-legacy-only')
      else if (scope === 'global')
        expect(
          JSON.parse(await fs.readFile(path.join(fixture.directory, 'session-token.json'), 'utf8'))
            .token
        ).toBe('fixture-legacy-only')
      else if (source === 'keytar')
        expect(await store.getKeytarSessionToken(LEGACY_ENV)).toBe('fixture-legacy-only')
      else if (source === 'safe-storage')
        expect(await store.getSafeStorageSessionToken(LEGACY_ENV)).toBe('fixture-legacy-only')
      else
        expect(
          JSON.parse(
            await fs.readFile(
              path.join(fixture.directory, `session-token-${LEGACY_ENV}.json`),
              'utf8'
            )
          ).token
        ).toBe('fixture-legacy-only')
    }
  )
  it('reports native selection rather than the coincidental presence of a different encrypted value', async () => {
    const store = new TokenStore()
    await store.setSessionToken('fixture-native-current', ENV, { requireKeytar: true })
    await store.setSafeStorageSessionToken('fixture-encrypted-unselected', ENV)
    const onTokenRead = vi.fn()
    const onMutationDispatched = vi.fn()
    await expect(
      new TokenStore().getSessionToken(ENV, {
        allowLegacyMigration: false,
        onTokenRead,
        onMutationDispatched,
      })
    ).resolves.toBe('fixture-native-current')
    expect(onTokenRead.mock.calls).toEqual([['keytar', expect.any(Object)]])
    expect(onMutationDispatched).not.toHaveBeenCalled()
    expect(await store.getSafeStorageSessionToken(ENV)).toBe('fixture-encrypted-unselected')
  })

  it('reports the real encrypted selection while an older native credential is locked', async () => {
    const store = new TokenStore()
    await store.setSessionToken('fixture-native-older', ENV, { requireKeytar: true })
    await store.setSafeStorageSessionToken('fixture-encrypted-selected', ENV)
    fixture.nativeReadLocked = true
    const onTokenRead = vi.fn()
    const onMutationDispatched = vi.fn()
    await expect(
      new TokenStore().getSessionToken(ENV, { onTokenRead, onMutationDispatched })
    ).resolves.toBe('fixture-encrypted-selected')
    expect(onTokenRead.mock.calls).toEqual([['safe-storage', expect.any(Object)]])
    expect(onMutationDispatched).not.toHaveBeenCalled()
    fixture.nativeReadLocked = false
    expect(await store.getKeytarSessionToken(ENV)).toBe('fixture-native-older')
  })

  it('reports historical plaintext distinctly without dispatching a new write', async () => {
    fixture.encryptionAvailable = false
    await new TokenStore({ isolatedUserDataPath: fixture.directory }).setSessionToken(
      'fixture-historical',
      ENV
    )
    const onTokenRead = vi.fn()
    const onMutationDispatched = vi.fn()
    await expect(
      new TokenStore().getSessionToken(ENV, { onTokenRead, onMutationDispatched })
    ).resolves.toBe('fixture-historical')
    expect(onTokenRead.mock.calls).toEqual([['historical-plaintext', expect.any(Object)]])
    expect(onMutationDispatched).not.toHaveBeenCalled()
    expect(await fs.readdir(fixture.directory)).toEqual([`session-token-${ENV}.json`])
  })

  it('does not report a source when the actual credential is absent', async () => {
    const onTokenRead = vi.fn()
    const onMutationDispatched = vi.fn()
    await expect(
      new TokenStore().getSessionToken(ENV, { onTokenRead, onMutationDispatched })
    ).resolves.toBeNull()
    expect(onTokenRead).not.toHaveBeenCalled()
    expect(onMutationDispatched).not.toHaveBeenCalled()
    expect(await fs.readdir(fixture.directory)).toEqual([])
  })

  it('reports completed migration authority separately from earlier native dispatch attempts', async () => {
    await new TokenStore().setSessionToken('fixture-legacy', LEGACY_ENV, { requireKeytar: true })
    fixture.failNativeDestination = true
    const onTokenRead = vi.fn()
    const onMutationDispatched = vi.fn()
    await expect(
      new TokenStore().getSessionToken(ENV, {
        legacyEnvKeys: [LEGACY_ENV],
        onTokenRead,
        onMutationDispatched,
      })
    ).resolves.toBe('fixture-legacy')
    expect(onTokenRead.mock.calls).toEqual([['safe-storage', expect.any(Object)]])
    expect(onMutationDispatched.mock.calls).toEqual([
      ['keytar', 'fixture-legacy'],
      ['safe-storage', 'fixture-legacy'],
    ])
    expect(await new TokenStore().getSafeStorageSessionToken(ENV)).toBe('fixture-legacy')
    expect(await new TokenStore().getKeytarSessionToken(LEGACY_ENV)).toBeNull()
    const restartedRead = vi.fn()
    await expect(
      new TokenStore().getSessionToken(ENV, { onTokenRead: restartedRead })
    ).resolves.toBe('fixture-legacy')
    expect(restartedRead.mock.calls).toEqual([['safe-storage', expect.any(Object)]])
  })

  it.each(['keytar', 'safe-storage', 'historical-plaintext', 'migration'] as const)(
    'propagates %s metadata failure instead of authorizing another source',
    async source => {
      const store = new TokenStore()
      if (source === 'keytar') await store.setSessionToken('fixture-selected', ENV)
      else if (source === 'safe-storage')
        await store.setSafeStorageSessionToken('fixture-selected', ENV)
      else if (source === 'historical-plaintext') {
        fixture.encryptionAvailable = false
        await new TokenStore({ isolatedUserDataPath: fixture.directory }).setSessionToken(
          'fixture-selected',
          ENV
        )
      } else await store.setSessionToken('fixture-selected', LEGACY_ENV)
      const failure = new Error('fixture-metadata observer rejected')
      const onTokenRead = vi.fn(() => {
        throw failure
      })
      const onMutationDispatched = vi.fn()
      await expect(
        store.getSessionToken(ENV, {
          legacyEnvKeys: source === 'migration' ? [LEGACY_ENV] : [],
          onTokenRead,
          onMutationDispatched,
        })
      ).rejects.toBe(failure)
      expect(onTokenRead).toHaveBeenCalledTimes(1)
      if (source === 'migration') {
        expect(onMutationDispatched.mock.calls).toEqual([['keytar', 'fixture-selected']])
        expect(await store.getKeytarSessionToken(ENV)).toBe('fixture-selected')
        expect(await store.getKeytarSessionToken(LEGACY_ENV)).toBeNull()
      } else expect(onMutationDispatched).not.toHaveBeenCalled()
    }
  )

  it('does not authorize fallback when a native dispatch observer rejects before publication', async () => {
    const failure = Object.freeze(new Error('fixture-dispatch observer rejected'))
    const onMutationDispatched = vi.fn().mockImplementationOnce(() => {
      throw failure
    })
    const keytar = await import('keytar')
    await expect(
      new TokenStore().setSessionToken('fixture-never-published', ENV, {
        onMutationDispatched,
      })
    ).rejects.toBe(failure)
    expect(isSessionTokenMutationCallbackFailure(failure)).toBe(true)
    expect(onMutationDispatched.mock.calls).toEqual([['keytar', 'fixture-never-published']])
    expect(keytar.setPassword).not.toHaveBeenCalled()
    expect(await fs.readdir(fixture.directory)).toEqual([])
    expect(await new TokenStore().getKeytarSessionToken(ENV)).toBeNull()
  })

  it('preserves a frozen encrypted admission failure before actual rename', async () => {
    const failure = Object.freeze(new Error('fixture-encrypted admission rejected'))
    const onMutationDispatched = vi.fn(() => {
      throw failure
    })
    const rename = vi.spyOn(fs, 'rename')
    await expect(
      new TokenStore().setSafeStorageSessionToken('fixture-never-published', ENV, {
        onMutationDispatched,
      })
    ).rejects.toBe(failure)
    expect(isSessionTokenMutationCallbackFailure(failure)).toBe(true)
    expect(onMutationDispatched).toHaveBeenCalledWith('safe-storage', 'fixture-never-published')
    expect(rename).not.toHaveBeenCalled()
    expect(await fs.readdir(fixture.directory)).toEqual([])
    expect(await new TokenStore().getSafeStorageSessionToken(ENV)).toBeNull()
  })

  it('wraps primitive admission failure without exposing its contents or publishing a candidate', async () => {
    const onMutationDispatched = vi.fn(() => {
      throw 'fixture-private-foreign-value'
    })
    const keytar = await import('keytar')
    const failure = await new TokenStore()
      .setSessionToken('fixture-never-published', ENV, { onMutationDispatched })
      .then(
        () => null,
        error => error
      )
    expect(failure).toBeInstanceOf(Error)
    expect(isSessionTokenMutationCallbackFailure(failure)).toBe(true)
    expect(failure.message).toBe('Session-token mutation admission callback failed')
    expect(failure.cause).toBeUndefined()
    expect(keytar.setPassword).not.toHaveBeenCalled()
    expect(await fs.readdir(fixture.directory)).toEqual([])
  })

  it('propagates a wrapped primitive migration admission failure without another source', async () => {
    const store = new TokenStore()
    await store.setSessionToken('fixture-legacy', LEGACY_ENV, { requireKeytar: true })
    await store.setSafeStorageSessionToken('fixture-other-legacy-source', LEGACY_ENV)
    const onMutationDispatched = vi.fn(() => {
      throw 'fixture-private-foreign-value'
    })
    const failure = await store
      .getSessionToken(ENV, {
        legacyEnvKeys: [LEGACY_ENV],
        onMutationDispatched,
      })
      .then(
        () => null,
        error => error
      )
    expect(failure).toBeInstanceOf(Error)
    expect(isSessionTokenMutationCallbackFailure(failure)).toBe(true)
    expect(failure.message).toBe('Session-token mutation admission callback failed')
    expect(onMutationDispatched).toHaveBeenCalledTimes(1)
    expect(onMutationDispatched).toHaveBeenCalledWith('keytar', 'fixture-legacy')
    expect(await store.getKeytarSessionToken(ENV)).toBeNull()
    expect(await store.getKeytarSessionToken(LEGACY_ENV)).toBe('fixture-legacy')
    expect(await store.getSafeStorageSessionToken(LEGACY_ENV)).toBe('fixture-other-legacy-source')
  })

  it('does not authorize another migration source after its dispatch observer rejects', async () => {
    const store = new TokenStore()
    await store.setSessionToken('fixture-legacy', LEGACY_ENV)
    await store.setSafeStorageSessionToken('fixture-unselected-legacy', LEGACY_ENV)
    const failure = new Error('fixture-migration dispatch observer rejected')
    const onMutationDispatched = vi.fn().mockImplementationOnce(() => {
      throw failure
    })
    const onTokenRead = vi.fn()
    await expect(
      store.getSessionToken(ENV, {
        legacyEnvKeys: [LEGACY_ENV],
        onTokenRead,
        onMutationDispatched,
      })
    ).rejects.toBe(failure)
    expect(isSessionTokenMutationCallbackFailure(failure)).toBe(true)
    expect(onMutationDispatched.mock.calls).toEqual([['keytar', 'fixture-legacy']])
    expect(onTokenRead).not.toHaveBeenCalled()
    expect(await store.getKeytarSessionToken(ENV)).toBeNull()
    expect(await store.getKeytarSessionToken(LEGACY_ENV)).toBe('fixture-legacy')
    expect(await store.getSafeStorageSessionToken(LEGACY_ENV)).toBe('fixture-unselected-legacy')
    expect(await fs.readdir(fixture.directory)).toEqual([`session-token-${LEGACY_ENV}.enc`])
  })
})
