/**
 * Round-5 findings of #1028 (Addendum 12), on a real temporary directory.
 * statfs reports a volume whose available bytes are its total minus the
 * source bytes actually on disk (trash included), so free space and the
 * retained budget follow what the store really keeps. Faults are injected
 * only on the operation under test.
 *
 * - M1: expired copies, pinned ones included, are swept before the first
 *   free-space check, so they never refuse an admission as disk_full; live
 *   cached copies are still never evicted before that check.
 * - R5-F1: a removal that renamed a directory to its trash name and then
 *   could not remove it keeps the retained-byte charge on the trash name.
 * - R5-F2: a reuse that crosses expiry while hashing is a cache miss.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  quotaCount,
  sourceFor,
  startTransfer,
  withEnvironment,
} from '../__tests__/fixtures/gfsStoreTestKit'
import { GfsDownloadStore } from './gfsDownloadStore'

const { openBoundary, statfsBoundary, rmBoundary } = vi.hoisted(() => ({
  openBoundary: vi.fn(),
  statfsBoundary: vi.fn(),
  rmBoundary: vi.fn(),
}))
vi.mock('node:fs/promises', async original => ({
  ...(await original<typeof fs>()),
  open: openBoundary,
  statfs: statfsBoundary,
  rm: rmBoundary,
}))

const A = 'caller-a'
const B = 'caller-b'
const C = 'caller-c'
const HOUR_MS = 60 * 60_000
const MIB = 1024 * 1024
/** The store's fixed free-space margin. */
const MARGIN = 16n * BigInt(MIB)

let nativeFs: typeof fs
let hostRoot: string
let rootA: string
let rootB: string
let rootC: string
const stores: GfsDownloadStore[] = []
const releases: Array<() => void> = []

/** Bytes of every `source` and `source.partial` under `directory`, trash included. */
function storedSourceBytes(directory: string): number {
  let total = 0
  for (const entry of syncFs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) total += storedSourceBytes(target)
    else if (entry.isFile() && ['source', 'source.partial'].includes(entry.name))
      total += syncFs.statSync(target).size
  }
  return total
}

/** A `totalBytes` volume (block size 1) with `freeWhenEmpty` available while the store holds nothing. */
function coherentVolume(totalBytes: bigint, freeWhenEmpty: bigint): void {
  statfsBoundary.mockImplementation(async (target: string) => {
    const real = await nativeFs.statfs(target, { bigint: true })
    return {
      ...real,
      bsize: 1n,
      blocks: totalBytes,
      bavail: freeWhenEmpty - BigInt(storedSourceBytes(hostRoot)),
    }
  })
}

async function openStore(): Promise<GfsDownloadStore> {
  const opened = new GfsDownloadStore(hostRoot)
  stores.push(opened)
  await opened.initialize()
  return opened
}

/** A store re-imported with environment limits applied. */
async function limitedStore(env: Record<string, string>): Promise<GfsDownloadStore> {
  return withEnvironment(env, async () => {
    vi.resetModules()
    const { GfsDownloadStore: Store } = await import('./gfsDownloadStore')
    const opened = new Store(hostRoot) as unknown as GfsDownloadStore
    stores.push(opened)
    await opened.initialize()
    return opened
  })
}

/** Trash directories left in one caller's `.gfs-downloads`. */
function trashIn(root: string): string[] {
  const downloads = path.join(root, '.gfs-downloads')
  if (!exists(downloads)) return []
  return syncFs.readdirSync(downloads).filter(name => name.startsWith('.trash-'))
}

/** Pauses the next read of a `source` descriptor until `resume()`. */
function pauseNextSourceRead() {
  let entered!: () => void
  let resume!: () => void
  const reached = new Promise<void>(resolve => {
    entered = resolve
  })
  const resumed = new Promise<void>(resolve => {
    resume = resolve
  })
  releases.push(resume)
  let armed = true
  openBoundary.mockImplementation(async (...args: unknown[]) => {
    const handle = (await Reflect.apply(nativeFs.open, nativeFs, args)) as fs.FileHandle
    if (armed && String(args[0]).endsWith(`${path.sep}source`)) {
      armed = false
      const read = handle.read.bind(handle)
      vi.spyOn(handle, 'read').mockImplementationOnce(async (...readArgs: unknown[]) => {
        entered()
        await resumed
        return Reflect.apply(read, handle, readArgs)
      })
    }
    return handle
  })
  return { reached, resume }
}

/** White-box view of the pins: owner ids per caller. */
function pinOwners(store: GfsDownloadStore): string[] {
  const pins = (store as unknown as { pins: Map<string, Set<string>> }).pins
  return [...pins.keys()].map(key => (JSON.parse(key) as [string, string]).join('/')).sort()
}

