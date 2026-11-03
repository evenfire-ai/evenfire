import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { TokenStore } from '../tokenStore.js'

const fixture = vi.hoisted(() => ({
  directory: '',
  encryptionAvailable: true,
  keychain: new Map<string, string>(),
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
  getPassword: vi.fn(async (_service, account) => fixture.keychain.get(account) ?? null),
  setPassword: vi.fn(async (_service, account, token) => {
    fixture.keychain.set(account, token)
  }),
  deletePassword: vi.fn(async (_service, account) => fixture.keychain.delete(account)),
}))
vi.mock('../windowsSessionAuthorityAcl.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../windowsSessionAuthorityAcl.js')>()
  const { createWindowsSessionAuthorityAclUnitFixture } =
    await import('../../testSupport/windowsSessionAuthorityAclUnitFixture.js')
  return createWindowsSessionAuthorityAclUnitFixture(actual)
})
vi.mock('../windowsSessionAuthorityFileOps.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../windowsSessionAuthorityFileOps.js')>()
  const { createWindowsSessionAuthorityFileOpsUnitFixture } =
    await import('../../testSupport/windowsSessionAuthorityFileOpsUnitFixture.js')
  return createWindowsSessionAuthorityFileOpsUnitFixture(actual)
})
const ENV = 'active-111111111111'
const LEGACY_ENV = 'legacy-222222222222'
const GLOBAL_PRODUCER_ENV = 'global-333333333333'
const encrypted = (env = ENV) => path.join(fixture.directory, `session-token-${env}.enc`)
const plaintext = (env = ENV) => path.join(fixture.directory, `session-token-${env}.json`)
beforeEach(async () => {
  fixture.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-fallback-retirement-'))
  fixture.encryptionAvailable = true
  fixture.keychain.clear()
  vi.clearAllMocks()
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(fixture.directory, { recursive: true, force: true })
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
async function boundaryReached(boundary: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    expect(
      await Promise.race([
        boundary.then(() => true),
        new Promise<boolean>(done => {
          timer = setTimeout(() => done(false), 2000)
        }),
      ]),
      'actual later-path retirement must enter its directory sync'
    ).toBe(true)
  } finally {
    clearTimeout(timer)
  }
}

describe('R21-M8 whole fallback-retirement contract regressions', () => {
  it('does not claim whole-snapshot completion after an earlier retired file is recreated', async () => {
    const store = await produceSixFiles()
    const snapshot = await store.snapshotSessionTokenFallbackFiles(ENV, {
      legacyEnvKeys: [LEGACY_ENV],
    })
    const entered = deferred()
    const release = deferred()
    const syncOpen = fsSync.openSync.bind(fsSync)
    const open = fs.open.bind(fs)
    let inspectedLaterPath = false
    let held = false
    vi.spyOn(fsSync, 'openSync').mockImplementation((file, flags, mode) => {
      if (String(file) === plaintext()) inspectedLaterPath = true
      return syncOpen(file, flags, mode)
    })
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      if (!held && inspectedLaterPath && String(args[0]) === fixture.directory && args[1] === 'r') {
        held = true
        entered.resolve()
        await release.promise
      }
      return open(...args)
    })
    const retiring = store.retireSessionTokenFallbackFilesIfUnchanged(snapshot)
    let writing: Promise<void> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let publishedWhileHeld = false
    let completed: boolean | undefined
    try {
      await boundaryReached(entered.promise)
      writing = new TokenStore().setSafeStorageSessionToken('fixture-independent-new', ENV)
      publishedWhileHeld = await Promise.race([
        writing.then(() => true),
        new Promise<boolean>(done => {
          timer = setTimeout(() => done(false), 100)
        }),
      ])
    } finally {
      clearTimeout(timer)
      release.resolve()
      completed = await retiring
      if (writing) await writing
    }
    expect(
      completed && publishedWhileHeld,
      'true cannot acknowledge cleanup after an actual newer publication already completed'
    ).toBe(false)
    expect(await new TokenStore().getSafeStorageSessionToken(ENV)).toBe('fixture-independent-new')
  })

  it.skipIf(process.platform === 'win32')(
    'requires a durable directory sync on retry after a prior unlink succeeded',
    async () => {
      const store = new TokenStore()
      await store.setSafeStorageSessionToken('fixture-old-user', ENV)
      const snapshot = await store.snapshotSessionTokenFallbackFiles(ENV)
      const open = fs.open.bind(fs)
      let rejectedSyncs = 0
      vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
        const handle = await open(...args)
        if (String(args[0]) === fixture.directory && args[1] === 'r' && rejectedSyncs < 2) {
          vi.spyOn(handle, 'sync').mockImplementationOnce(async () => {
            rejectedSyncs += 1
            throw new Error('fixture-directory retirement sync failed')
          })
        }
        return handle
      })
      await expect(store.retireSessionTokenFallbackFilesIfUnchanged(snapshot)).rejects.toThrow(
        'retirement sync failed'
      )
      expect(await store.getSafeStorageSessionToken(ENV)).toBeNull()
      await expect(store.retireSessionTokenFallbackFilesIfUnchanged(snapshot)).rejects.toThrow(
        'retirement sync failed'
      )
      expect(rejectedSyncs).toBe(2)
      await expect(store.retireSessionTokenFallbackFilesIfUnchanged(snapshot)).resolves.toBe(true)
    }
  )
})
