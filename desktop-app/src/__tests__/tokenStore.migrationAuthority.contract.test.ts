import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  type SessionTokenReadAuthority,
  SessionTokenStorageSupersededBeforeWriteError,
  TokenStore,
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

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}
async function reached(promise: Promise<void>, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    expect(
      await Promise.race([
        promise.then(() => true),
        new Promise<boolean>(done => {
          timer = setTimeout(() => done(false), 2000)
        }),
      ]),
      label
    ).toBe(true)
  } finally {
    clearTimeout(timer)
  }
}

describe('original legacy source and destination handoff', () => {
  it('does not let an older legacy lookup overwrite a newer accepted active credential', async () => {
    const store = new TokenStore()
    await store.setSessionToken('fixture-old-legacy-home', LEGACY_ENV, { requireKeytar: true })
    const keytar = await import('keytar')
    const started = deferred()
    const release = deferred()
    let held = false
    vi.mocked(keytar.getPassword).mockImplementation(async (_service, account) => {
      if (!held && account === `session-token::${LEGACY_ENV}`) {
        held = true
        started.resolve()
        await release.promise
      }
      return fixture.keychain.get(account) ?? null
    })
    const migration = store.getSessionToken(ENV, { legacyEnvKeys: [LEGACY_ENV] })
    const outcome = migration.then(
      value => ({ value }),
      error => ({ error })
    )
    try {
      await reached(started.promise, 'real older legacy getter admitted after active absence')
      await new TokenStore().setSessionToken('fixture-newer-accepted-active', ENV, {
        requireKeytar: true,
      })
    } finally {
      release.resolve()
      await outcome
    }
    await expect(store.getKeytarSessionToken(ENV)).resolves.toBe('fixture-newer-accepted-active')
    await expect(store.getKeytarSessionToken(LEGACY_ENV)).resolves.toBe('fixture-old-legacy-home')
    expect(await outcome).toEqual({
      error: expect.any(SessionTokenStorageSupersededBeforeWriteError),
    })
  })

  it('does not adopt a newer same-value legacy publication after its own cleanup awaits', async () => {
    const store = new TokenStore()
    await store.setSessionToken('fixture-rejected', LEGACY_ENV, { requireKeytar: true })
    const keytar = await import('keytar')
    const deleting = deferred()
    const releaseDelete = deferred()
    const verifying = deferred()
    const releaseVerification = deferred()
    let heldDelete = false
    let activeReads = 0
    vi.mocked(keytar.deletePassword).mockImplementation(async (_service, account) => {
      if (!heldDelete && account === `session-token::${LEGACY_ENV}`) {
        heldDelete = true
        deleting.resolve()
        await releaseDelete.promise
      }
      return fixture.keychain.delete(account)
    })
    vi.mocked(keytar.getPassword).mockImplementation(async (_service, account) => {
      if (account === `session-token::${ENV}` && ++activeReads === 2) {
        verifying.resolve()
        await releaseVerification.promise
      }
      return fixture.keychain.get(account) ?? null
    })
    let authority: SessionTokenReadAuthority | undefined
    const migration = store.getSessionToken(ENV, {
      legacyEnvKeys: [LEGACY_ENV],
      onTokenRead: (_source, observed) => {
        authority = observed
      },
    })
    let newer: Promise<void> | undefined
    try {
      await reached(deleting.promise, 'real migration legacy deletion')
      newer = new TokenStore().setSessionToken('fixture-rejected', LEGACY_ENV, {
        requireKeytar: true,
      })
      releaseDelete.resolve()
      await reached(verifying.promise, 'actual destination verification before receipt return')
      await newer
    } finally {
      releaseDelete.resolve()
      releaseVerification.resolve()
      await Promise.allSettled([migration, newer])
    }
    await expect(migration).resolves.toBe('fixture-rejected')
    expect(authority).toBeDefined()
    expect(isSessionTokenReadAuthorityCurrent(authority, 'keytar', ENV)).toBe(true)
    const cleanup = await store.clearKeytarSessionTokensStrictly(ENV, {
      legacyEnvKeys: [LEGACY_ENV],
      onlyIfMatches: 'fixture-rejected',
      readAuthority: authority,
    })
    await expect(store.getKeytarSessionToken(LEGACY_ENV)).resolves.toBe('fixture-rejected')
    expect(cleanup.sourceAuthorityVerified).toBe(false)
    await expect(store.getKeytarSessionToken(ENV)).resolves.toBeNull()
  })
})
