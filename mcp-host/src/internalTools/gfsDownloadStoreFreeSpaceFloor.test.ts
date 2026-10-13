/**
 * The free-space floor (PR #1028 review round 2, A1-A3).
 *
 * The store keeps max(15% of the volume, 16 MiB) free. Admission refuses as
 * disk_full when evicting unpinned copies cannot cover its request plus the
 * floor, and startup and the periodic cleanupExpired evict unpinned copies
 * when something else on the volume took the free space below the floor,
 * until the floor plus 5% of the volume is free. statfs is the only
 * boundary replaced: it reports a simulated 200 MiB volume (floor 30 MiB)
 * whose free space is its size minus `foreign` bytes the store does not own
 * minus the bytes of every regular file under the Host root, so a removal
 * frees space exactly as on a disk.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import * as syncFs from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import {
  callerDirectory,
  completedCopy,
  downloadDirectory,
  exists,
  expiryCount,
  metaFor,
  plantDownload,
  quotaCount,
  sourceFor,
  startTransfer,
} from '../__tests__/fixtures/gfsStoreTestKit'
import { logger } from '../logger'
import { GfsDownloadStore, freeSpaceFloor, freeSpaceRestoreTarget } from './gfsDownloadStore'

const { statfsBoundary } = vi.hoisted(() => ({ statfsBoundary: vi.fn() }))
vi.mock('node:fs/promises', async original => ({
  ...(await original<typeof fs>()),
  statfs: statfsBoundary,
}))

const A = 'caller-a'
const B = 'caller-b'
const C = 'caller-c'
const MIB = 1024 * 1024
const HOUR = 60 * 60_000
const TOTAL = 200 * MIB
/** 15% of the 200 MiB volume: 31 457 280 bytes. */
const FLOOR = 30 * MIB
const FLOOR_WARNING =
  'GFS download store found the volume below its free-space floor and evicted unpinned copies'

let nativeFs: typeof fs
let hostRoot: string
let rootA: string
let rootB: string
let rootC: string
let foreign = 0
const stores: GfsDownloadStore[] = []

function regularBytes(directory: string): number {
  let sum = 0
  for (const child of syncFs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, child.name)
    if (child.isDirectory()) sum += regularBytes(target)
    else if (child.isFile()) sum += syncFs.lstatSync(target).size
  }
  return sum
}

function simulatedVolume(): void {
  statfsBoundary.mockImplementation(async (target: string) => {
    const real = await nativeFs.statfs(target, { bigint: true })
    const free = BigInt(TOTAL - foreign - regularBytes(hostRoot))
    return { ...real, bsize: 1n, blocks: BigInt(TOTAL), bavail: free < 0n ? 0n : free }
  })
}

/** Sets the foreign data so the volume has exactly `freeBytes` free now. */
function leaveFree(freeBytes: number): void {
  foreign = TOTAL - freeBytes - regularBytes(hostRoot)
}

async function openStore(): Promise<GfsDownloadStore> {
  const opened = new GfsDownloadStore(hostRoot)
  stores.push(opened)
  await opened.initialize()
  return opened
}

/** Distinct createdAt and last-use values so the eviction order is deterministic. */
function tick(): void {
  vi.setSystemTime(Date.now() + 1_000)
}

function provenanceOf(store: GfsDownloadStore, id: string): string | undefined {
  return (store as unknown as { entries: Map<string, { provenance: string }> }).entries.get(id)
    ?.provenance
}

function floorWarnings(warn: { mock: { calls: unknown[][] } }): unknown[] {
  return warn.mock.calls.filter(call => call[1] === FLOOR_WARNING).map(call => call[0])
}

/** Splits `named` directories into the ones removed and the ones still on disk. */
function survey(named: Record<string, string>): { removed: string[]; kept: string[] } {
  const removed: string[] = []
  const kept: string[] = []
  for (const [name, directory] of Object.entries(named))
    (exists(directory) ? kept : removed).push(name)
  return { removed: removed.sort(), kept: kept.sort() }
}

