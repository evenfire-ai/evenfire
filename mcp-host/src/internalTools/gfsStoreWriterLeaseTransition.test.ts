import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GfsDownloadStore } from './gfsDownloadStore'
import { GfsStoreWriterLease } from './gfsStoreWriterLease'

/**
 * A same-process writer that is still acquiring, or already releasing, is a
 * transition that ends by itself: the next attempt re-judges the store from
 * scratch. Only a held writer whose fence or inodes changed is permanent.
 * `acquire()` reads the in-process owner synchronously, so starting it right
 * after another lease's `acquire()`/`release()` lands inside that transition.
 */
const roots: string[] = []
const leases: GfsStoreWriterLease[] = []

async function v2StoreRoot(): Promise<string> {
  const value = await fs.mkdtemp(join(tmpdir(), 'gfs-lease-transition-'))
  roots.push(value)
  const store = new GfsDownloadStore(value)
  await store.initialize()
  await store.close()
  return join(await fs.realpath(value), '.gfs-download-store')
}

function lease(storeRoot: string): GfsStoreWriterLease {
  const value = new GfsStoreWriterLease(storeRoot, false)
  leases.push(value)
  return value
}

afterEach(async () => {
  for (const value of leases.splice(0)) await value.release()
  for (const value of roots.splice(0)) await fs.rm(value, { recursive: true, force: true })
})

describe('GFS writer lease during a same-process ownership transition', () => {
  it('reports a writer that is releasing as transient contention', async () => {
    const storeRoot = await v2StoreRoot()
    const first = lease(storeRoot)
    await first.acquire()
    first.assertHeld()

    const releasing = first.release()
    await expect(lease(storeRoot).acquire()).rejects.toMatchObject({
      reason: 'writer_locked',
      transientWriterContention: true,
    })
    await releasing

    // Witness: the transition really ended and the next attempt owns the store.
    const next = lease(storeRoot)
    await next.acquire()
    next.assertHeld()
  })

  it('reports a writer that starts releasing during the contention check as transient', async () => {
    const storeRoot = await v2StoreRoot()
    const first = lease(storeRoot)
    await first.acquire()

    const attempt = lease(storeRoot).acquire()
    const releasing = first.release()
    await expect(attempt).rejects.toMatchObject({
      reason: 'writer_locked',
      transientWriterContention: true,
    })
    await releasing
    expect(() => first.assertHeld()).toThrow('Writer ownership lost')

    const next = lease(storeRoot)
    await next.acquire()
    next.assertHeld()
  })

  it('reports a writer that is still acquiring as transient contention', async () => {
    const storeRoot = await v2StoreRoot()
    const first = lease(storeRoot)

    const acquiring = first.acquire()
    await expect(lease(storeRoot).acquire()).rejects.toMatchObject({
      reason: 'writer_locked',
      transientWriterContention: true,
    })
    await acquiring
    // Witness: the in-flight acquisition completed and holds the lock.
    first.assertHeld()
  })

  it('keeps a held writer whose fence changed as permanent recovery state', async () => {
    const storeRoot = await v2StoreRoot()
    const first = lease(storeRoot)
    await first.acquire()
    // Witness: before the change the same contention is transient.
    await expect(lease(storeRoot).acquire()).rejects.toMatchObject({
      transientWriterContention: true,
    })

    await fs.writeFile(join(storeRoot, 'writer.lock'), '{bad')
    await expect(lease(storeRoot).acquire()).rejects.toMatchObject({
      reason: 'writer_locked',
      transientWriterContention: false,
    })
  })
})