beforeEach(async () => {
  nativeFs = await vi.importActual<typeof fs>('node:fs/promises')
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-08T12:00:00.000Z'))
  openBoundary.mockReset()
  openBoundary.mockImplementation((...args: unknown[]) =>
    Reflect.apply(nativeFs.open, nativeFs, args)
  )
  rmBoundary.mockReset()
  rmBoundary.mockImplementation((...args: unknown[]) => Reflect.apply(nativeFs.rm, nativeFs, args))
  statfsBoundary.mockReset()
  hostRoot = syncFs.mkdtempSync(path.join(tmpdir(), 'gfs-store-trash-expiry-'))
  // A 1000-byte volume at the default 85%: budget 850, per-caller cap 425,
  // so only the free-space check can refuse the small admissions below.
  coherentVolume(1000n, MARGIN + 20n)
  rootA = callerDirectory(hostRoot, A)
  rootB = callerDirectory(hostRoot, B)
  rootC = callerDirectory(hostRoot, C)
})

afterEach(async () => {
  for (const resume of releases.splice(0)) resume()
  vi.restoreAllMocks()
  vi.useRealTimers()
  for (const opened of stores.splice(0)) await opened.close(0)
  await nativeFs.rm(hostRoot, { recursive: true, force: true })
})

describe('GFS download store: expired copies never make the disk full (M1)', () => {
  it('an admission refused as disk_full only because of an expired pinned copy is admitted, and the expired directory is gone', async () => {
    const store = await openStore()
    // 6 pinned bytes leave margin + 14 available.
    const expiring = await completedCopy(store, rootA, A, 0, 6, { owner: 'task-a' })
    const directory = downloadDirectory(rootA, expiring.receipt.id)
    const diskDenied = await quotaCount('host', 'free_space')

    // Witness: while the copy is live, 18 bytes do not fit (margin + 14 < margin + 18).
    await expect(startTransfer(store, rootB, B, 1, 18)).rejects.toMatchObject({ code: 'disk_full' })
    expect(await quotaCount('host', 'free_space')).toBe(diskDenied + 1)
    expect(exists(directory)).toBe(true)

    // Past its expiresAt, task-a still open: the admission sweep removes it first.
    vi.setSystemTime(Date.now() + 2 * HOUR_MS)
    const removedBefore = await expiryCount('expired_removed')
    const admitted = await startTransfer(store, rootB, B, 1, 18)
    expect(admitted.transfer.sizeBytes).toBe(18)
    expect(await quotaCount('host', 'free_space')).toBe(diskDenied + 1)
    expect(await expiryCount('expired_removed')).toBe(removedBefore + 1)
    expect(exists(directory)).toBe(false)
    await store.fail(admitted.transfer.id, B)
  })

  it('a disk truly full after the sweep refuses as disk_full and leaves live cached copies intact', async () => {
    const store = await openStore()
    // A live unpinned 6-byte copy for a day, and a pinned 6-byte copy for an
    // hour: margin + 8 available.
    const live = await completedCopy(store, rootA, A, 0, 6, {
      expiresAt: new Date(Date.now() + 24 * HOUR_MS).toISOString(),
    })
    const expiring = await completedCopy(store, rootA, A, 1, 6, { owner: 'task-a' })
    vi.setSystemTime(Date.now() + 2 * HOUR_MS)
    const diskDenied = await quotaCount('host', 'free_space')
    const removedBefore = await expiryCount('expired_removed')

    // The sweep frees the expired 6 bytes (margin + 14), still short of
    // margin + 16; evicting the live copy would make it fit, but no live copy
    // is evicted before the free-space check.
    await expect(startTransfer(store, rootB, B, 2, 16)).rejects.toMatchObject({ code: 'disk_full' })
    expect(await quotaCount('host', 'free_space')).toBe(diskDenied + 1)
    // Witness: the sweep ran before the refusal.
    expect(await expiryCount('expired_removed')).toBe(removedBefore + 1)
    expect(exists(downloadDirectory(rootA, expiring.receipt.id))).toBe(false)
    expect(exists(downloadDirectory(rootA, live.receipt.id))).toBe(true)
    await expect(store.readManagedFile(live.receipt.path, A)).resolves.toEqual(live.bytes)

    // Witness: what the swept volume holds is admitted, beside the live copy.
    const admitted = await startTransfer(store, rootB, B, 3, 14)
    expect(exists(downloadDirectory(rootA, live.receipt.id))).toBe(true)
    await store.fail(admitted.transfer.id, B)
  })
})

