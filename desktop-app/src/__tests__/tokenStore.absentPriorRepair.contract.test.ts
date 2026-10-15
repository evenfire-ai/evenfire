import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SessionPersistenceProducer } from '../sessionPersistenceJournal.js'
import {
  SessionTokenStorageSupersededBeforeWriteError,
  SessionTokenStorageUnavailableBeforeWriteError,
  TokenStore,
  isSessionTokenMutationCallbackFailure,
} from '../tokenStore.js'

const fixture = vi.hoisted(() => ({ directory: '', encryptionAvailable: true }))
vi.mock('electron', () => ({
  app: { isReady: () => true, getPath: () => fixture.directory },
  safeStorage: {
    isEncryptionAvailable: () => fixture.encryptionAvailable,
    encryptString: (token: string) => Buffer.from(`encrypted:${token}`),
    decryptString: (bytes: Buffer) => bytes.toString().slice('encrypted:'.length),
  },
}))
const ENV = 'repair-111111111111'
const HOME = 'fixture-accepted-home'
const REJECTED = 'fixture-rejected-replacement'
const encrypted = () => path.join(fixture.directory, `session-token-${ENV}.enc`)
const plaintext = () => path.join(fixture.directory, `session-token-${ENV}.json`)

beforeEach(async () => {
  fixture.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-absent-prior-repair-'))
  fixture.encryptionAvailable = true
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(fixture.directory, { recursive: true, force: true })
})

function guardedPrior() {
  const owner = new SessionPersistenceProducer(
    fixture.directory,
    ENV,
    null,
    () => {},
    () => {},
    true,
    HOME
  )
  owner.prepare('keytar', REJECTED)
  return vi.fn((source: 'keytar' | 'safe-storage' | 'isolated-plaintext', token: string) =>
    owner.preparePriorRepair(source, REJECTED, token)
  )
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(complete => {
    resolve = complete
  })
  return { promise, resolve }
}
async function entered(boundary: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    expect(
      await Promise.race([
        boundary.then(() => true),
        new Promise<boolean>(complete => {
          timer = setTimeout(() => complete(false), 2000)
        }),
      ]),
      'real accepted storage actor must reach its boundary'
    ).toBe(true)
  } finally {
    clearTimeout(timer)
  }
}

