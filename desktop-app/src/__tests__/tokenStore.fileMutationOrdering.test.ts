import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const runtime = vi.hoisted(() => ({ directory: '' }))
vi.mock('keytar', () => ({}))
vi.mock('electron', () => ({
  app: { getPath: () => runtime.directory, isReady: () => true },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (token: string) => Buffer.from(`encrypted:${token}`),
    decryptString: (data: Buffer) => data.toString().replace(/^encrypted:/, ''),
  },
}))

const envKey = 'fixture-111111111111'
const otherEnvKey = 'fixture-222222222222'
beforeEach(async () => {
  runtime.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-token-file-order-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(runtime.directory, { recursive: true, force: true })
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

describe('credential file mutation lanes', () => {
  it('does not let an older scoped cleanup unlink a newer accepted credential write', async () => {
    const { TokenStore } = await import('../tokenStore.js')
    const store = new TokenStore()
    await store.setSafeStorageSessionToken('fixture-before-cleanup', envKey)
    const file = path.join(runtime.directory, `session-token-${envKey}.enc`)
    const nativeUnlink = fs.unlink.bind(fs)
    const entered = deferred()
    const release = deferred()
    vi.spyOn(fs, 'unlink').mockImplementation(async target => {
      if (String(target) === file) {
        entered.resolve()
        await release.promise
      }
      return nativeUnlink(target)
    })
    const cleaning = store.clearSessionTokenStrictly(envKey)
    await entered.promise
    const replacing = store.setSafeStorageSessionToken('fixture-after-cleanup', envKey)
    // In the broken path the accepted write completes before the held unlink.
    // In the file lane it remains queued until cleanup finishes.
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        replacing,
        new Promise(resolve => {
          deadline = setTimeout(resolve, 1000)
        }),
      ])
    } finally {
      if (deadline) clearTimeout(deadline)
      release.resolve()
      await Promise.all([cleaning, replacing])
    }
    expect(await store.getSafeStorageSessionToken(envKey)).toBe('fixture-after-cleanup')
  })

  it('cannot unlink a newer accepted atomic write completing in the filesystem worker', async () => {
    const { TokenStore } = await import('../tokenStore.js')
    const store = new TokenStore()
    await store.setSafeStorageSessionToken('fixture-rejected', envKey)
    const file = path.join(runtime.directory, `session-token-${envKey}.enc`)
    const nativeRename = fs.rename.bind(fs)
    const entered = deferred()
    const release = deferred()
    let released = false
    let dispatched: Promise<void> | undefined
    let nativeDispatch: (() => void) | undefined
    const dispatch = () => {
      if (!released) nativeDispatch?.()
      released = true
      release.resolve()
    }
    vi.spyOn(fs, 'rename').mockImplementationOnce(async (source, destination) => {
      nativeDispatch = () => {
        dispatched = nativeRename(source, destination)
      }
      entered.resolve()
      await release.promise
      await dispatched
    })
    const replacement = store.setSafeStorageSessionToken('fixture-new-producer', envKey)
    await entered.promise
    const read = fsSync.readFileSync.bind(fsSync)
    vi.spyOn(fsSync, 'readFileSync').mockImplementation(
      (...args: Parameters<typeof fsSync.readFileSync>) => {
        const contents = read(...args)
        if (!released && typeof args[0] === 'number') {
          // On the nonserialized mutant, the compared file is read while the
          // accepted replacement owns its rename. Let its real filesystem work
          // finish before unlink, without letting JS promise continuations run.
          dispatch()
          const deadline = Date.now() + 1000
          const sleeper = new Int32Array(new SharedArrayBuffer(4))
          while (Date.now() < deadline) {
            if (read(file).toString() === 'encrypted:fixture-new-producer') break
            Atomics.wait(sleeper, 0, 0, 1)
          }
        }
        return contents
      }
    )
    // With the lane, discard cannot enter its compare until the writer settles.
    const timer = setTimeout(dispatch, 30)
    let discarded: boolean
    try {
      discarded = await store.discardSafeStorageSessionTokenIfMatches('fixture-rejected', envKey)
      await replacement
    } finally {
      clearTimeout(timer)
      dispatch()
      await replacement
      await dispatched
    }
    expect(await store.getSafeStorageSessionToken(envKey)).toBe('fixture-new-producer')
    expect(discarded).toBe(false)
  })

  it('releases an errored file lane and keeps another environment independent', async () => {
    const { TokenStore } = await import('../tokenStore.js')
    const store = new TokenStore()
    const nativeRename = fs.rename.bind(fs)
    const entered = deferred()
    const release = deferred()
    vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      if (String(destination).endsWith(`session-token-${envKey}.enc`)) {
        entered.resolve()
        await release.promise
        throw new Error('fixture-first lane rename failed')
      }
      return nativeRename(source, destination)
    })
    const failed = store.setSafeStorageSessionToken('fixture-failed', envKey)
    const rejected = expect(failed).rejects.toThrow('fixture-first lane rename failed')
    await entered.promise
    await store.setSafeStorageSessionToken('fixture-independent', otherEnvKey)
    expect(await store.getSafeStorageSessionToken(otherEnvKey)).toBe('fixture-independent')
    release.resolve()
    await rejected
    vi.mocked(fs.rename).mockImplementation(nativeRename)
    await store.setSafeStorageSessionToken('fixture-next', envKey)
    expect(await store.getSafeStorageSessionToken(envKey)).toBe('fixture-next')
  })
})