describe('GFS download store: a copy left under a trash name stays charged (R5-F1)', () => {
  it('SOL-R5-TRASH-CHARGE: expired pinned copies whose trash cannot be removed keep their charge until cleanup succeeds', async () => {
    // 1% of a 1000 MiB volume: budget 10 MiB, caller cap 5 MiB; the free
    // space always holds the 16 MiB margin, so only the budget can refuse.
    coherentVolume(1000n * BigInt(MIB), 1000n * BigInt(MIB))
    const store = await limitedStore({ MCP_HOST_GFS_DOWNLOAD_STORAGE_PERCENT: '1' })
    const copyA = await completedCopy(store, rootA, A, 0, 4 * MIB, { owner: 'task-a' })
    const copyB = await completedCopy(store, rootB, B, 1, 4 * MIB, { owner: 'task-b' })
    vi.setSystemTime(Date.now() + 2 * HOUR_MS)
    const trashRemovals: string[] = []
    rmBoundary.mockImplementation((...args: unknown[]) => {
      if (path.basename(String(args[0])).startsWith('.trash-')) {
        trashRemovals.push(String(args[0]))
        return Promise.reject(Object.assign(new Error('EIO: injected'), { code: 'EIO' }))
      }
      return Reflect.apply(nativeFs.rm, nativeFs, args)
    })

    // Both renames succeed and both removals fail: the old names are gone,
    // the 8 MiB are on disk under trash names.
    expect((await store.cleanupExpired()).removeFailed).toBe(2)
    expect(trashRemovals).toHaveLength(2)
    expect(exists(downloadDirectory(rootA, copyA.receipt.id))).toBe(false)
    expect(exists(downloadDirectory(rootB, copyB.receipt.id))).toBe(false)
    expect(trashIn(rootA)).toHaveLength(1)
    expect(trashIn(rootB)).toHaveLength(1)
    expect(storedSourceBytes(hostRoot)).toBe(8 * MIB)

    // 8 MiB on disk + 4 MiB requested > 10 MiB: refused while the trash
    // remains, after the admission sweep failed to remove it again (each
    // retry renames it to a new trash name, and the charge follows).
    await expect(startTransfer(store, rootC, C, 2, 4 * MIB)).rejects.toMatchObject({
      code: 'host_quota_exceeded',
    })
    expect(trashRemovals).toHaveLength(4)
    // The bytes moved to new trash names; the first ones no longer exist.
    const names = (targets: string[]) => targets.map(target => path.basename(target)).sort()
    expect([...trashIn(rootA), ...trashIn(rootB)].sort()).toEqual(names(trashRemovals.slice(2)))
    for (const first of trashRemovals.slice(0, 2)) expect(exists(first)).toBe(false)
    expect(storedSourceBytes(hostRoot)).toBe(8 * MIB)

    // A second failed cleanup still keeps the charge.
    expect((await store.cleanupExpired()).removeFailed).toBe(2)
    await expect(startTransfer(store, rootC, C, 2, 4 * MIB)).rejects.toMatchObject({
      code: 'host_quota_exceeded',
    })

    // Fault cleared: the cleanup removes both trash directories and the same
    // admission succeeds.
    rmBoundary.mockImplementation((...args: unknown[]) =>
      Reflect.apply(nativeFs.rm, nativeFs, args)
    )
    expect((await store.cleanupExpired()).removedIncomplete).toBe(2)
    expect(trashIn(rootA)).toHaveLength(0)
    expect(trashIn(rootB)).toHaveLength(0)
    expect(storedSourceBytes(hostRoot)).toBe(0)
    const admitted = await startTransfer(store, rootC, C, 2, 4 * MIB)
    expect(admitted.transfer.sizeBytes).toBe(4 * MIB)
    await store.fail(admitted.transfer.id, C)
  })
})

describe('GFS download store: reuse that crosses expiry while hashing (R5-F2)', () => {
  it('SOL-R5-REUSE-CROSS-EXPIRY: a copy that expires while it is hashed is a cache miss and gets no pin', async () => {
    coherentVolume(1000n, MARGIN + 1000n)
    const store = await openStore()
    const held = await completedCopy(store, rootA, A, 0, 30, { owner: 'task-a' })
    // Witness: before expiry the copy is reused and pinned for task-b.
    await expect(
      store.reusableReceipt(A, sourceFor(0), 30, { retentionOwnerId: 'task-b' })
    ).resolves.toMatchObject({ id: held.receipt.id })
    expect(pinOwners(store)).toEqual([`${A}/task-a`, `${A}/task-b`])

    vi.setSystemTime(Date.parse(held.receipt.expiresAt) - 1)
    const gate = pauseNextSourceRead()
    const reusing = store.reusableReceipt(A, sourceFor(0), 30, {
      retentionOwnerId: 'task-c',
      deadlineMs: Date.now() + 60_000,
      signal: new AbortController().signal,
    })
    // Witness: the hash read was reached before expiry and paused there.
    await gate.reached
    vi.setSystemTime(Date.parse(held.receipt.expiresAt))
    gate.resume()

    await expect(reusing).resolves.toBeUndefined()
    expect(pinOwners(store)).toEqual([`${A}/task-a`, `${A}/task-b`])
    await expect(store.readManagedFile(held.receipt.path, A)).rejects.toMatchObject({
      code: 'download_expired',
    })

    // Witness: the sweep removes the expired copy and a fresh one for
    // task-c is published, pinned and served.
    expect((await store.cleanupExpired()).removedExpired).toBe(1)
    const fresh = await completedCopy(store, rootA, A, 0, 30, { owner: 'task-c' })
    expect(pinOwners(store)).toEqual([`${A}/task-c`])
    await expect(store.readManagedFile(fresh.receipt.path, A)).resolves.toEqual(fresh.bytes)
  })
})
