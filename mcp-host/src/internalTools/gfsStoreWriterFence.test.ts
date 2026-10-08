import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { logger } from '../logger'
import { GfsDownloadStore } from './gfsDownloadStore'
import { GfsStoreWriterLease } from './gfsStoreWriterLease'

/**
 * #1028: a v2 writer fence recorded the database device, and a persistent disk
 * reattached under another device node changed it, which locked the store for
 * good. The fence is now judged by ownership and inode only. A v2 fence is
 * accepted in place and never rewritten; v3 (no device) is written only at
 * bootstrap. Live writers stay excluded by the SQLite exclusive lock.
 */
const OWNERSHIP = 'sqlite-exclusive-v1'
const V2_ACCEPTED = 'GFS writer fence v2 accepted with stale device'

let root: string
let stores: GfsDownloadStore[]
let leases: GfsStoreWriterLease[]
let connections: Database.Database[]

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'gfs-writer-fence-'))
  stores = []
  leases = []
  connections = []
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const connection of connections) if (connection.open) connection.close()
  for (const value of leases) await value.release()
  for (const store of stores) await store.close(0).catch(() => undefined)
  await fs.rm(root, { recursive: true, force: true })
})

function freshStore(): GfsDownloadStore {
  const store = new GfsDownloadStore(root)
  stores.push(store)
  return store
}

function lease(storeRoot: string): GfsStoreWriterLease {
  const value = new GfsStoreWriterLease(storeRoot, false)
  leases.push(value)
  return value
}

function connection(storeRoot: string): Database.Database {
  const value = new Database(path.join(storeRoot, 'writer-v2.sqlite'), {
    timeout: 0,
    fileMustExist: true,
  })
  connections.push(value)
  return value
}

/** A bootstrapped store whose only writer has closed. */
async function closedStoreRoot(): Promise<string> {
  const store = freshStore()
  await store.initialize()
  await store.close()
  return path.join(await fs.realpath(root), '.gfs-download-store')
}

async function databaseIdentity(storeRoot: string): Promise<{ dev: string; ino: string }> {
  const info = await fs.stat(path.join(storeRoot, 'writer-v2.sqlite'), { bigint: true })
  return { dev: String(info.dev), ino: String(info.ino) }
}

/** Byte-exact v2 fence as the c8f898209 writer serialized it. */
function v2Fence(device: string, inode: string): string {
  return JSON.stringify({
    schemaVersion: 2,
    ownership: OWNERSHIP,
    databaseDevice: device,
    databaseInode: inode,
  })
}

function markerPath(storeRoot: string): string {
  return path.join(storeRoot, 'writer.lock')
}

