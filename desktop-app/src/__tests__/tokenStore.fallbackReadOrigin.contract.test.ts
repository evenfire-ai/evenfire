import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { TokenStore, isSessionTokenFallbackReadFailure } from '../tokenStore.js'

const fixture = vi.hoisted(() => ({
  directory: '',
  decryptionError: undefined as Error | undefined,
}))
vi.mock('electron', () => ({
  app: { isReady: () => true, getPath: () => fixture.directory },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (token: string) => Buffer.from(`encrypted:${token}`),
    decryptString: (bytes: Buffer) => {
      if (fixture.decryptionError) throw fixture.decryptionError
      return bytes.toString().slice('encrypted:'.length)
    },
  },
}))
const ENV = 'origin-111111111111'
const TOKEN = 'fixture-existing-encrypted'
const encrypted = () => path.join(fixture.directory, `session-token-${ENV}.enc`)

beforeEach(async () => {
  fixture.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-fallback-read-origin-'))
  fixture.decryptionError = undefined
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(fixture.directory, { recursive: true, force: true })
})

async function caught(operation: Promise<unknown>): Promise<unknown> {
  return operation.then(
    () => undefined,
    error => error
  )
}

describe('fallback regular-file read origin', () => {
  it('brands a genuine open EMFILE instead of confusing it with absent storage', async () => {
    const store = new TokenStore()
    await store.setSafeStorageSessionToken(TOKEN, ENV)
    const failure = Object.assign(new Error('fixture-open-read'), { code: 'EMFILE' })
    const open = fsSync.openSync.bind(fsSync)
    vi.spyOn(fsSync, 'openSync').mockImplementation(
      (...args: Parameters<typeof fsSync.openSync>) => {
        if (String(args[0]) === encrypted()) throw failure
        return open(...args)
      }
    )
    const observed = await caught(store.snapshotSessionTokenFallbackFiles(ENV))
    expect(observed).toBe(failure)
    expect(isSessionTokenFallbackReadFailure(observed)).toBe(true)
  })

  it('brands a genuine descriptor read error and closes its accepted file descriptor', async () => {
    const store = new TokenStore()
    await store.setSafeStorageSessionToken(TOKEN, ENV)
    const failure = Object.assign(new Error('fixture-descriptor-read'), { code: 'EMFILE' })
    const read = fsSync.readFileSync.bind(fsSync)
    const close = vi.spyOn(fsSync, 'closeSync')
    vi.spyOn(fsSync, 'readFileSync').mockImplementation(
      (...args: Parameters<typeof fsSync.readFileSync>) => {
        if (typeof args[0] === 'number') throw failure
        return read(...args)
      }
    )
    const observed = await caught(store.snapshotSessionTokenFallbackFiles(ENV))
    expect(observed).toBe(failure)
    expect(isSessionTokenFallbackReadFailure(observed)).toBe(true)
    expect(close).toHaveBeenCalled()
  })

  it('brands close EINTR after a successful read without retrying the descriptor', async () => {
    const store = new TokenStore()
    await store.setSafeStorageSessionToken(TOKEN, ENV)
    const failure = Object.assign(new Error('fixture-close-read'), { code: 'EINTR' })
    const close = fsSync.closeSync.bind(fsSync)
    const probe = vi.spyOn(fsSync, 'closeSync').mockImplementation(fd => {
      close(fd)
      throw failure
    })
    const observed = await caught(store.snapshotSessionTokenFallbackFiles(ENV))
    expect(observed).toBe(failure)
    expect(isSessionTokenFallbackReadFailure(observed)).toBe(true)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('does not let close EINTR hide confirmed nonregular-file evidence', async () => {
    await fs.mkdir(encrypted())
    const close = fsSync.closeSync.bind(fsSync)
    vi.spyOn(fsSync, 'closeSync').mockImplementation(fd => {
      close(fd)
      throw Object.assign(new Error('fixture-secondary-close'), { code: 'EINTR' })
    })
    const observed = await caught(new TokenStore().snapshotSessionTokenFallbackFiles(ENV))
    expect(observed).toBeInstanceOf(Error)
    expect(
      (observed as NodeJS.ErrnoException).code === 'EISDIR' ||
        (observed as Error).message.includes('not a regular file')
    ).toBe(true)
    expect((observed as NodeJS.ErrnoException).code).not.toBe('EINTR')
    expect(isSessionTokenFallbackReadFailure(observed)).toBe(true)
  })

  it('does not brand a source ownership callback as a file read', async () => {
    const failure = Object.assign(new Error('fixture-owner-callback'), { code: 'EMFILE' })
    const observed = await caught(
      new TokenStore().snapshotSessionTokenFallbackFiles(ENV, {
        mayWrite: () => {
          throw failure
        },
      })
    )
    expect(observed).toBe(failure)
    expect(isSessionTokenFallbackReadFailure(observed)).toBe(false)
  })

  it('does not brand retirement fsync failure as a harmless read uncertainty', async () => {
    const store = new TokenStore()
    await store.setSafeStorageSessionToken(TOKEN, ENV)
    const snapshot = await store.snapshotSessionTokenFallbackFiles(ENV)
    const failure = Object.assign(new Error('fixture-retirement-mutation'), { code: 'EMFILE' })
    const open = fs.open.bind(fs)
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args)
      if (args[1] === 'r' && (await handle.stat()).isDirectory())
        vi.spyOn(handle, 'sync').mockRejectedValue(failure)
      return handle
    })
    const observed = await caught(store.retireSessionTokenFallbackFilesIfUnchanged(snapshot))
    expect(observed).toBe(failure)
    expect(isSessionTokenFallbackReadFailure(observed)).toBe(false)
  })

  it('does not brand decryption failure as a file read', async () => {
    const store = new TokenStore()
    await store.setSafeStorageSessionToken(TOKEN, ENV)
    const snapshot = await store.snapshotSessionTokenFallbackFiles(ENV)
    const failure = Object.assign(new Error('fixture-crypto-not-read'), { code: 'EMFILE' })
    fixture.decryptionError = failure
    const observed = await caught(
      store.retireSessionTokenFallbackFilesIfUnchanged(snapshot, {
        preserveActiveEncryptedToken: TOKEN,
      })
    )
    expect(observed).toBe(failure)
    expect(isSessionTokenFallbackReadFailure(observed)).toBe(false)
  })

  it('does not brand credential rename failure as a file read', async () => {
    const failure = Object.assign(new Error('fixture-rename-not-read'), { code: 'EMFILE' })
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(failure)
    const observed = await caught(new TokenStore().setSafeStorageSessionToken(TOKEN, ENV))
    expect(observed).toBe(failure)
    expect(isSessionTokenFallbackReadFailure(observed)).toBe(false)
  })
})