describe('conditional absent-file prior encrypted repair', () => {
  it('creates and verifies encrypted Home only after its real prior journal guard', async () => {
    const store = new TokenStore()
    const guard = guardedPrior()
    const rename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => {
      if (String(target) === encrypted()) expect(guard).toHaveBeenCalledWith('safe-storage', HOME)
      return rename(source, target)
    })
    await expect(
      store.repairSafeStorageSessionTokenIfMatches(REJECTED, HOME, ENV, {
        createIfAbsent: true,
        mayWrite: () => true,
        onMutationDispatched: guard,
      })
    ).resolves.toBe(true)
    await expect(store.getSafeStorageSessionToken(ENV)).resolves.toBe(HOME)
    expect(fsSync.existsSync(plaintext())).toBe(false)
    expect(guard).toHaveBeenCalledTimes(1)
  })

  it('keeps the default absent-file result unchanged without requiring secure storage', async () => {
    fixture.encryptionAvailable = false
    const guard = guardedPrior()
    await expect(
      new TokenStore().repairSafeStorageSessionTokenIfMatches(REJECTED, HOME, ENV, {
        onMutationDispatched: guard,
      })
    ).resolves.toBe(false)
    expect(guard).not.toHaveBeenCalled()
    expect(fsSync.existsSync(encrypted())).toBe(false)
  })

  it('does not turn nullable cleanup into a new credential even when creation was requested', async () => {
    fixture.encryptionAvailable = false
    const guard = guardedPrior()
    await expect(
      new TokenStore().repairSafeStorageSessionTokenIfMatches(REJECTED, null, ENV, {
        createIfAbsent: true,
        onMutationDispatched: guard,
      })
    ).resolves.toBe(false)
    expect(guard).not.toHaveBeenCalled()
    expect(fsSync.existsSync(encrypted())).toBe(false)
  })

  it('requires encrypted secure storage before conditional Home publication', async () => {
    fixture.encryptionAvailable = false
    const guard = guardedPrior()
    await expect(
      new TokenStore().repairSafeStorageSessionTokenIfMatches(REJECTED, HOME, ENV, {
        createIfAbsent: true,
        onMutationDispatched: guard,
      })
    ).rejects.toBeInstanceOf(SessionTokenStorageUnavailableBeforeWriteError)
    expect(guard).not.toHaveBeenCalled()
    expect(fsSync.existsSync(encrypted())).toBe(false)
    expect(fsSync.existsSync(plaintext())).toBe(false)
  })

  it('preserves the newer actual writer that finishes before queued absence inspection', async () => {
    const started = deferred()
    const release = deferred()
    const rename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementationOnce(async (source, target) => {
      started.resolve()
      await release.promise
      return rename(source, target)
    })
    const writer = new TokenStore().setSafeStorageSessionToken('fixture-newer-owner', ENV)
    const guard = guardedPrior()
    let repair: Promise<boolean> | undefined
    try {
      await entered(started.promise)
      repair = new TokenStore().repairSafeStorageSessionTokenIfMatches(REJECTED, HOME, ENV, {
        createIfAbsent: true,
        mayWrite: () => true,
        onMutationDispatched: guard,
      })
    } finally {
      release.resolve()
      await writer
    }
    await expect(repair).resolves.toBe(false)
    expect(guard).not.toHaveBeenCalled()
    await expect(new TokenStore().getSafeStorageSessionToken(ENV)).resolves.toBe(
      'fixture-newer-owner'
    )
  })

  it('cannot create Home after its source ownership guard rejects', async () => {
    const guard = guardedPrior()
    await expect(
      new TokenStore().repairSafeStorageSessionTokenIfMatches(REJECTED, HOME, ENV, {
        createIfAbsent: true,
        mayWrite: () => false,
        onMutationDispatched: guard,
      })
    ).rejects.toBeInstanceOf(SessionTokenStorageSupersededBeforeWriteError)
    expect(guard).not.toHaveBeenCalled()
    expect(fsSync.existsSync(encrypted())).toBe(false)
  })

  it('propagates durable prior-journal admission failure before file publication', async () => {
    const failure = new Error('fixture-journal-prepare-failed')
    const guard = vi.fn(() => {
      throw failure
    })
    await expect(
      new TokenStore().repairSafeStorageSessionTokenIfMatches(REJECTED, HOME, ENV, {
        createIfAbsent: true,
        mayWrite: () => true,
        onMutationDispatched: guard,
      })
    ).rejects.toBe(failure)
    expect(isSessionTokenMutationCallbackFailure(failure)).toBe(true)
    expect(fsSync.existsSync(encrypted())).toBe(false)
    expect(fsSync.existsSync(plaintext())).toBe(false)
  })

  it('rejects symlink or nonregular paths instead of treating them as absent', async () => {
    const guard = guardedPrior()
    await fs.symlink(path.join(fixture.directory, 'missing-target'), encrypted())
    await expect(
      new TokenStore().repairSafeStorageSessionTokenIfMatches(REJECTED, HOME, ENV, {
        createIfAbsent: true,
        onMutationDispatched: guard,
      })
    ).rejects.toBeInstanceOf(Error)
    expect((await fs.lstat(encrypted())).isSymbolicLink()).toBe(true)
    expect(guard).not.toHaveBeenCalled()
    await fs.unlink(encrypted())
    await fs.mkdir(encrypted())
    await expect(
      new TokenStore().repairSafeStorageSessionTokenIfMatches(REJECTED, HOME, ENV, {
        createIfAbsent: true,
        onMutationDispatched: guard,
      })
    ).rejects.toBeInstanceOf(Error)
    expect((await fs.lstat(encrypted())).isDirectory()).toBe(true)
    expect(guard).not.toHaveBeenCalled()
  })

  it('drains an accepted conditional creation held at its actual encrypted rename', async () => {
    const started = deferred()
    const release = deferred()
    const rename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementationOnce(async (source, target) => {
      started.resolve()
      await release.promise
      return rename(source, target)
    })
    const store = new TokenStore()
    const writing = store.repairSafeStorageSessionTokenIfMatches(REJECTED, HOME, ENV, {
      createIfAbsent: true,
      mayWrite: () => true,
      onMutationDispatched: guardedPrior(),
    })
    let drained = false
    let draining: Promise<void> | undefined
    try {
      await entered(started.promise)
      draining = store.prepareForQuit().then(() => {
        drained = true
      })
      await new Promise<void>(complete => setImmediate(complete))
      expect(drained).toBe(false)
    } finally {
      release.resolve()
      await Promise.allSettled([writing, draining])
    }
    await expect(writing).resolves.toBe(true)
    expect(drained).toBe(true)
    await expect(new TokenStore().getSafeStorageSessionToken(ENV)).resolves.toBe(HOME)
  })

  it('rejects conditional creation after admission closes, without invoking the journal guard', async () => {
    const store = new TokenStore()
    const guard = guardedPrior()
    await store.prepareForQuit()
    await expect(
      store.repairSafeStorageSessionTokenIfMatches(REJECTED, HOME, ENV, {
        createIfAbsent: true,
        mayWrite: () => true,
        onMutationDispatched: guard,
      })
    ).rejects.toThrow('Application is shutting down')
    expect(guard).not.toHaveBeenCalled()
    expect(fsSync.existsSync(encrypted())).toBe(false)
  })
})