async function writeFence(storeRoot: string, bytes: string): Promise<void> {
  await fs.writeFile(markerPath(storeRoot), bytes, { mode: 0o600 })
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function acceptanceLogs(spy: { mock: { calls: unknown[][] } }): unknown[][] {
  return spy.mock.calls.filter(call => call[1] === V2_ACCEPTED)
}

describe('GFS writer fence across a persistent-disk reattach (#1028)', () => {
  it('T1: accepts a v2 fence whose device changed when its inode matches, keeps it byte-for-byte and logs both devices', async () => {
    const storeRoot = await closedStoreRoot()
    const { dev, ino } = await databaseIdentity(storeRoot)
    const staleDevice = String(BigInt(dev) + 1n)
    const v2 = v2Fence(staleDevice, ino)
    await writeFence(storeRoot, v2)
    const info = vi.spyOn(logger, 'info')

    const store = freshStore()
    await store.initialize()

    expect(store.isAvailable()).toBe(true)
    expect(await fs.readFile(markerPath(storeRoot), 'utf8')).toBe(v2)
    expect(acceptanceLogs(info)).toEqual([
      [
        { component: 'GfsDownloadStore', storedDevice: staleDevice, currentDevice: dev },
        V2_ACCEPTED,
      ],
    ])
    await store.close()
    expect(await fs.readFile(markerPath(storeRoot), 'utf8')).toBe(v2)
  })

  it('T2: refuses a v2 fence naming another database inode as permanent database_identity_changed', async () => {
    const storeRoot = await closedStoreRoot()
    const { dev, ino } = await databaseIdentity(storeRoot)
    const foreign = v2Fence(dev, String(BigInt(ino) + 1n))
    await writeFence(storeRoot, foreign)

    const store = freshStore()
    await expect(store.initialize()).rejects.toMatchObject({
      code: 'writer_locked',
      transientWriterContention: false,
      detail: 'database_identity_changed',
    })
    expect(store.isAvailable()).toBe(false)
    expect(await fs.readFile(markerPath(storeRoot), 'utf8')).toBe(foreign)

    // Witness: the same store with only the inode corrected is accepted, so the
    // refusal came from the inode and nothing else.
    await writeFence(storeRoot, v2Fence(dev, ino))
    await store.initialize()
    expect(store.isAvailable()).toBe(true)
  })

  it('T3: bootstrap writes the v3 fence, a v3 reopen acquires, and reacquisition leaves its hash unchanged', async () => {
    const store = freshStore()
    await store.initialize()
    const storeRoot = path.join(await fs.realpath(root), '.gfs-download-store')
    const { dev, ino } = await databaseIdentity(storeRoot)
    const v3 = JSON.stringify({ schemaVersion: 3, ownership: OWNERSHIP, databaseInode: ino })
    expect(await fs.readFile(markerPath(storeRoot), 'utf8')).toBe(v3)
    await store.close()
    const bootstrapHash = sha256(await fs.readFile(markerPath(storeRoot), 'utf8'))

    const info = vi.spyOn(logger, 'info')
    const reopened = freshStore()
    await reopened.initialize()
    expect(reopened.isAvailable()).toBe(true)
    expect(acceptanceLogs(info)).toEqual([])
    await reopened.close()

    const direct = lease(storeRoot)
    await direct.acquire()
    direct.assertHeld()
    expect(direct.lastAcquire).toEqual({ fenceSchema: 3, currentDevice: dev })
    await direct.release()
    expect(sha256(await fs.readFile(markerPath(storeRoot), 'utf8'))).toBe(bootstrapHash)
  })

  it('T4: a second real SQLite connection excludes the writer as verified transient contention while v2 stays on disk', async () => {
    const storeRoot = await closedStoreRoot()
    const { dev, ino } = await databaseIdentity(storeRoot)
    const staleDevice = String(BigInt(dev) + 1n)
    const v2 = v2Fence(staleDevice, ino)
    await writeFence(storeRoot, v2)

    const other = connection(storeRoot)
    other.pragma('journal_mode = DELETE')
    other.exec('BEGIN EXCLUSIVE')
    expect(other.inTransaction).toBe(true)
    await expect(lease(storeRoot).acquire()).rejects.toMatchObject({
      reason: 'writer_locked',
      transientWriterContention: true,
      detail: 'sqlite_busy_verified',
    })
    expect(await fs.readFile(markerPath(storeRoot), 'utf8')).toBe(v2)
    other.close()

    const held = lease(storeRoot)
    await held.acquire()
    held.assertHeld()
    expect(held.lastAcquire).toEqual({
      fenceSchema: 2,
      storedDevice: staleDevice,
      currentDevice: dev,
    })
    // While the lease holds, another real connection cannot take the lock.
    const contender = connection(storeRoot)
    let contenderCode: unknown
    try {
      contender.exec('BEGIN EXCLUSIVE')
    } catch (error) {
      contenderCode = (error as { code?: unknown }).code
    }
    expect(contenderCode).toBe('SQLITE_BUSY')
    expect(await fs.readFile(markerPath(storeRoot), 'utf8')).toBe(v2)
  })

  it.each([
    ['empty', () => ''],
    ['truncated v2', (dev: string, ino: string) => v2Fence(dev, ino).slice(0, 24)],
    [
      'v1 legacy lease id',
      () => JSON.stringify({ pid: 123, leaseId: 'legacy', acquiredAt: new Date(0).toISOString() }),
    ],
    [
      'unknown schema version',
      (_dev: string, ino: string) =>
        JSON.stringify({ schemaVersion: 4, ownership: OWNERSHIP, databaseInode: ino }),
    ],
    [
      'foreign ownership',
      (_dev: string, ino: string) =>
        JSON.stringify({ schemaVersion: 3, ownership: 'other', databaseInode: ino }),
    ],
  ] as const)(
    'T5: refuses the %s fence as legacy_fence and leaves it in place',
    async (_name, build) => {
      const storeRoot = await closedStoreRoot()
      const { dev, ino } = await databaseIdentity(storeRoot)
      const fence = build(dev, ino)
      await writeFence(storeRoot, fence)

      await expect(lease(storeRoot).acquire()).rejects.toMatchObject({
        reason: 'writer_locked',
        transientWriterContention: false,
        detail: 'legacy_fence',
      })
      expect(await fs.readFile(markerPath(storeRoot), 'utf8')).toBe(fence)

      // Witness: the same database with a valid fence is acquired.
      await writeFence(storeRoot, v2Fence(dev, ino))
      const valid = lease(storeRoot)
      await valid.acquire()
      valid.assertHeld()
    }
  )

  it('T6: operator recovery accepts a v2 fence with another device in place and refuses another inode', async () => {
    const storeRoot = await closedStoreRoot()
    const { dev, ino } = await databaseIdentity(storeRoot)
    const v2 = v2Fence(String(BigInt(dev) + 1n), ino)
    await writeFence(storeRoot, v2)
    let fenceChecks = 0
    const assertPhysicalFenceHeld = async () => {
      fenceChecks += 1
    }

    const operator = lease(storeRoot)
    await operator.acquireForRecovery({
      expectedWriterFenceSha256: sha256(v2),
      assertPhysicalFenceHeld,
    })
    await operator.verifyHeld()
    expect(fenceChecks).toBeGreaterThan(0)
    expect(operator.lastAcquire?.fenceSchema).toBe(2)
    // The inspected hash stays valid: the v2 file is not rewritten.
    expect(await fs.readFile(markerPath(storeRoot), 'utf8')).toBe(v2)
    await operator.release()

    const foreign = v2Fence(dev, String(BigInt(ino) + 1n))
    await writeFence(storeRoot, foreign)
    await expect(
      lease(storeRoot).acquireForRecovery({
        expectedWriterFenceSha256: sha256(foreign),
        assertPhysicalFenceHeld,
      })
    ).rejects.toMatchObject({
      reason: 'writer_locked',
      transientWriterContention: false,
      detail: 'database_identity_changed',
    })
    expect(await fs.readFile(markerPath(storeRoot), 'utf8')).toBe(foreign)
  })

  it('T9: assertInitialized and assertWriterOwnership propagate ownership_lost', async () => {
    const store = freshStore()
    await store.initialize()
    expect(store.isAvailable()).toBe(true)
    // Witness: the guarded call succeeds while the writer is held.
    await store.cleanupExpired()

    await (store as unknown as { writerLease: GfsStoreWriterLease }).writerLease.release()
    // cleanupExpired checks assertInitialized first.
    await expect(store.cleanupExpired()).rejects.toMatchObject({
      code: 'writer_locked',
      transientWriterContention: false,
      detail: 'ownership_lost',
    })
    // close() reaches assertWriterOwnership through serialize, without assertInitialized.
    await expect(store.close(0)).rejects.toMatchObject({
      code: 'writer_locked',
      transientWriterContention: false,
      detail: 'ownership_lost',
    })
    expect(store.isAvailable()).toBe(false)
  })
})
