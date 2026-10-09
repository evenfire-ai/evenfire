/**
 * Physical free space versus cached copies (PR #1028 review R1-H1, R1-L1).
 *
 * With the budget at 85% of the volume, the cache plus foreign data can leave
 * less free space than a request and the free-space floor (16 MiB, its
 * minimum, on the 40 MiB volume used here) while the cache is
 * still under budget. Unpinned, unreserved copies are evicted to cover that
 * deficit, planned as a whole before any delete; pinned copies never are.
 * statfs is the only boundary replaced: it reports a simulated volume whose
 * free space is its size minus foreign data minus the bytes of every regular
 * file under the Host root, so a removal frees space exactly as on a disk.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as syncFs from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import {
  callerDirectory,
  completedCopy,
  digestOf,
  downloadDirectory,
  exists,
  expiryCount,
  quotaCount,
  startTransfer,
} from '../__tests__/fixtures/gfsStoreTestKit'
import { GfsDownloadStore } from './gfsDownloadStore'

const { statfsBoundary } = vi.hoisted(() => ({ statfsBoundary: vi.fn() }))
vi.mock('node:fs/promises', async original => ({
  ...(await original<typeof fs>()),
  statfs: statfsBoundary,
}))

const A = 'caller-a'
const B = 'caller-b'
const C = 'caller-c'
const MIB = 1024 * 1024

let nativeFs: typeof fs
let hostRoot: string
let rootA: string
let rootB: string
let rootC: string
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

/**
 * A `totalBytes` volume (block size 1) holding `foreignBytes` the store does
 * not own plus every regular file under the Host root.
 */
function simulatedVolume(totalBytes: number, foreignBytes: number): void {
  statfsBoundary.mockImplementation(async (target: string) => {
    const real = await nativeFs.statfs(target, { bigint: true })
    const free = BigInt(totalBytes - foreignBytes - regularBytes(hostRoot))
    return { ...real, bsize: 1n, blocks: BigInt(totalBytes), bavail: free < 0n ? 0n : free }
  })
}