beforeEach(async () => {
  nativeFs = await vi.importActual<typeof fs>('node:fs/promises')
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T10:00:00.000Z'))
  statfsBoundary.mockReset()
  foreign = 0
  simulatedVolume()
  hostRoot = syncFs.mkdtempSync(path.join(tmpdir(), 'gfs-store-free-space-floor-'))
  rootA = callerDirectory(hostRoot, A)
  rootB = callerDirectory(hostRoot, B)
  rootC = callerDirectory(hostRoot, C)
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  for (const opened of stores.splice(0)) await opened.close(0)
  await nativeFs.rm(hostRoot, { recursive: true, force: true })
})

describe('GFS download store: free-space floor value', () => {
  it('FSF-1: the floor is 15% of the volume, and never less than 16 MiB', () => {
    // 10 GiB in 4 KiB blocks.
    expect(freeSpaceFloor({ bsize: 4096n, blocks: 2_621_440n })).toBe(1_610_612_736n)
    expect(freeSpaceFloor({ bsize: 1n, blocks: BigInt(TOTAL) })).toBe(BigInt(FLOOR))
    // 15% of 100 MiB is 15 MiB, under the minimum.
    expect(freeSpaceFloor({ bsize: 4096n, blocks: 25_600n })).toBe(16n * 1024n * 1024n)
    expect(freeSpaceFloor({ bsize: 1n, blocks: 1000n })).toBe(16n * 1024n * 1024n)
    expect(freeSpaceFloor({ bsize: 4096n, blocks: 0n })).toBe(16n * 1024n * 1024n)
  })

  it('FSF-1b: a restore aims for the floor plus 5% of the volume', () => {
    expect(freeSpaceRestoreTarget({ bsize: 1n, blocks: BigInt(TOTAL) })).toBe(
      BigInt(FLOOR + 10 * MIB)
    )
    // 16 MiB minimum floor plus 5% of 1000 bytes.
    expect(freeSpaceRestoreTarget({ bsize: 1n, blocks: 1000n })).toBe(16n * 1024n * 1024n + 50n)
  })
})

describe('GFS download store: admission keeps the free-space floor', () => {
  it('FSF-2: an admission is refused as disk_full while every copy is pinned, and admitted after evicting released copies', async () => {
    const store = await openStore()
    const ids: string[] = []
    for (let index = 0; index < 10; index += 1) {
      const { receipt } = await completedCopy(store, rootB, B, 100 + index, MIB, {
        owner: 'task-b',
      })
      ids.push(receipt.id)
      tick()
    }
    // 30 MiB free: a 5 MiB request needs 5 MiB plus the 30 MiB floor.
    leaveFree(FLOOR)
    const diskDenied = await quotaCount('host', 'free_space')
    const evicted = await expiryCount('expired_removed')

    await expect(startTransfer(store, rootA, A, 200, 5 * MIB)).rejects.toMatchObject({
      code: 'disk_full',
    })
    expect(await quotaCount('host', 'free_space')).toBe(diskDenied + 1)
    expect(ids.every(id => exists(downloadDirectory(rootB, id)))).toBe(true)
    expect(await expiryCount('expired_removed')).toBe(evicted)

    await store.releaseReceiptOwner('task-b', B)
    const admitted = await startTransfer(store, rootA, A, 201, 5 * MIB)

    // Witness: the admitted transfer exists and the five least recently used
    // copies were evicted to cover its 5 MiB; the other five stay.
    expect(exists(downloadDirectory(rootA, admitted.transfer.id))).toBe(true)
    expect(ids.map(id => exists(downloadDirectory(rootB, id)))).toEqual([
      false,
      false,
      false,
      false,
      false,
      true,
      true,
      true,
      true,
      true,
    ])
    expect(await expiryCount('expired_removed')).toBe(evicted + 5)
    await store.fail(admitted.transfer.id, A)
  })
})

