import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  disposeTokenStorePersistenceFixture,
  tokenStorePersistenceFixture as fixture,
  resetTokenStorePersistenceFixture,
} from '../../testSupport/tokenStorePersistenceFixture.js'
import { SessionTokenStorageSupersededBeforeWriteError, TokenStore } from '../tokenStore.js'

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
const OTHER_ENV = 'other-444444444444'
const encrypted = (env = ENV) => path.join(fixture.directory, `session-token-${env}.enc`)
const plaintext = (env = ENV) => path.join(fixture.directory, `session-token-${env}.json`)
beforeEach(async () => {
  await resetTokenStorePersistenceFixture('evenfire-fallback-retirement-')
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
async function produceSixFiles() {
  const store = new TokenStore()
  for (const env of [ENV, LEGACY_ENV, GLOBAL_PRODUCER_ENV]) {
    await store.setSafeStorageSessionToken('fixture-old-user', env)
    await producePlaintext(env, 'fixture-old-user')
  }
  await fs.rename(encrypted(GLOBAL_PRODUCER_ENV), path.join(fixture.directory, 'session-token.enc'))
  await fs.rename(
    plaintext(GLOBAL_PRODUCER_ENV),
    path.join(fixture.directory, 'session-token.json')
  )
  return store
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

describe('observed fallback file retirement', () => {
  it.each([
    { reported: false, scope: 'aliases' },
    { reported: true, scope: 'aliases' },
    { reported: false, scope: 'full' },
    { reported: true, scope: 'full' },
  ] as const)(
    'does not certify $scope native cleanup when delete reports $reported but the value remains',
    async ({ reported, scope }) => {
      const store = new TokenStore()
      await store.setSessionToken('fixture-active', ENV, { requireKeytar: true })
      await store.setSessionToken('fixture-stale-native-alias', LEGACY_ENV, {
        requireKeytar: true,
      })
      const keytar = await import('keytar')
      const deletePassword = vi.mocked(keytar.deletePassword).getMockImplementation()!
      vi.mocked(keytar.deletePassword).mockImplementation(async (service, account) =>
        account === `session-token::${LEGACY_ENV}` ? reported : deletePassword(service, account)
      )
      await expect(
        scope === 'aliases'
          ? store.clearKeytarSessionTokensStrictly(ENV, {
              legacyEnvKeys: [LEGACY_ENV],
              preserveActiveEnvKey: true,
            })
          : store.clearSessionTokenStrictly(ENV, { legacyEnvKeys: [LEGACY_ENV] })
      ).rejects.toThrow('Failed to clear session token storage')
      expect(await store.getKeytarSessionToken(ENV)).toBe(
        scope === 'aliases' ? 'fixture-active' : null
      )
      expect(await store.getKeytarSessionToken(LEGACY_ENV)).toBe('fixture-stale-native-alias')
    }
  )

  it('accepts idempotent false native deletion only after observing the alias is absent', async () => {
    const store = new TokenStore()
    await store.setSessionToken('fixture-active', ENV, { requireKeytar: true })
    await expect(
      store.clearKeytarSessionTokensStrictly(ENV, {
        legacyEnvKeys: [LEGACY_ENV],
        preserveActiveEnvKey: true,
      })
    ).resolves.toEqual({
      keytarAvailable: true,
      keytarDisabled: false,
      keytarDisposition: 'available',
    })
    const keytar = await import('keytar')
    expect(
      await Promise.all(vi.mocked(keytar.deletePassword).mock.results.map(row => row.value))
    ).toEqual([false, false])
    expect(await store.getKeytarSessionToken(ENV)).toBe('fixture-active')
    expect(await store.getKeytarSessionToken(LEGACY_ENV)).toBeNull()
  })

  it.each(['strict', 'best-effort'] as const)(
    'rejects superseded %s full clear without deleting any observed credential',
    async mode => {
      const store = await produceSixFiles()
      await store.setSessionToken('fixture-valid-native', ENV, { requireKeytar: true })
      await expect(
        mode === 'strict'
          ? store.clearSessionTokenStrictly(ENV, { mayWrite: () => false })
          : store.clearSessionToken(ENV, { mayWrite: () => false })
      ).rejects.toBeInstanceOf(SessionTokenStorageSupersededBeforeWriteError)
      expect((await fs.readdir(fixture.directory)).length).toBe(6)
      expect(await store.getKeytarSessionToken(ENV)).toBe('fixture-valid-native')
    }
  )

  it.each(['strict', 'best-effort'] as const)(
    'rechecks queued %s file deletion ownership at actual dispatch',
    async mode => {
      const store = new TokenStore({ isolatedUserDataPath: fixture.directory })
      await store.setSafeStorageSessionToken('fixture-original', ENV)
      const entered = deferred()
      const release = deferred()
      const rename = fs.rename.bind(fs)
      vi.spyOn(fs, 'rename').mockImplementationOnce(async (source, target) => {
        entered.resolve()
        await release.promise
        return rename(source, target)
      })
      const writing = store.setSafeStorageSessionToken('fixture-later-source', ENV)
      const deletionEntered = deferred()
      const actualPlaintextPath = path.join(
        await fs.realpath(fixture.directory),
        `session-token-${ENV}.json`
      )
      const unlink = fs.unlink.bind(fs)
      vi.spyOn(fs, 'unlink').mockImplementation(async file => {
        if (String(file) === actualPlaintextPath) deletionEntered.resolve()
        return unlink(file)
      })
      let owned = true
      let clearing: Promise<unknown> | undefined
      try {
        await reached(entered.promise)
        clearing =
          mode === 'strict'
            ? store.clearSessionTokenStrictly(ENV, { mayWrite: () => owned })
            : store.clearSessionToken(ENV, { mayWrite: () => owned })
        await reached(deletionEntered.promise)
        owned = false
      } finally {
        release.resolve()
        await Promise.allSettled([writing, ...(clearing ? [clearing] : [])])
      }
      await expect(clearing).rejects.toBeInstanceOf(SessionTokenStorageSupersededBeforeWriteError)
      expect(await store.getSafeStorageSessionToken(ENV)).toBe('fixture-later-source')
    }
  )

  it('does not certify native cleanup after ownership is lost during the verified read', async () => {
    const store = new TokenStore()
    await store.setSessionToken('fixture-active', ENV, { requireKeytar: true })
    const keytar = await import('keytar')
    const entered = deferred()
    const release = deferred()
    vi.mocked(keytar.getPassword).mockImplementationOnce(async (_service, account) => {
      const observed = fixture.keychain.get(account) ?? null
      entered.resolve()
      await release.promise
      return observed
    })
    let owned = true
    const clearing = store.clearKeytarSessionTokensStrictly(ENV, {
      preserveActiveEnvKey: true,
      mayWrite: () => owned,
    })
    let writing: Promise<void> | undefined
    try {
      await reached(entered.promise)
      writing = store.setSessionToken('fixture-younger-active', ENV, {
        requireKeytar: true,
      })
      owned = false
    } finally {
      release.resolve()
      await Promise.allSettled([clearing, ...(writing ? [writing] : [])])
    }
    await expect(clearing).rejects.toBeInstanceOf(SessionTokenStorageSupersededBeforeWriteError)
    expect(await store.getKeytarSessionToken(ENV)).toBe('fixture-younger-active')
  })

  it.each(['before-publication', 'after-publication'] as const)(
    'preserves only the verified active encrypted source from a %s snapshot',
    async timing => {
      const store = await produceSixFiles()
      if (timing === 'after-publication')
        await store.setSafeStorageSessionToken('fixture-fresh-authority', ENV)
      const snapshot = await store.snapshotSessionTokenFallbackFiles(ENV, {
        legacyEnvKeys: [LEGACY_ENV],
      })
      if (timing === 'before-publication')
        await store.setSafeStorageSessionToken('fixture-fresh-authority', ENV)
      await expect(
        store.retireSessionTokenFallbackFilesIfUnchanged(snapshot, {
          preserveActiveEncryptedToken: 'fixture-fresh-authority',
        })
      ).resolves.toBe(true)
      expect(await fs.readdir(fixture.directory)).toEqual([`session-token-${ENV}.enc`])
      expect(await new TokenStore().getSafeStorageSessionToken(ENV)).toBe('fixture-fresh-authority')
      fixture.encryptionAvailable = false
      expect(
        await new TokenStore().getSessionToken(ENV, { legacyEnvKeys: [LEGACY_ENV] })
      ).toBeNull()
    }
  )

  it('does not delete any source when the purported encrypted authority is different', async () => {
    const store = await produceSixFiles()
    const snapshot = await store.snapshotSessionTokenFallbackFiles(ENV, {
      legacyEnvKeys: [LEGACY_ENV],
    })
    await store.setSafeStorageSessionToken('fixture-newer-independent', ENV)
    await expect(
      store.retireSessionTokenFallbackFilesIfUnchanged(snapshot, {
        preserveActiveEncryptedToken: 'fixture-stale-attempt',
      })
    ).resolves.toBe(false)
    expect((await fs.readdir(fixture.directory)).length).toBe(6)
    expect(await store.getSafeStorageSessionToken(ENV)).toBe('fixture-newer-independent')
  })

  it('cannot claim encrypted-source retirement while safeStorage is unavailable', async () => {
    const store = await produceSixFiles()
    const snapshot = await store.snapshotSessionTokenFallbackFiles(ENV, {
      legacyEnvKeys: [LEGACY_ENV],
    })
    fixture.encryptionAvailable = false
    await expect(
      store.retireSessionTokenFallbackFilesIfUnchanged(snapshot, {
        preserveActiveEncryptedToken: 'fixture-old-user',
      })
    ).rejects.toThrow('safeStorage is unavailable')
    expect((await fs.readdir(fixture.directory)).length).toBe(6)
  })

  it('does not clean stale extras when the authoritative encrypted file is absent', async () => {
    const store = await produceSixFiles()
    const snapshot = await store.snapshotSessionTokenFallbackFiles(ENV, {
      legacyEnvKeys: [LEGACY_ENV],
    })
    await store.discardSafeStorageSessionTokenIfMatches('fixture-old-user', ENV)
    await expect(
      store.retireSessionTokenFallbackFilesIfUnchanged(snapshot, {
        preserveActiveEncryptedToken: 'fixture-old-user',
      })
    ).resolves.toBe(false)
    expect((await fs.readdir(fixture.directory)).length).toBe(5)
  })

  it('reverifies encrypted authority after the durability await', async () => {
    const store = await produceSixFiles()
    const snapshot = await store.snapshotSessionTokenFallbackFiles(ENV, {
      legacyEnvKeys: [LEGACY_ENV],
    })
    const open = fs.open.bind(fs)
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args)
      if (String(args[0]) === fixture.directory && args[1] === 'r') {
        const sync = handle.sync.bind(handle)
        vi.spyOn(handle, 'sync').mockImplementationOnce(async () => {
          await sync()
          fixture.encryptionAvailable = false
        })
      }
      return handle
    })
    await expect(
      store.retireSessionTokenFallbackFilesIfUnchanged(snapshot, {
        preserveActiveEncryptedToken: 'fixture-old-user',
      })
    ).rejects.toThrow('safeStorage is unavailable')
    expect(await fs.readdir(fixture.directory)).toEqual([`session-token-${ENV}.enc`])
    fixture.encryptionAvailable = true
    expect(await store.getSafeStorageSessionToken(ENV)).toBe('fixture-old-user')
  })

  it('preserves a changed non-authoritative plaintext source and reports incomplete cleanup', async () => {
    const store = await produceSixFiles()
    const snapshot = await store.snapshotSessionTokenFallbackFiles(ENV, {
      legacyEnvKeys: [LEGACY_ENV],
    })
    await producePlaintext(LEGACY_ENV, 'fixture-newer-independent')
    await expect(
      store.retireSessionTokenFallbackFilesIfUnchanged(snapshot, {
        preserveActiveEncryptedToken: 'fixture-old-user',
      })
    ).resolves.toBe(false)
    expect((await fs.readdir(fixture.directory)).sort()).toEqual([
      `session-token-${ENV}.enc`,
      `session-token-${LEGACY_ENV}.json`,
    ])
    expect(JSON.parse(await fs.readFile(plaintext(LEGACY_ENV), 'utf8')).token).toBe(
      'fixture-newer-independent'
    )
  })

  it.each([
    { scope: 'active', representation: 'enc' },
    { scope: 'active', representation: 'json' },
    { scope: 'legacy-env', representation: 'enc' },
    { scope: 'legacy-env', representation: 'json' },
    { scope: 'global', representation: 'enc' },
    { scope: 'global', representation: 'json' },
  ] as const)(
    'reserves the actual $scope $representation path behind an already dispatched mutation',
    async ({ scope, representation }) => {
      const store = new TokenStore()
      const sourceEnv = scope === 'legacy-env' ? LEGACY_ENV : ENV
      if (representation === 'enc') await store.setSafeStorageSessionToken('fixture-old', sourceEnv)
      else await producePlaintext(sourceEnv, 'fixture-old')
      const scoped = representation === 'enc' ? encrypted(sourceEnv) : plaintext(sourceEnv)
      const target =
        scope === 'global'
          ? path.join(fixture.directory, `session-token.${representation}`)
          : scoped
      if (scope === 'global') await fs.rename(scoped, target)
      const entered = deferred()
      const release = deferred()
      const unlink = fs.unlink.bind(fs)
      vi.spyOn(fs, 'unlink').mockImplementation(async file => {
        if (String(file) === target) {
          entered.resolve()
          await release.promise
        }
        return unlink(file)
      })
      const clearing = store.clearSessionToken(sourceEnv)
      let snapshot: ReturnType<TokenStore['snapshotSessionTokenFallbackFiles']> | undefined
      let finished = false
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await reached(entered.promise)
        snapshot = store.snapshotSessionTokenFallbackFiles(ENV, { legacyEnvKeys: [LEGACY_ENV] })
        await Promise.race([
          snapshot.then(() => {
            finished = true
          }),
          new Promise<void>(done => {
            timer = setTimeout(done, 40)
          }),
        ])
        expect(
          finished,
          'snapshot cannot inspect a represented path ahead of its accepted mutation'
        ).toBe(false)
      } finally {
        clearTimeout(timer)
        release.resolve()
        await Promise.allSettled([clearing, ...(snapshot ? [snapshot] : [])])
      }
      const receipt = await snapshot!
      await expect(store.retireSessionTokenFallbackFilesIfUnchanged(receipt)).resolves.toBe(true)
      expect(await fs.readdir(fixture.directory)).toEqual([])
    }
  )

  it('rechecks queued native-alias cleanup ownership at actual deletion dispatch', async () => {
    const store = new TokenStore()
    await store.setSessionToken('fixture-active', ENV, { requireKeytar: true })
    await store.setSessionToken('fixture-legacy', LEGACY_ENV, { requireKeytar: true })
    const keytar = await import('keytar')
    const entered = deferred()
    const release = deferred()
    vi.mocked(keytar.setPassword).mockImplementationOnce(async (_service, target, token) => {
      entered.resolve()
      await release.promise
      fixture.keychain.set(target, token)
    })
    const writing = store.setSessionToken('fixture-later-legacy', LEGACY_ENV, {
      requireKeytar: true,
    })
    let owned = true
    let cleanup: Promise<unknown> | undefined
    try {
      await reached(entered.promise)
      cleanup = store.clearKeytarSessionTokensStrictly(ENV, {
        legacyEnvKeys: [LEGACY_ENV],
        preserveActiveEnvKey: true,
        mayWrite: () => owned,
      })
      await new Promise<void>(done => setImmediate(done))
      owned = false
    } finally {
      release.resolve()
      await Promise.allSettled([writing, ...(cleanup ? [cleanup] : [])])
    }
    await expect(cleanup).rejects.toBeInstanceOf(SessionTokenStorageSupersededBeforeWriteError)
    expect(await store.getKeytarSessionToken(ENV)).toBe('fixture-active')
    expect(await store.getKeytarSessionToken(LEGACY_ENV)).toBe('fixture-later-legacy')
  })

  it('retires all six observed source files without touching native or unrelated environment storage', async () => {
    const store = await produceSixFiles()
    await store.setSessionToken('fixture-valid-native', ENV, { requireKeytar: true })
    await store.setSafeStorageSessionToken('fixture-other-environment', OTHER_ENV)
    const snapshot = await store.snapshotSessionTokenFallbackFiles(ENV, {
      legacyEnvKeys: [LEGACY_ENV],
    })
    await expect(store.retireSessionTokenFallbackFilesIfUnchanged(snapshot)).resolves.toBe(true)
    expect(await fs.readdir(fixture.directory)).toEqual([`session-token-${OTHER_ENV}.enc`])
    expect(await new TokenStore().getKeytarSessionToken(ENV)).toBe('fixture-valid-native')
    expect(await new TokenStore().getSafeStorageSessionToken(OTHER_ENV)).toBe(
      'fixture-other-environment'
    )
  })

  it.each(['changed', 'new'] as const)(
    'preserves a %s independent file and reports incomplete cleanup',
    async mode => {
      const store = new TokenStore()
      if (mode === 'changed') await store.setSafeStorageSessionToken('fixture-old-user', ENV)
      const snapshot = await store.snapshotSessionTokenFallbackFiles(ENV)
      await store.setSafeStorageSessionToken('fixture-newer-producer', ENV)
      await expect(store.retireSessionTokenFallbackFilesIfUnchanged(snapshot)).resolves.toBe(false)
      expect(await new TokenStore().getSafeStorageSessionToken(ENV)).toBe('fixture-newer-producer')
    }
  )

  it('verifies already absent observed files without claiming a deletion', async () => {
    const store = new TokenStore()
    await store.setSafeStorageSessionToken('fixture-old-user', ENV)
    const snapshot = await store.snapshotSessionTokenFallbackFiles(ENV)
    await store.clearSessionToken(ENV)
    await expect(store.retireSessionTokenFallbackFilesIfUnchanged(snapshot)).resolves.toBe(true)
    expect(await fs.readdir(fixture.directory)).toEqual([])
  })

  it('does not retire any unobserved file when snapshot ownership is rejected', async () => {
    const store = await produceSixFiles()
    const before = (await fs.readdir(fixture.directory)).sort()
    await expect(
      store.snapshotSessionTokenFallbackFiles(ENV, {
        legacyEnvKeys: [LEGACY_ENV],
        mayWrite: () => false,
      })
    ).rejects.toBeInstanceOf(SessionTokenStorageSupersededBeforeWriteError)
    expect((await fs.readdir(fixture.directory)).sort()).toEqual(before)
  })

  it('preserves exact observed files when retirement ownership is rejected', async () => {
    const store = await produceSixFiles()
    const snapshot = await store.snapshotSessionTokenFallbackFiles(ENV, {
      legacyEnvKeys: [LEGACY_ENV],
    })
    await expect(
      store.retireSessionTokenFallbackFilesIfUnchanged(snapshot, {
        mayWrite: () => false,
      })
    ).rejects.toBeInstanceOf(SessionTokenStorageSupersededBeforeWriteError)
    expect((await fs.readdir(fixture.directory)).length).toBe(6)
  })

  it('does not report unreadable actual files as absent', async () => {
    const store = new TokenStore()
    await store.setSafeStorageSessionToken('fixture-old-user', ENV)
    const open = fsSync.openSync.bind(fsSync)
    const inspection = vi.spyOn(fsSync, 'openSync').mockImplementation((file, flags, mode) => {
      if (String(file) === encrypted())
        throw Object.assign(new Error('fixture-unreadable'), { code: 'EMFILE' })
      return open(file, flags, mode)
    })
    try {
      await expect(store.snapshotSessionTokenFallbackFiles(ENV)).rejects.toMatchObject({
        code: 'EMFILE',
      })
      await expect(store.getSafeStorageSessionToken(ENV)).rejects.toMatchObject({ code: 'EMFILE' })
    } finally {
      inspection.mockRestore()
    }
    expect(await store.getSafeStorageSessionToken(ENV)).toBe('fixture-old-user')
  })

  it.each(['snapshot', 'retirement'] as const)(
    'rejects symlink traversal during %s',
    async phase => {
      const store = new TokenStore()
      await store.setSafeStorageSessionToken('fixture-original', ENV)
      await store.setSafeStorageSessionToken('fixture-target', OTHER_ENV)
      const snapshot = await store.snapshotSessionTokenFallbackFiles(ENV)
      await fs.unlink(encrypted())
      await fs.symlink(encrypted(OTHER_ENV), encrypted())
      await expect(
        phase === 'snapshot'
          ? store.snapshotSessionTokenFallbackFiles(ENV)
          : store.retireSessionTokenFallbackFilesIfUnchanged(snapshot)
      ).rejects.toThrow('regular file')
      expect(await store.getSafeStorageSessionToken(OTHER_ENV)).toBe('fixture-target')
      expect((await fs.lstat(encrypted())).isSymbolicLink()).toBe(true)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'rejects an actual nonregular FIFO without blocking',
    async () => {
      execFileSync('mkfifo', [encrypted()])
      await expect(new TokenStore().snapshotSessionTokenFallbackFiles(ENV)).rejects.toThrow(
        'regular file'
      )
      expect((await fs.lstat(encrypted())).isFIFO()).toBe(true)
    }
  )

  it('does not report failed unlink as verified retirement', async () => {
    const store = new TokenStore()
    await store.setSafeStorageSessionToken('fixture-old-user', ENV)
    const snapshot = await store.snapshotSessionTokenFallbackFiles(ENV)
    const unlink = fsSync.unlinkSync.bind(fsSync)
    vi.spyOn(fsSync, 'unlinkSync').mockImplementation(file => {
      if (String(file) === encrypted()) throw new Error('fixture-unlink rejected')
      return unlink(file)
    })
    await expect(store.retireSessionTokenFallbackFilesIfUnchanged(snapshot)).rejects.toThrow(
      'fixture-unlink rejected'
    )
    expect(await store.getSafeStorageSessionToken(ENV)).toBe('fixture-old-user')
  })

  it('does not report post-unlink directory sync failure as verified retirement', async () => {
    const store = new TokenStore()
    await store.setSafeStorageSessionToken('fixture-old-user', ENV)
    const snapshot = await store.snapshotSessionTokenFallbackFiles(ENV)
    const open = fs.open.bind(fs)
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args)
      if (String(args[0]) === fixture.directory && args[1] === 'r') {
        vi.spyOn(handle, 'sync').mockRejectedValueOnce(new Error('fixture-directory sync rejected'))
      }
      return handle
    })
    await expect(store.retireSessionTokenFallbackFilesIfUnchanged(snapshot)).rejects.toThrow(
      'fixture-directory sync rejected'
    )
    expect(await store.getSafeStorageSessionToken(ENV)).toBeNull()
  })

  it('rejects forged receipts before targeting any file', async () => {
    const store = await produceSixFiles()
    await expect(store.retireSessionTokenFallbackFilesIfUnchanged({} as never)).rejects.toThrow(
      'snapshot'
    )
    expect((await fs.readdir(fixture.directory)).length).toBe(6)
  })

  it('guards native alias cleanup at actual dispatch without deleting the active source', async () => {
    const store = new TokenStore()
    await store.setSessionToken('fixture-active', ENV, { requireKeytar: true })
    await store.setSessionToken('fixture-legacy', LEGACY_ENV, { requireKeytar: true })
    await expect(
      store.clearKeytarSessionTokensStrictly(ENV, {
        legacyEnvKeys: [LEGACY_ENV],
        preserveActiveEnvKey: true,
        mayWrite: () => false,
      })
    ).rejects.toBeInstanceOf(SessionTokenStorageSupersededBeforeWriteError)
    expect(await store.getKeytarSessionToken(ENV)).toBe('fixture-active')
    expect(await store.getKeytarSessionToken(LEGACY_ENV)).toBe('fixture-legacy')
  })
})