/** statfs reports the real free space but a `totalBytes` volume (block size 1). */
function volumeOf(totalBytes: number): void {
  statfsBoundary.mockImplementation(async (target: string) => {
    const real = await nativeFs.statfs(target, { bigint: true })
    return { ...real, bsize: 1n, blocks: BigInt(totalBytes), bavail: real.bavail * real.bsize }
  })
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

/** Ten 1 MiB copies of caller B, oldest first. */
async function fillWithCopiesOfB(store: GfsDownloadStore, owner?: string): Promise<string[]> {
  const ids: string[] = []
  for (let index = 0; index < 10; index += 1) {
    const { receipt } = await completedCopy(
      store,
      rootB,
      B,
      500 + index,
      MIB,
      owner === undefined ? {} : { owner }
    )
    ids.push(receipt.id)
    tick()
  }
  return ids
}

beforeEach(async () => {
  nativeFs = await vi.importActual<typeof fs>('node:fs/promises')
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-08T10:00:00.000Z'))
  statfsBoundary.mockReset()
  statfsBoundary.mockImplementation(nativeFs.statfs)
  hostRoot = syncFs.mkdtempSync(path.join(tmpdir(), 'gfs-store-disk-pressure-'))
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

describe('GFS download store: disk pressure evicts unpinned copies', () => {
  it('DP-1: a full disk under budget evicts the least recently used unpinned copies of another caller instead of refusing as disk_full', async () => {
    // 40 MiB volume, 10 MiB foreign, budget floor(40 MiB * 85%) = 34 MiB.
    // Ten 1 MiB copies leave 20 MiB (minus meta.json bytes) free; a 5 MiB
    // download needs 5 MiB + the 16 MiB floor = 21 MiB, while the cache
    // (10 MiB + 5 MiB) is far under budget.
    simulatedVolume(40 * MIB, 10 * MIB)
    const store = await openStore()
    const ids = await fillWithCopiesOfB(store)
    const diskDenied = await quotaCount('host', 'free_space')
    const evicted = await expiryCount('expired_removed')

    const admitted = await startTransfer(store, rootA, A, 600, 5 * MIB)

    expect(admitted.transfer.sizeBytes).toBe(5 * MIB)
    expect(await quotaCount('host', 'free_space')).toBe(diskDenied)
    // The deficit is 1 MiB plus the meta.json bytes, so exactly the two
    // least recently used copies go and the other eight stay.
    expect(ids.slice(0, 2).map(id => exists(downloadDirectory(rootB, id)))).toEqual([false, false])
    for (const id of ids.slice(2)) expect(exists(downloadDirectory(rootB, id))).toBe(true)
    // R1-L1: an eviction is counted as expired_removed (expired or evicted).
    expect(await expiryCount('expired_removed')).toBe(evicted + 2)
    // Witness: the admitted reservation writes and publishes normally.
    const receipt = await store.publish(admitted.transfer.id, A, digestOf(admitted.bytes))
    // Compared by digest: a deep equality over 5 MiB is slow.
    expect(digestOf(await store.readManagedFile(receipt.path, A))).toBe(digestOf(admitted.bytes))
  })

  it('DP-2: pinned copies are never evicted for a physical deficit, and the admission refuses as disk_full without deleting anything', async () => {
    simulatedVolume(40 * MIB, 10 * MIB)
    const store = await openStore()
    // B protects 10 MiB, under its floor(34 MiB / 2) cap.
    const ids = await fillWithCopiesOfB(store, 'task-b')
    const planner = vi.spyOn(
      store as unknown as { planEviction: (...args: unknown[]) => unknown },
      'planEviction'
    )
    const diskDenied = await quotaCount('host', 'free_space')
    const evicted = await expiryCount('expired_removed')

    await expect(startTransfer(store, rootA, A, 601, 5 * MIB)).rejects.toMatchObject({
      code: 'disk_full',
    })

    // Witness: the eviction planner ran for this admission with a physical
    // deficit and found nothing it may evict.
    expect(planner).toHaveBeenCalledTimes(1)
    expect(planner.mock.results[0]!.value).toMatchObject({ physicalCovered: false })
    expect(await quotaCount('host', 'free_space')).toBe(diskDenied + 1)
    for (const id of ids) expect(exists(downloadDirectory(rootB, id))).toBe(true)
    expect(await expiryCount('expired_removed')).toBe(evicted)

    // Contrast on the same volume: released pins make the same copies evictable.
    await store.releaseReceiptOwner('task-b', B)
    await expect(startTransfer(store, rootA, A, 602, 5 * MIB)).resolves.toBeDefined()
    expect(exists(downloadDirectory(rootB, ids[0]!))).toBe(false)
  })

  it('DP-3: a deficit larger than every unpinned copy refuses as disk_full and evicts nothing', async () => {
    simulatedVolume(40 * MIB, 10 * MIB)
    const store = await openStore()
    const ids = await fillWithCopiesOfB(store)
    const evicted = await expiryCount('expired_removed')

    // 15 MiB + 16 MiB floor = 31 MiB; at most 20 + 10 = 30 MiB can be free.
    await expect(startTransfer(store, rootA, A, 603, 15 * MIB)).rejects.toMatchObject({
      code: 'disk_full',
    })

    for (const id of ids) expect(exists(downloadDirectory(rootB, id))).toBe(true)
    expect(await expiryCount('expired_removed')).toBe(evicted)
    // Witness: a request the copies can cover is admitted on the same volume.
    await expect(startTransfer(store, rootA, A, 604, 5 * MIB)).resolves.toBeDefined()
  })
})

describe('GFS download store: eviction metric', () => {
  it('EVM-1: a budget eviction increments expired_removed and removes the evicted directory', async () => {
    // 100-byte volume, budget 70: 30 + 30 retained + 15 requested is over.
    volumeOf(100)
    const store = await openStore()
    const oldest = await completedCopy(store, rootB, B, 700, 30)
    tick()
    const newer = await completedCopy(store, rootA, A, 701, 30)
    tick()
    const evicted = await expiryCount('expired_removed')
    const removed = await expiryCount('incomplete_removed')

    await startTransfer(store, rootC, C, 702, 15)

    // Witness: the eviction happened, and only the least recently used copy went.
    expect(exists(downloadDirectory(rootB, oldest.receipt.id))).toBe(false)
    expect(exists(downloadDirectory(rootA, newer.receipt.id))).toBe(true)
    expect(await expiryCount('expired_removed')).toBe(evicted + 1)
    expect(await expiryCount('incomplete_removed')).toBe(removed)
  })
})