describe('GFS download store: the periodic sweep restores the free-space floor', () => {
  it('FSF-3: below the floor, cleanupExpired evicts the adopted copy and then the least recently used ones up to the floor plus 5%, and keeps pinned copies and active transfers', async () => {
    const plantedBytes = Buffer.alloc(4 * MIB, 3)
    const plantedId = randomUUID()
    const planted = plantDownload(rootC, {
      id: plantedId,
      bytes: plantedBytes,
      meta: metaFor(plantedId, plantedBytes, Date.now(), {
        callerIdentity: C,
        source: sourceFor(300),
        expiresAt: new Date(Date.now() + 2 * HOUR).toISOString(),
      }),
    })
    const store = await openStore()
    expect(provenanceOf(store, planted.id)).toBe('adopted')
    tick()
    // The pinned copy is the oldest published one, so only its pin keeps it.
    const pinned = await completedCopy(store, rootA, A, 301, 4 * MIB, { owner: 'task-a' })
    tick()
    const oldest = await completedCopy(store, rootB, B, 302, 4 * MIB)
    tick()
    const middle = await completedCopy(store, rootB, B, 303, 4 * MIB)
    tick()
    const newest = await completedCopy(store, rootB, B, 304, 4 * MIB)
    tick()
    const active = await startTransfer(store, rootA, A, 305, 4 * MIB)
    // 1 MiB below the 30 MiB floor; the restore aims for 30 + 10 MiB free, so
    // it needs 11 MiB: the adopted copy, then the oldest and the middle one.
    leaveFree(FLOOR - MIB)
    const warn = vi.spyOn(logger, 'warn')
    const evicted = await expiryCount('expired_removed')

    const result = await store.cleanupExpired()

    expect(result).toEqual({ removedExpired: 0, removedIncomplete: 0, removeFailed: 0 })
    expect(
      survey({
        adopted: planted.directory,
        pinned: downloadDirectory(rootA, pinned.receipt.id),
        oldest: downloadDirectory(rootB, oldest.receipt.id),
        middle: downloadDirectory(rootB, middle.receipt.id),
        newest: downloadDirectory(rootB, newest.receipt.id),
        active: downloadDirectory(rootA, active.transfer.id),
      })
    ).toEqual({ removed: ['adopted', 'middle', 'oldest'], kept: ['active', 'newest', 'pinned'] })
    expect(floorWarnings(warn)).toEqual([
      expect.objectContaining({ evicted: 3, removeFailed: 0, restored: true }),
    ])
    expect(await expiryCount('expired_removed')).toBe(evicted + 3)
    // The kept copies are still served.
    expect((await store.readManagedFile(pinned.receipt.path, A)).equals(pinned.bytes)).toBe(true)
    await store.fail(active.transfer.id, A)
  })

  it('FSF-4: above the floor, cleanupExpired evicts nothing while it still removes an expired copy', async () => {
    const store = await openStore()
    const expiring = await completedCopy(store, rootB, B, 400, MIB, {
      expiresAt: new Date(Date.now() + HOUR).toISOString(),
    })
    tick()
    const live = await completedCopy(store, rootB, B, 401, MIB)
    leaveFree(FLOOR + 10 * MIB)
    vi.setSystemTime(Date.now() + 90 * 60_000)
    const warn = vi.spyOn(logger, 'warn')
    const evicted = await expiryCount('expired_removed')

    const result = await store.cleanupExpired()

    // Witness: the same call removed the expired copy.
    expect(result).toEqual({ removedExpired: 1, removedIncomplete: 0, removeFailed: 0 })
    expect(exists(downloadDirectory(rootB, expiring.receipt.id))).toBe(false)
    expect(await expiryCount('expired_removed')).toBe(evicted + 1)
    expect(exists(downloadDirectory(rootB, live.receipt.id))).toBe(true)
    expect(floorWarnings(warn)).toEqual([])
  })

  it('FSF-5: a deficit larger than every unpinned copy is restored partially, and the evictions are kept', async () => {
    const store = await openStore()
    const pinned = await completedCopy(store, rootA, A, 500, MIB, { owner: 'task-a' })
    tick()
    const first = await completedCopy(store, rootB, B, 501, MIB)
    tick()
    const second = await completedCopy(store, rootB, B, 502, MIB)
    leaveFree(FLOOR - 5 * MIB)
    const warn = vi.spyOn(logger, 'warn')
    const evicted = await expiryCount('expired_removed')

    await expect(store.cleanupExpired()).resolves.toEqual({
      removedExpired: 0,
      removedIncomplete: 0,
      removeFailed: 0,
    })

    expect(
      survey({
        pinned: downloadDirectory(rootA, pinned.receipt.id),
        first: downloadDirectory(rootB, first.receipt.id),
        second: downloadDirectory(rootB, second.receipt.id),
      })
    ).toEqual({ removed: ['first', 'second'], kept: ['pinned'] })
    expect(floorWarnings(warn)).toEqual([
      expect.objectContaining({ evicted: 2, removeFailed: 0, restored: false }),
    ])
    expect(await expiryCount('expired_removed')).toBe(evicted + 2)
  })

  it.each([
    ['statfs rejects', 'EIO'],
    ['two invalid readings', 'volume_unmeasurable'],
  ])(
    'FSF-6: when %s, cleanupExpired keeps its sweep result, evicts nothing and logs the failure',
    async (_case, code) => {
      const store = await openStore()
      const expiring = await completedCopy(store, rootB, B, 600, MIB, {
        expiresAt: new Date(Date.now() + HOUR).toISOString(),
      })
      tick()
      const unpinned = await completedCopy(store, rootB, B, 601, MIB)
      leaveFree(FLOOR - 5 * MIB)
      vi.setSystemTime(Date.now() + 90 * 60_000)
      statfsBoundary.mockReset()
      if (code === 'EIO')
        statfsBoundary.mockRejectedValue(Object.assign(new Error('simulated'), { code: 'EIO' }))
      else
        statfsBoundary.mockImplementation(async (target: string) => ({
          ...(await nativeFs.statfs(target, { bigint: true })),
          blocks: 0n,
        }))
      const warn = vi.spyOn(logger, 'warn')
      const failed = await expiryCount('sweep_failed')

      const result = await store.cleanupExpired()

      expect(result).toEqual({ removedExpired: 1, removedIncomplete: 0, removeFailed: 0 })
      expect(exists(downloadDirectory(rootB, expiring.receipt.id))).toBe(false)
      // Witness: the restore ran and could not measure the volume.
      expect(statfsBoundary).toHaveBeenCalled()
      expect(await expiryCount('sweep_failed')).toBe(failed + 1)
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ code }),
        'GFS download store could not measure the volume to restore its free-space floor; the next sweep retries it'
      )
      expect(exists(downloadDirectory(rootB, unpinned.receipt.id))).toBe(true)
      expect(floorWarnings(warn)).toEqual([])
    }
  )

  it('FSF-7: a restore continues past the floor and stops once the floor plus 5% is free', async () => {
    const store = await openStore()
    const ids: string[] = []
    for (let index = 0; index < 5; index += 1) {
      const { receipt } = await completedCopy(store, rootB, B, 700 + index, 3 * MIB)
      ids.push(receipt.id)
      tick()
    }
    // One byte below the floor. Restoring only the floor would take the
    // oldest copy; the floor plus 10 MiB needs 10 MiB + 1 byte: four copies.
    leaveFree(FLOOR - 1)
    const warn = vi.spyOn(logger, 'warn')

    await store.cleanupExpired()

    expect(ids.map(id => exists(downloadDirectory(rootB, id)))).toEqual([
      false,
      false,
      false,
      false,
      true,
    ])
    expect(floorWarnings(warn)).toEqual([
      expect.objectContaining({ evicted: 4, removeFailed: 0, restored: true }),
    ])
  })
})

