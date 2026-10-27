import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const fixture = vi.hoisted(() => ({
  directory: '',
  keychain: new Map<string, string>(),
  keytarAvailable: false,
  encryptionAvailable: false,
  packaged: false,
  partialNativeWrite: false,
  getPassword: vi.fn(),
  setPassword: vi.fn(),
  deletePassword: vi.fn(),
}))
vi.mock('electron', () => ({
  app: {
    isReady: () => true,
    getPath: () => fixture.directory,
    get isPackaged() {
      return fixture.packaged
    },
  },
  safeStorage: {
    isEncryptionAvailable: () => fixture.encryptionAvailable,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (token: string) => Buffer.from(`encrypted:${token}`),
    decryptString: (value: Buffer) => value.toString().slice('encrypted:'.length),
  },
}))

const ENV = 'current-111111111111'
const LEGACY_ENV = 'legacy-222222222222'
const account = `session-token::${ENV}`

beforeEach(async () => {
  vi.resetModules()
  fixture.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-production-authority-'))
  fixture.keychain.clear()
  fixture.keytarAvailable = false
  fixture.encryptionAvailable = false
  fixture.packaged = false
  fixture.partialNativeWrite = false
  fixture.getPassword
    .mockReset()
    .mockImplementation(async (_service, target) => fixture.keychain.get(target) ?? null)
  fixture.setPassword.mockReset().mockImplementation(async (_service, target, token) => {
    fixture.keychain.set(target, token)
    if (fixture.partialNativeWrite) throw new Error('fixture-native rejected after writing')
  })
  fixture.deletePassword
    .mockReset()
    .mockImplementation(async (_service, target) => fixture.keychain.delete(target))
  vi.doMock('keytar', () =>
    fixture.keytarAvailable
      ? {
          getPassword: fixture.getPassword,
          setPassword: fixture.setPassword,
          deletePassword: fixture.deletePassword,
        }
      : {}
  )
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(fixture.directory, { recursive: true, force: true })
  vi.resetModules()
})