describe('GFS download store: startup restores the free-space floor', () => {
  it('FSF-8: a store initialized on a volume below the floor evicts adopted copies before it is available', async () => {
    const first = await openStore()
    const ids: string[] = []
    for (let index = 0; index < 4; index += 1) {
      const { receipt } = await completedCopy(first, rootB, B, 800 + index, 4 * MIB)
      ids.push(receipt.id)
      tick()
    }
    stores.splice(stores.indexOf(first), 1)
    await first.close(0)
    // 1 MiB below the floor at restart: the restore needs 11 MiB, three copies.
    leaveFree(FLOOR - MIB)
    const warn = vi.spyOn(logger, 'warn')
    const evicted = await expiryCount('expired_removed')
    statfsBoundary.mockClear()

    const restarted = await openStore()

    expect(restarted.isAvailable()).toBe(true)
    // Witness: initialize measured the volume and logged the restore.
    expect(statfsBoundary).toHaveBeenCalled()
    expect(floorWarnings(warn)).toEqual([
      expect.objectContaining({ evicted: 3, removeFailed: 0, restored: true }),
    ])
    expect(ids.filter(id => exists(downloadDirectory(rootB, id)))).toHaveLength(1)
    expect(await expiryCount('expired_removed')).toBe(evicted + 3)
  })
})