describe('owner-approved secure authority for new production writes', () => {
  it('rejects before publication when both production secure stores are unavailable', async () => {
    const { TokenStore, SessionTokenStorageUnavailableBeforeWriteError } =
      await import('../tokenStore.js')
    const receipt = vi.fn()
    const store = new TokenStore()
    await expect(
      store.setSessionToken('fixture-new', ENV, { onMutationDispatched: receipt })
    ).rejects.toBeInstanceOf(SessionTokenStorageUnavailableBeforeWriteError)
    expect(receipt).not.toHaveBeenCalled()
    expect(await fs.readdir(fixture.directory)).toEqual([])
    expect(await new TokenStore().getSessionToken(ENV)).toBeNull()
  })

  it('does not mislabel an earlier partial native write as a whole-operation before-write failure', async () => {
    fixture.keytarAvailable = true
    fixture.partialNativeWrite = true
    const { TokenStore, SessionTokenStorageUnavailableBeforeWriteError } =
      await import('../tokenStore.js')
    const receipt = vi.fn()
    const error = await new TokenStore()
      .setSessionToken('fixture-partial', ENV, {
        onMutationDispatched: receipt,
      })
      .then(
        () => null,
        error => error
      )
    expect(error).toBeInstanceOf(AggregateError)
    expect(error).not.toBeInstanceOf(SessionTokenStorageUnavailableBeforeWriteError)
    expect(receipt.mock.calls).toEqual([['keytar', 'fixture-partial']])
    expect(fixture.keychain.get(account)).toBe('fixture-partial')
    expect(await fs.readdir(fixture.directory)).toEqual([])
  })

  it('selects encrypted fallback with a source-tagged attempted-publication receipt', async () => {
    fixture.encryptionAvailable = true
    const { TokenStore } = await import('../tokenStore.js')
    const receipt = vi.fn()
    await new TokenStore().setSessionToken('fixture-secure', ENV, {
      onMutationDispatched: receipt,
    })
    expect(receipt.mock.calls).toEqual([['safe-storage', 'fixture-secure']])
    expect(await fs.readdir(fixture.directory)).toEqual([`session-token-${ENV}.enc`])
    expect(await new TokenStore().getSafeStorageSessionToken(ENV)).toBe('fixture-secure')
  })

  it('keeps plaintext limited to an explicitly isolated unpackaged producer', async () => {
    const { TokenStore } = await import('../tokenStore.js')
    const store = new TokenStore({ isolatedUserDataPath: fixture.directory })
    const receipt = vi.fn()
    expect(store.isIsolatedDevelopmentStorage()).toBe(true)
    expect(new TokenStore().isIsolatedDevelopmentStorage()).toBe(false)
    await store.setSessionToken('fixture-isolated', ENV, { onMutationDispatched: receipt })
    expect(receipt.mock.calls).toEqual([['isolated-plaintext', 'fixture-isolated']])
    expect(
      await new TokenStore({ isolatedUserDataPath: fixture.directory }).getSessionToken(ENV)
    ).toBe('fixture-isolated')
    expect(
      (await fs.stat(path.join(fixture.directory, `session-token-${ENV}.json`))).mode & 0o777
    ).toBe(0o600)
    expect(fixture.getPassword).not.toHaveBeenCalled()
    expect(fixture.setPassword).not.toHaveBeenCalled()
  })

  it('refuses isolated storage in a packaged process before touching any source', async () => {
    const { TokenStore } = await import('../tokenStore.js')
    const store = new TokenStore({ isolatedUserDataPath: fixture.directory })
    fixture.packaged = true
    await expect(store.setSessionToken('fixture-refused', ENV)).rejects.toThrow('unpackaged')
    await expect(store.getSessionToken(ENV)).rejects.toThrow('unpackaged')
    await expect(store.clearSessionToken(ENV)).rejects.toThrow('unpackaged')
    expect(await fs.readdir(fixture.directory)).toEqual([])
    expect(fixture.getPassword).not.toHaveBeenCalled()
    expect(fixture.setPassword).not.toHaveBeenCalled()
    expect(fixture.deletePassword).not.toHaveBeenCalled()
  })

  it('requires fresh authentication for historical plaintext and preserves denied bytes', async () => {
    const { TokenStore } = await import('../tokenStore.js')
    await new TokenStore({ isolatedUserDataPath: fixture.directory }).setSessionToken(
      'fixture-old',
      ENV
    )
    const existing = await fs.readFile(path.join(fixture.directory, `session-token-${ENV}.json`))
    expect(await new TokenStore().getSessionToken(ENV)).toBeNull()
    await expect(new TokenStore().setSessionToken('fixture-new', ENV)).rejects.toThrow(
      'safeStorage'
    )
    expect(await fs.readFile(path.join(fixture.directory, `session-token-${ENV}.json`))).toEqual(
      existing
    )
  })

  it.each(['environment', 'global'] as const)(
    'preserves an old %s plaintext source when a new secure migration cannot complete',
    async scope => {
      const { TokenStore } = await import('../tokenStore.js')
      await new TokenStore({ isolatedUserDataPath: fixture.directory }).setSessionToken(
        'fixture-old',
        LEGACY_ENV
      )
      const scoped = path.join(fixture.directory, `session-token-${LEGACY_ENV}.json`)
      const source =
        scope === 'global' ? path.join(fixture.directory, 'session-token.json') : scoped
      if (scope === 'global') await fs.rename(scoped, source)
      const existing = await fs.readFile(source)
      const receipt = vi.fn()
      expect(
        await new TokenStore().getSessionToken(ENV, {
          legacyEnvKeys: scope === 'environment' ? [LEGACY_ENV] : [],
          onMutationDispatched: receipt,
        })
      ).toBeNull()
      expect(receipt).not.toHaveBeenCalled()
      expect(await fs.readFile(source)).toEqual(existing)
      expect(await fs.readdir(fixture.directory)).toEqual([path.basename(source)])
    }
  )
})
