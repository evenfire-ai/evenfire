/**
 * Boundary values of the GFS download store: meta.json validation, quotas and
 * capacity, expiry instants, in-process concurrency, content integrity,
 * caller isolation and path swaps between a check and its use.
 * Every limit is exercised at the value that is accepted and at the first
 * value that is refused, on a real temporary directory.
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
  digestOf,
  downloadDirectory,
  exists,
  expiryCount,
  freeSpaceSizedStatfs,
  metaFor,
  plantDownload,
  quotaCount,
  sourceFor,
  startTransfer,
  withEnvironment,
} from '../__tests__/fixtures/gfsStoreTestKit'
import { logger } from '../logger'
import { GfsDownloadStore, GfsDownloadStoreError } from './gfsDownloadStore'
import { GFS_FILE_LIMITS } from './gfsFilePolicy'

const { statfsBoundary, renameBoundary, openBoundary, realpathBoundary, rmBoundary } = vi.hoisted(
  () => ({
    statfsBoundary: vi.fn(),
    renameBoundary: vi.fn(),
    openBoundary: vi.fn(),
    realpathBoundary: vi.fn(),
    rmBoundary: vi.fn(),
  })
)
// Pass-through boundaries, overridden only to simulate statfs results and
// failures or to act between the two renames of a publication; open is only
// observed, to prove which files a lookup touched; realpath is where a path
// swap is injected right after the store's check returns; rm fails to leave
// bytes held under a trash name.
vi.mock('node:fs/promises', async original => ({
  ...(await original<typeof fs>()),
  statfs: statfsBoundary,
  rename: renameBoundary,
  open: openBoundary,
  realpath: realpathBoundary,
  rm: rmBoundary,
}))

const A = 'caller-a'
const B = 'caller-b'
const HOUR = 60 * 60_000
const META_MAX_BYTES = 64 * 1024
/** A 10-byte file limit and the whole (mocked) volume as the retained budget. */
const SMALL_FILES_FULL_VOLUME = {
  MCP_HOST_GFS_MAX_FILE_BYTES: '10',
  MCP_HOST_GFS_DOWNLOAD_STORAGE_PERCENT: '100',
}

let nativeFs: typeof fs
let hostRoot: string
let rootA: string
let rootB: string
let store: GfsDownloadStore
const extraStores: GfsDownloadStore[] = []
const outsideRoots: string[] = []

function receiptPathOf(id: string): string {
  return `.gfs-downloads/input-${id}/source`
}

function at(ms: number): string {
  return new Date(ms).toISOString()
}

/** Distinct timestamps so creation and last-use order are deterministic. */
function tick(): void {
  vi.setSystemTime(Date.now() + 1_000)
}

function plantComplete(root: string, identity: string, index: number, bytes: Buffer) {
  const id = randomUUID()
  return plantDownload(root, {
    id,
    bytes,
    meta: metaFor(id, bytes, Date.now(), { callerIdentity: identity, source: sourceFor(index) }),
  })
}

async function limitedStore(env: Record<string, string>): Promise<GfsDownloadStore> {
  return withEnvironment(env, async () => {
    vi.resetModules()
    const { GfsDownloadStore: Store } = await import('./gfsDownloadStore')
    const opened = new Store(hostRoot) as unknown as GfsDownloadStore
    extraStores.push(opened)
    await opened.initialize()
    return opened
  })
}

/**
 * statfs reports the real free space but a volume of `totalBytes` (block size
 * 1), so the retained budget is `floor(totalBytes * percent / 100)`.
 */
function volumeOf(totalBytes: number): void {
  statfsBoundary.mockImplementation(async (target: string) => {
    const real = await nativeFs.statfs(target, { bigint: true })
    return { ...real, bsize: 1n, blocks: BigInt(totalBytes), bavail: real.bavail * real.bsize }
  })
}

/**
 * Leaves `sizes` charged under trash names in `caller`'s store directory: the
 * copies expire and their removal fails. Eviction cannot reclaim a held
 * charge, and protected bytes are capped at half the budget per caller and three
 * quarters Host-wide, so held charges are how a test fills the budget with bytes
 * no eviction can free.
 * The rm fault stays installed for the rest of the test.
 */
async function heldTrash(
  target: GfsDownloadStore,
  caller: string,
  firstIndex: number,
  sizes: number[]
): Promise<void> {
  const root = callerDirectory(hostRoot, caller)
  for (const [offset, size] of sizes.entries())
    await completedCopy(target, root, caller, firstIndex + offset, size)
  vi.setSystemTime(Date.now() + 3 * HOUR)
  rmBoundary.mockImplementation(async (removed: string, options: unknown) => {
    const parent = path.dirname(removed)
    if (
      path.basename(parent) === '.gfs-downloads' &&
      path.basename(path.dirname(parent)) === caller &&
      path.basename(removed).startsWith('.trash-')
    )
      throw Object.assign(new Error('injected EIO'), { code: 'EIO' })
    return nativeFs.rm(removed, options as Parameters<typeof nativeFs.rm>[1])
  })
  expect((await target.cleanupExpired()).removeFailed).toBe(sizes.length)
}

/** meta.json padded with an ignored field to exactly `bytes` bytes. */
function paddedMeta(id: string, bytes: Buffer, size: number): string {
  const base = JSON.stringify({ ...metaFor(id, bytes, Date.now()), padding: '' })
  const padded = JSON.stringify({
    ...metaFor(id, bytes, Date.now()),
    padding: 'x'.repeat(size - base.length),
  })
  expect(Buffer.byteLength(padded)).toBe(size)
  return padded
}

beforeEach(async () => {
  nativeFs = await vi.importActual<typeof fs>('node:fs/promises')
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-08T10:00:00.000Z'))
  for (const boundary of [
    statfsBoundary,
    renameBoundary,
    openBoundary,
    realpathBoundary,
    rmBoundary,
  ])
    boundary.mockReset()
  rmBoundary.mockImplementation(nativeFs.rm)
  statfsBoundary.mockImplementation(freeSpaceSizedStatfs(nativeFs.statfs))
  renameBoundary.mockImplementation(nativeFs.rename)
  openBoundary.mockImplementation(nativeFs.open)
  realpathBoundary.mockImplementation(nativeFs.realpath)
  hostRoot = syncFs.mkdtempSync(path.join(tmpdir(), 'gfs-store-boundaries-'))
  rootA = callerDirectory(hostRoot, A)
  rootB = callerDirectory(hostRoot, B)
  store = new GfsDownloadStore(hostRoot)
  await store.initialize()
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  for (const opened of extraStores.splice(0)) await opened.close(0)
  await store.close(0)
  await nativeFs.rm(hostRoot, { recursive: true, force: true })
  for (const outside of outsideRoots.splice(0))
    await nativeFs.rm(outside, { recursive: true, force: true })
})

describe('GFS download store boundaries: meta.json validation', () => {
  const retention = GFS_FILE_LIMITS.retentionMs
  const cases: Array<{
    name: string
    expected: 'removed' | 'retained'
    meta: (id: string, bytes: Buffer, now: number) => Record<string, unknown> | string
  }> = [
    {
      name: 'V1: malformed JSON is incomplete',
      expected: 'removed',
      meta: () => '{"schemaVersion":',
    },
    {
      name: 'V2: meta one byte over the size limit is incomplete',
      expected: 'removed',
      meta: (id, bytes) => paddedMeta(id, bytes, META_MAX_BYTES + 1),
    },
    {
      name: 'V3: meta exactly at the size limit is retained',
      expected: 'retained',
      meta: (id, bytes) => paddedMeta(id, bytes, META_MAX_BYTES),
    },
    {
      name: 'V4: wrong schemaVersion is incomplete',
      expected: 'removed',
      meta: (id, bytes, now) => metaFor(id, bytes, now, { schemaVersion: 2 }),
    },
    {
      name: 'V5: meta id that differs from its directory is incomplete',
      expected: 'removed',
      meta: (_id, bytes, now) => metaFor(randomUUID(), bytes, now),
    },
    {
      name: 'V6: expiresAt before createdAt is incomplete',
      expected: 'removed',
      meta: (id, bytes, now) => metaFor(id, bytes, now, { expiresAt: at(now - 1) }),
    },
    {
      name: 'V7: meta exactly at the retention bound is retained',
      expected: 'retained',
      meta: (id, bytes, now) => metaFor(id, bytes, now, { expiresAt: at(now + retention) }),
    },
    {
      name: 'V8: meta past the retention bound by 1 ms is incomplete',
      expected: 'removed',
      meta: (id, bytes, now) => metaFor(id, bytes, now, { expiresAt: at(now + retention + 1) }),
    },
    {
      name: 'V9: createdAt exactly one minute ahead is retained',
      expected: 'retained',
      meta: (id, bytes, now) =>
        metaFor(id, bytes, now, { createdAt: at(now + 60_000), expiresAt: at(now + HOUR) }),
    },
    {
      name: 'V10: createdAt more than one minute ahead is incomplete',
      expected: 'removed',
      meta: (id, bytes, now) =>
        metaFor(id, bytes, now, { createdAt: at(now + 60_001), expiresAt: at(now + HOUR) }),
    },
    {
      name: 'V12: sizeBytes different from the source size is incomplete',
      expected: 'removed',
      meta: (id, bytes, now) => metaFor(id, bytes, now, { sizeBytes: bytes.byteLength - 1 }),
    },
  ]

  it.each(cases)('$name', async ({ expected, meta }) => {
    const bytes = Buffer.alloc(16, 0x31)
    const id = randomUUID()
    const planted = plantDownload(rootA, { id, bytes, meta: meta(id, bytes, Date.now()) })
    const sibling = plantComplete(rootB, B, 300, Buffer.alloc(5, 0x32))

    const swept = await store.cleanupExpired()

    // Witness: the valid sibling plant is retained and counted.
    expect(exists(sibling.directory)).toBe(true)
    const inventory = await store.debugInventory()
    expect(inventory.byCaller.get(B)).toEqual({ files: 1, bytes: 5 })
    if (expected === 'removed') {
      expect(swept.removedIncomplete).toBe(1)
      expect(exists(planted.directory)).toBe(false)
      expect(inventory.files).toBe(1)
    } else {
      expect(swept.removedIncomplete).toBe(0)
      expect(exists(planted.directory)).toBe(true)
      expect(inventory.byCaller.get(A)).toEqual({ files: 1, bytes: 16 })
    }
  })

  it('V11: sizeBytes above maxFileBytes is incomplete', async () => {
    const tooLarge = Buffer.alloc(11, 0x33)
    const atLimit = Buffer.alloc(10, 0x34)
    const over = plantComplete(rootA, A, 301, tooLarge)
    const kept = plantComplete(rootB, B, 302, atLimit)
    const limited = await limitedStore({ MCP_HOST_GFS_MAX_FILE_BYTES: '10' })

    expect(exists(over.directory)).toBe(false)
    // Witness: the copy exactly at maxFileBytes is retained.
    expect(exists(kept.directory)).toBe(true)
    expect((await limited.debugInventory()).files).toBe(1)
  })

  it('V13: an adopted entry with non-private modes is counted but never served', async () => {
    const bytes = Buffer.alloc(12, 0x35)
    const id = randomUUID()
    const planted = plantDownload(rootB, {
      id,
      bytes,
      meta: metaFor(id, bytes, Date.now(), { callerIdentity: B, source: sourceFor(303) }),
      directoryMode: 0o755,
      sourceMode: 0o644,
    })
    await store.cleanupExpired()

    expect((await store.debugInventory()).byCaller.get(B)).toEqual({ files: 1, bytes: 12 })
    await expect(store.reusableReceipt(B, sourceFor(303), 12)).resolves.toBeUndefined()
    await expect(store.readManagedFile(receiptPathOf(id), B)).rejects.toMatchObject({
      code: 'download_missing',
    })
    // Neither path touched it: an adopted copy is only counted and swept.
    expect(exists(planted.sourcePath)).toBe(true)
    expect(syncFs.statSync(planted.sourcePath).mode & 0o777).toBe(0o644)
  })

  it('V14: a published copy with non-private modes is not reused or read', async () => {
    const reused = await completedCopy(store, rootA, A, 304, 8)
    const reusedDirectory = downloadDirectory(rootA, reused.receipt.id)
    syncFs.chmodSync(path.join(reusedDirectory, 'source'), 0o644)
    await expect(store.reusableReceipt(A, sourceFor(304), 8)).resolves.toBeUndefined()
    // Witness: the reuse path opened the copy and removed it.
    expect(exists(reusedDirectory)).toBe(false)

    const read = await completedCopy(store, rootA, A, 305, 8)
    const readDirectory = downloadDirectory(rootA, read.receipt.id)
    syncFs.chmodSync(readDirectory, 0o755)
    await expect(store.readManagedFile(read.receipt.path, A)).rejects.toMatchObject({
      code: 'download_missing',
    })
    syncFs.chmodSync(readDirectory, 0o700)
    // Control: with the private mode back, the same read serves the bytes.
    await expect(store.readManagedFile(read.receipt.path, A)).resolves.toEqual(read.bytes)
  })

  it('V15: an admission past the retention window is refused', async () => {
    const now = Date.now()
    await expect(
      startTransfer(store, rootA, A, 306, 4, {
        expiresAt: at(now + GFS_FILE_LIMITS.retentionMs + 1),
      })
    ).rejects.toThrow(RangeError)
    const admitted = await startTransfer(store, rootA, A, 306, 4, {
      expiresAt: at(now + GFS_FILE_LIMITS.retentionMs),
    })
    expect(admitted.transfer.expiresAt).toBe(at(now + GFS_FILE_LIMITS.retentionMs))
  })
})

describe('GFS download store boundaries: quota and capacity', () => {
  it('Q1: retained bytes exactly at the volume budget are admitted and one byte more is refused', async () => {
    // Budget 20; protected bytes are capped at 10. caller-e holds 11 bytes
    // under trash names, A and B pin 4 and 5, and the refused byte from C
    // stays within the protected cap, so only the budget can refuse it.
    volumeOf(20)
    const limited = await limitedStore(SMALL_FILES_FULL_VOLUME)
    await heldTrash(limited, 'caller-e', 313, [6, 5])
    await completedCopy(limited, rootA, A, 310, 4, { owner: 'task-q1' })
    const denied = await quotaCount('host', 'storage_bytes')

    const atBudget = await completedCopy(limited, rootB, B, 311, 5, { owner: 'task-q1' })
    expect(await quotaCount('host', 'storage_bytes')).toBe(denied)
    await expect(limited.readManagedFile(atBudget.receipt.path, B)).resolves.toEqual(atBudget.bytes)

    const rootC = callerDirectory(hostRoot, 'caller-c')
    await expect(startTransfer(limited, rootC, 'caller-c', 312, 1)).rejects.toMatchObject({
      code: 'host_quota_exceeded',
    })
    expect(await quotaCount('host', 'storage_bytes')).toBe(denied + 1)
  })

  it('Q2: there is no retained-file limit: one caller keeps 65 copies and only bytes refuse', async () => {
    // 65 one-byte copies: more than the removed 8-per-caller and 64-per-Host limits.
    // A caller's protected bytes are capped at half the budget, so the budget is 132: A
    // pins 65 bytes and its 66th byte stays within the 66, while B holds 67
    // bytes (six 10-byte copies, the file limit, and 7) under trash names.
    const files = 65
    volumeOf(132)
    const limited = await limitedStore(SMALL_FILES_FULL_VOLUME)
    await heldTrash(limited, B, 500, [10, 10, 10, 10, 10, 10, 7])
    const denied = await quotaCount('host', 'storage_bytes')
    for (let index = 0; index < files; index += 1)
      await completedCopy(limited, rootA, A, 400 + index, 1, { owner: 'task-q2' })
    expect((await limited.debugInventory()).byCaller.get(A)).toEqual({ files, bytes: files })
    expect(await quotaCount('host', 'storage_bytes')).toBe(denied)

    // Every copy is pinned or held, so the byte budget is the only thing that can refuse.
    await expect(startTransfer(limited, rootA, A, 400 + files, 1)).rejects.toMatchObject({
      code: 'host_quota_exceeded',
    })
    expect(await quotaCount('host', 'storage_bytes')).toBe(denied + 1)
    // 65 real publications: the timeout is explicit rather than the 5 s
    // default that a loaded machine can exceed.
  }, 60_000)

  it('Q3: Host bytes exactly at the budget are admitted and one byte more is refused', async () => {
    // Budget 30; protected bytes are capped at 15. caller-e holds 16 bytes
    // under trash names and B, C and A pin 14 between them.
    volumeOf(30)
    const limited = await limitedStore(SMALL_FILES_FULL_VOLUME)
    await heldTrash(limited, 'caller-e', 320, [8, 8])
    const rootC = callerDirectory(hostRoot, 'caller-c')
    await completedCopy(limited, rootB, B, 316, 5, { owner: 'task-b' })
    await completedCopy(limited, rootC, 'caller-c', 317, 4, { owner: 'task-c' })
    const denied = await quotaCount('host', 'storage_bytes')

    await completedCopy(limited, rootA, A, 318, 5, { owner: 'task-a' })
    expect(await quotaCount('host', 'storage_bytes')).toBe(denied)

    const rootD = callerDirectory(hostRoot, 'caller-d')
    await expect(startTransfer(limited, rootD, 'caller-d', 319, 1)).rejects.toMatchObject({
      code: 'host_quota_exceeded',
    })
    expect(await quotaCount('host', 'storage_bytes')).toBe(denied + 1)
  })

  it('Q5: free space exactly at the threshold is admitted and one byte less is refused', async () => {
    const observed = await nativeFs.statfs(hostRoot, { bigint: true })
    const size = 100
    // A 1 GiB volume (block size 1): the free-space floor is
    // floor(2^30 * 15 / 100) = 161061273 bytes, above its 16 MiB minimum.
    const blocks = 2n ** 30n
    const threshold = BigInt(size) + 161_061_273n
    statfsBoundary.mockResolvedValue({ ...observed, bsize: 1n, blocks, bavail: threshold - 1n })
    const denied = await quotaCount('host', 'free_space')

    await expect(startTransfer(store, rootA, A, 320, size)).rejects.toMatchObject({
      code: 'disk_full',
    })
    expect(await quotaCount('host', 'free_space')).toBe(denied + 1)

    statfsBoundary.mockResolvedValue({ ...observed, bsize: 1n, blocks, bavail: threshold })
    await expect(startTransfer(store, rootA, A, 320, size)).resolves.toBeDefined()
    expect(await quotaCount('host', 'free_space')).toBe(denied + 1)
  })

  it('Q6: a statfs failure refuses that admission loudly and the next one succeeds', async () => {
    statfsBoundary.mockRejectedValueOnce(Object.assign(new Error('injected EIO'), { code: 'EIO' }))
    // Startup already measured the volume once to restore the free-space floor.
    const measured = statfsBoundary.mock.calls.length

    await expect(startTransfer(store, rootA, A, 321, 4)).rejects.toMatchObject({ code: 'EIO' })
    expect(statfsBoundary).toHaveBeenCalledTimes(measured + 1)

    // The caller's single concurrency slot was not kept by the failed admission.
    const next = await completedCopy(store, rootA, A, 321, 4)
    await expect(store.readManagedFile(next.receipt.path, A)).resolves.toEqual(next.bytes)
  })

  it('Q7: a zero-byte file publishes, reads, reuses and has an empty prefix', async () => {
    const { receipt } = await completedCopy(store, rootA, A, 322, 0)

    expect(receipt.sha256).toBe(digestOf(Buffer.alloc(0)))
    await expect(store.readManagedFile(receipt.path, A)).resolves.toEqual(Buffer.alloc(0))
    await expect(store.readManagedFilePrefix(receipt.path, A)).resolves.toEqual(Buffer.alloc(0))
    await expect(store.reusableReceipt(A, sourceFor(322), 0)).resolves.toMatchObject({
      id: receipt.id,
    })
  })

  it('Q9: Host eviction takes adopted copies before any published copy', async () => {
    volumeOf(30)
    const limited = await limitedStore(SMALL_FILES_FULL_VOLUME)
    const published = await completedCopy(limited, rootB, B, 323, 10)
    tick()
    const rootC = callerDirectory(hostRoot, 'caller-c')
    const adopted = plantComplete(rootC, 'caller-c', 324, Buffer.alloc(10, 0x36))
    tick()
    await completedCopy(limited, rootA, A, 325, 10)
    tick()

    // The Host would reach 35 of 30.
    await startTransfer(limited, rootA, A, 326, 5)

    expect(exists(adopted.directory)).toBe(false)
    // Witness: the older published copy of another caller stays.
    expect(exists(downloadDirectory(rootB, published.receipt.id))).toBe(true)
  })

  it("Q10: an admission evicts adopted copies in any caller's directory before its own published copies", async () => {
    volumeOf(15)
    const limited = await limitedStore(SMALL_FILES_FULL_VOLUME)
    const published = await completedCopy(limited, rootA, A, 327, 5)
    tick()
    const adopted = plantComplete(rootA, A, 328, Buffer.alloc(5, 0x37))
    const foreign = plantComplete(rootB, B, 329, Buffer.alloc(5, 0x38))
    tick()

    // 5 + 5 + 5 + 7 against 15: both adopted copies go, whoever's directory
    // holds them. 7 is the most A may protect: floor(15 / 2).
    await startTransfer(limited, rootA, A, 330, 7)

    expect(exists(adopted.directory)).toBe(false)
    expect(exists(foreign.directory)).toBe(false)
    // Witness: the published copy, older than both, stays.
    expect(exists(downloadDirectory(rootA, published.receipt.id))).toBe(true)
  })

  it('Q11: published copies are evicted least recently used first', async () => {
    volumeOf(15)
    const limited = await limitedStore(SMALL_FILES_FULL_VOLUME)
    const older = await completedCopy(limited, rootA, A, 331, 5)
    tick()
    const newer = await completedCopy(limited, rootA, A, 332, 5)
    tick()
    await expect(limited.reusableReceipt(A, sourceFor(331), 5)).resolves.toMatchObject({
      id: older.receipt.id,
    })
    tick()

    // 5 + 5 + 7 against 15: one copy goes. 7 is the most A may protect: floor(15 / 2).
    await startTransfer(limited, rootA, A, 333, 7)

    expect(exists(downloadDirectory(rootA, newer.receipt.id))).toBe(false)
    expect(exists(downloadDirectory(rootA, older.receipt.id))).toBe(true)
  })

  it('Q12: when pins fill the Host protected cap admission fails with the quota code and succeeds after release', async () => {
    // Budget 15; protected bytes are capped at 7 per caller and 11 Host-wide.
    // Two loose copies and the pins of B (6) and C (5) fill the budget, and
    // A's 1 byte would bring the protected bytes to 12: the Host-wide cap
    // refuses it before any eviction. The loose copies come first: an open
    // reservation counts as protected too.
    volumeOf(15)
    const limited = await limitedStore(SMALL_FILES_FULL_VOLUME)
    const rootD = callerDirectory(hostRoot, 'caller-d')
    const loose = await completedCopy(limited, rootD, 'caller-d', 337, 2)
    tick()
    const looseNewer = await completedCopy(limited, rootD, 'caller-d', 338, 2)
    tick()
    const pinned = await completedCopy(limited, rootB, B, 334, 6, { owner: 'task-q12' })
    tick()
    const rootC = callerDirectory(hostRoot, 'caller-c')
    await completedCopy(limited, rootC, 'caller-c', 336, 5, { owner: 'task-q12' })
    const directory = downloadDirectory(rootB, pinned.receipt.id)
    const denied = await quotaCount('host', 'protected_bytes')

    await expect(startTransfer(limited, rootA, A, 335, 1)).rejects.toMatchObject({
      code: 'host_quota_exceeded',
    })
    expect(await quotaCount('host', 'protected_bytes')).toBe(denied + 1)
    // Nothing was evicted for the refused admission.
    expect(exists(downloadDirectory(rootD, loose.receipt.id))).toBe(true)
    expect(exists(downloadDirectory(rootD, looseNewer.receipt.id))).toBe(true)

    await limited.releaseReceiptOwner('task-q12', B)
    await expect(startTransfer(limited, rootA, A, 335, 1)).resolves.toBeDefined()
    // Witness: the admitted byte needed one eviction, and it took the oldest
    // loose copy.
    expect(exists(downloadDirectory(rootD, loose.receipt.id))).toBe(false)
    expect(exists(downloadDirectory(rootD, looseNewer.receipt.id))).toBe(true)
    expect(exists(directory)).toBe(true)
    expect(await quotaCount('host', 'protected_bytes')).toBe(denied + 1)
  })
})

describe('GFS download store boundaries: expiry', () => {
  async function expiringCopy(index: number) {
    const expiresAtMs = Date.now() + 2 * HOUR
    const copy = await completedCopy(store, rootA, A, index, 8, { expiresAt: at(expiresAtMs) })
    return { ...copy, expiresAtMs, directory: downloadDirectory(rootA, copy.receipt.id) }
  }

  it('E1: reuse matches until one millisecond before the copy has one hour left', async () => {
    const copy = await expiringCopy(340)
    vi.setSystemTime(copy.expiresAtMs - HOUR - 1)
    await expect(store.reusableReceipt(A, sourceFor(340), 8)).resolves.toMatchObject({
      id: copy.receipt.id,
    })
    for (const instant of [copy.expiresAtMs - HOUR, copy.expiresAtMs - 1, copy.expiresAtMs]) {
      vi.setSystemTime(instant)
      await expect(store.reusableReceipt(A, sourceFor(340), 8)).resolves.toBeUndefined()
    }
    // Witness: a miss inside the last hour leaves the copy readable until it expires.
    vi.setSystemTime(copy.expiresAtMs - 1)
    await expect(store.readManagedFile(copy.receipt.path, A)).resolves.toEqual(copy.bytes)
  })

  it('E2: a managed read succeeds until one millisecond before expiry', async () => {
    const copy = await expiringCopy(341)
    vi.setSystemTime(copy.expiresAtMs - 1)
    await expect(store.readManagedFile(copy.receipt.path, A)).resolves.toEqual(copy.bytes)
    for (const instant of [copy.expiresAtMs, copy.expiresAtMs + 1]) {
      vi.setSystemTime(instant)
      await expect(store.readManagedFile(copy.receipt.path, A)).rejects.toMatchObject({
        code: 'download_expired',
      })
    }
  })

  it('E2b: a managed prefix read succeeds until one millisecond before expiry', async () => {
    const copy = await expiringCopy(343)
    vi.setSystemTime(copy.expiresAtMs - 1)
    await expect(store.readManagedFilePrefix(copy.receipt.path, A, 4)).resolves.toEqual(
      copy.bytes.subarray(0, 4)
    )
    for (const instant of [copy.expiresAtMs, copy.expiresAtMs + 1]) {
      vi.setSystemTime(instant)
      await expect(store.readManagedFilePrefix(copy.receipt.path, A, 4)).rejects.toMatchObject({
        code: 'download_expired',
      })
    }
  })

  it('E3: the sweep removes a copy exactly at its expiry', async () => {
    const copy = await expiringCopy(342)
    await expect(store.cleanupExpired(copy.expiresAtMs - 1)).resolves.toMatchObject({
      removedExpired: 0,
    })
    expect(exists(copy.directory)).toBe(true)
    await expect(store.cleanupExpired(copy.expiresAtMs)).resolves.toMatchObject({
      removedExpired: 1,
    })
    expect(exists(copy.directory)).toBe(false)
  })
})

describe('GFS download store boundaries: in-process concurrency', () => {
  it('C1: two concurrent downloads of one source by one caller both publish and reuse returns one of them', async () => {
    const limited = await limitedStore({ MCP_HOST_GFS_CALLER_DOWNLOAD_CONCURRENCY: '2' })
    const [first, second] = await Promise.all([
      completedCopy(limited, rootA, A, 350, 6),
      completedCopy(limited, rootA, A, 350, 6),
    ])

    expect(first.receipt.id).not.toBe(second.receipt.id)
    expect((await limited.debugInventory()).byCaller.get(A)).toEqual({ files: 2, bytes: 12 })
    const reused = await limited.reusableReceipt(A, sourceFor(350), 6)
    expect([first.receipt.id, second.receipt.id]).toContain(reused?.id)
  })

  it('C2: two callers downloading one source each reuse their own copy', async () => {
    const [own, other] = await Promise.all([
      completedCopy(store, rootA, A, 351, 6),
      completedCopy(store, rootB, B, 351, 6),
    ])

    await expect(store.reusableReceipt(A, sourceFor(351), 6)).resolves.toMatchObject({
      id: own.receipt.id,
    })
    await expect(store.reusableReceipt(B, sourceFor(351), 6)).resolves.toMatchObject({
      id: other.receipt.id,
    })
  })

  it('C3: a sweep during an active transfer leaves its partial file alone', async () => {
    const { transfer, bytes } = await startTransfer(store, rootA, A, 352, 12)
    const stale = plantDownload(rootB, { bytes: Buffer.alloc(3), meta: 'omit' })

    // Witness: the same sweep removed the unrelated incomplete directory.
    await expect(store.cleanupExpired()).resolves.toMatchObject({ removedIncomplete: 1 })

    expect(exists(stale.directory)).toBe(false)
    expect(exists(path.join(rootA, transfer.partialPath))).toBe(true)
    const receipt = await store.publish(transfer.id, A, digestOf(bytes))
    await expect(store.readManagedFile(receipt.path, A)).resolves.toEqual(bytes)
  })

  it('C4: a sweep requested during publication runs after it and keeps the copy', async () => {
    const { transfer, bytes } = await startTransfer(store, rootA, A, 353, 12)
    const source = path.join(downloadDirectory(rootA, transfer.id), 'source')
    // The private sweep is observed, not replaced: it records whether the
    // publication had finished when the sweep actually started.
    const internals = store as unknown as { sweep: (now: number) => Promise<unknown> }
    const realSweep = internals.sweep.bind(store)
    const sourceAtSweepStart: boolean[] = []
    vi.spyOn(internals, 'sweep').mockImplementation(async (now: number) => {
      sourceAtSweepStart.push(exists(source))
      return realSweep(now)
    })
    let sweep: ReturnType<GfsDownloadStore['cleanupExpired']> | undefined
    renameBoundary.mockImplementation(async (from: string, to: string) => {
      await nativeFs.rename(from, to)
      // Between the two renames: meta.json is visible, source is not yet.
      if (path.basename(to) === 'meta.json') sweep = store.cleanupExpired()
    })

    const receipt = await store.publish(transfer.id, A, digestOf(bytes))

    expect(sweep).toBeDefined()
    await expect(sweep).resolves.toMatchObject({ removedIncomplete: 0, removedExpired: 0 })
    // Witness: the requested sweep ran once, after source was in place.
    expect(sourceAtSweepStart).toEqual([true])
    await expect(store.readManagedFile(receipt.path, A)).resolves.toEqual(bytes)
  })

  it('C5: close requested during publication waits for it', async () => {
    const { transfer, bytes } = await startTransfer(store, rootA, A, 354, 12)
    let closing: Promise<void> | undefined
    let closed = false
    let closedAtSourceRename: boolean | undefined
    renameBoundary.mockImplementation(async (from: string, to: string) => {
      if (path.basename(to) === 'source') closedAtSourceRename = closed
      await nativeFs.rename(from, to)
      if (path.basename(to) === 'meta.json')
        closing = store.close(5_000).then(() => {
          closed = true
        })
    })

    const receipt = await store.publish(transfer.id, A, digestOf(bytes))
    expect(closing).toBeDefined()
    await closing

    // Witness: the last rename of the publication ran before close resolved.
    expect(closedAtSourceRename).toBe(false)

    expect(store.isAvailable()).toBe(false)
    expect(syncFs.readFileSync(path.join(rootA, receipt.path))).toEqual(bytes)
  })

  // R3-M1: work accepted while close() waits replaces the mutation tail; close
  // must wait for the new tail too, and still return at its deadline.
  function blockSweeps(target: GfsDownloadStore) {
    const internals = target as unknown as { sweep: (now: number) => Promise<unknown> }
    const realSweep = internals.sweep.bind(target)
    const started: number[] = []
    const releases: Array<() => void> = []
    const finished: number[] = []
    vi.spyOn(internals, 'sweep').mockImplementation(async (now: number) => {
      const index = started.length
      started.push(index)
      await new Promise<void>(resolve => releases.push(resolve))
      const result = await realSweep(now)
      finished.push(index)
      return result
    })
    return { started, releases, finished }
  }

  it('C5b: close waits for a sweep accepted while it was already waiting', async () => {
    const sweeps = blockSweeps(store)
    const first = store.cleanupExpired()
    await vi.waitFor(() => expect(sweeps.started).toEqual([0]))
    let closed = false
    const closing = store.close(5_000).then(() => {
      closed = true
    })
    // close() is already waiting on the first sweep's tail when this arrives.
    await new Promise(resolve => setTimeout(resolve, 10))
    const second = store.cleanupExpired()

    sweeps.releases[0]!()
    await first
    // Witness: the second sweep started, so the first tail had resolved.
    await vi.waitFor(() => expect(sweeps.started).toEqual([0, 1]))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(closed).toBe(false)

    sweeps.releases[1]!()
    await second
    await closing
    expect(sweeps.finished).toEqual([0, 1])
    expect(store.isAvailable()).toBe(false)
  })

  it('C5c: close still returns at its deadline when an accepted sweep never finishes', async () => {
    const sweeps = blockSweeps(store)
    const stuck = store.cleanupExpired()
    await vi.waitFor(() => expect(sweeps.started).toEqual([0]))
    const startedAt = performance.now()

    await store.close(100)

    const elapsed = performance.now() - startedAt
    expect(elapsed).toBeGreaterThanOrEqual(90)
    expect(elapsed).toBeLessThan(2_000)
    // Witness: the sweep was still blocked when close returned.
    expect(sweeps.finished).toEqual([])
    expect(store.isAvailable()).toBe(false)
    sweeps.releases[0]!()
    await expect(stuck).resolves.toMatchObject({ removedExpired: 0 })
  })

  it('C7: fail() after a partial write removes the directory and releases the reservation', async () => {
    const { transfer } = await startTransfer(store, rootA, A, 355, 12)
    const directory = downloadDirectory(rootA, transfer.id)
    syncFs.truncateSync(path.join(rootA, transfer.partialPath), 5)

    await store.fail(transfer.id, A)

    expect(exists(directory)).toBe(false)
    const next = await completedCopy(store, rootA, A, 355, 12)
    await expect(store.readManagedFile(next.receipt.path, A)).resolves.toEqual(next.bytes)
  })

  it('C8: fail() after publish is refused and the copy stays readable', async () => {
    const { receipt, bytes } = await completedCopy(store, rootA, A, 356, 12)

    await expect(store.fail(receipt.id, A)).rejects.toMatchObject({ code: 'download_busy' })

    await expect(store.readManagedFile(receipt.path, A)).resolves.toEqual(bytes)
  })
})

describe('GFS download store boundaries: integrity', () => {
  const damage = {
    truncated: (source: string) => syncFs.truncateSync(source, 7),
    'replaced by a directory': (source: string) => {
      syncFs.rmSync(source)
      syncFs.mkdirSync(source, { mode: 0o700 })
    },
  }

  it.each([
    { name: 'I2: truncated source on reuse', kind: 'truncated' as const },
    {
      name: 'I4: source replaced by a directory on reuse',
      kind: 'replaced by a directory' as const,
    },
  ])('$name', async ({ kind }) => {
    const { receipt } = await completedCopy(store, rootA, A, 360, 8)
    const directory = downloadDirectory(rootA, receipt.id)
    damage[kind](path.join(directory, 'source'))

    await expect(store.reusableReceipt(A, sourceFor(360), 8)).resolves.toBeUndefined()

    expect(exists(directory)).toBe(false)
    const fresh = await completedCopy(store, rootA, A, 360, 8)
    expect(fresh.receipt.id).not.toBe(receipt.id)
  })

  it.each([
    { name: 'I3: truncated source on managed read', kind: 'truncated' as const },
    {
      name: 'I5: source replaced by a directory on managed read',
      kind: 'replaced by a directory' as const,
    },
  ])('$name', async ({ kind }) => {
    const { receipt } = await completedCopy(store, rootA, A, 361, 8)
    const directory = downloadDirectory(rootA, receipt.id)
    damage[kind](path.join(directory, 'source'))

    await expect(store.readManagedFile(receipt.path, A)).rejects.toBeInstanceOf(
      GfsDownloadStoreError
    )
    await expect(store.readManagedFile(receipt.path, A)).rejects.toMatchObject({
      code: 'download_missing',
    })
    await expect(store.readManagedFilePrefix(receipt.path, A)).rejects.toMatchObject({
      code: 'download_missing',
    })

    await expect(store.cleanupExpired()).resolves.toMatchObject({ removedIncomplete: 1 })
    expect(exists(directory)).toBe(false)
  })
})

/** Everything a caller can observe about a rejection, minus the stack. */
async function rejectionOf(operation: Promise<unknown>): Promise<Record<string, unknown>> {
  const error = await operation.then(
    () => {
      throw new Error('expected a rejection')
    },
    (rejection: unknown) => rejection
  )
  if (!(error instanceof Error)) throw new Error('expected an Error rejection')
  const fields = Object.getOwnPropertyNames(error).filter(name => name !== 'stack')
  return {
    constructor: error.constructor,
    fields: Object.fromEntries(
      fields.map(name => [name, (error as unknown as Record<string, unknown>)[name]])
    ),
    name: error.name,
    message: error.message,
  }
}

function opensUnder(id: string): number {
  return openBoundary.mock.calls.filter(([target]) => String(target).includes(id)).length
}

describe('GFS download store boundaries: caller isolation', () => {
  const reads = {
    readManagedFile: (target: GfsDownloadStore, receiptPath: string, caller: string) =>
      target.readManagedFile(receiptPath, caller),
    readManagedFilePrefix: (target: GfsDownloadStore, receiptPath: string, caller: string) =>
      target.readManagedFilePrefix(receiptPath, caller, 4),
  } as const

  it.each(Object.keys(reads) as Array<keyof typeof reads>)(
    "U1: %s answers another caller's copy exactly like a nonexistent one, without opening it",
    async api => {
      const { receipt, bytes } = await completedCopy(store, rootA, A, 70, 8)
      openBoundary.mockClear()
      const foreign = await rejectionOf(reads[api](store, receipt.path, B))
      const missing = await rejectionOf(reads[api](store, receiptPathOf(randomUUID()), B))

      expect(foreign).toStrictEqual(missing)
      expect(foreign).toMatchObject({ fields: { code: 'download_missing' } })
      expect(String(foreign.message)).not.toContain(receipt.id)
      expect(opensUnder(receipt.id)).toBe(0)
      // Witness: the owner reads the same path, and that read opens the copy.
      const owned = await reads[api](store, receipt.path, A)
      expect(owned).toEqual(api === 'readManagedFile' ? bytes : bytes.subarray(0, 4))
      expect(opensUnder(receipt.id)).toBeGreaterThan(0)
    }
  )

  it.each(Object.keys(reads) as Array<keyof typeof reads>)(
    'U1b: %s refuses an adopted copy recorded for the same caller from the index, before touching its directory',
    async api => {
      // Planted with this caller's identity, so only the provenance check in
      // the index lookup can refuse it before the disk is reached.
      const planted = plantComplete(rootA, A, 72, Buffer.alloc(8, 7))
      await store.cleanupExpired()
      const published = await completedCopy(store, rootA, A, 73, 8)
      openBoundary.mockClear()
      realpathBoundary.mockClear()

      await expect(reads[api](store, receiptPathOf(planted.id), A)).rejects.toMatchObject({
        code: 'download_missing',
      })

      expect(opensUnder(planted.id)).toBe(0)
      expect(realpathBoundary).not.toHaveBeenCalled()
      // Witness: the planted copy is indexed as adopted for this caller, and
      // the published copy read through the same API opens its source.
      const index = (store as unknown as { entries: Map<string, Record<string, unknown>> }).entries
      expect(index.get(planted.id)).toMatchObject({ provenance: 'adopted', callerIdentity: A })
      const owned = await reads[api](store, published.receipt.path, A)
      expect(owned).toEqual(
        api === 'readManagedFile' ? published.bytes : published.bytes.subarray(0, 4)
      )
      expect(opensUnder(published.receipt.id)).toBeGreaterThan(0)
      expect(realpathBoundary).toHaveBeenCalled()
    }
  )

  it('U2: an expired copy of another caller is still answered as nonexistent, not as expired', async () => {
    const { receipt } = await completedCopy(store, rootA, A, 71, 8)
    vi.setSystemTime(Date.parse(receipt.expiresAt))

    const foreign = await rejectionOf(store.readManagedFile(receipt.path, B))
    const missing = await rejectionOf(store.readManagedFile(receiptPathOf(randomUUID()), B))

    expect(foreign).toStrictEqual(missing)
    // Witness: the owner sees the expiry.
    await expect(store.readManagedFile(receipt.path, A)).rejects.toMatchObject({
      code: 'download_expired',
    })
  })

  it("U3: publish and fail answer another caller's transfer exactly like an unknown id", async () => {
    const { transfer, bytes } = await startTransfer(store, rootA, A, 72, 8)
    const sha256 = digestOf(bytes)

    expect(await rejectionOf(store.publish(transfer.id, B, sha256))).toStrictEqual(
      await rejectionOf(store.publish(randomUUID(), B, sha256))
    )
    expect(await rejectionOf(store.fail(transfer.id, B))).toStrictEqual(
      await rejectionOf(store.fail(randomUUID(), B))
    )
    // Witness: the transfer was live and still publishes for its owner.
    const receipt = await store.publish(transfer.id, A, sha256)
    expect(receipt.id).toBe(transfer.id)
    expect(await rejectionOf(store.publish(transfer.id, B, sha256))).toStrictEqual(
      await rejectionOf(store.publish(randomUUID(), B, sha256))
    )
    expect(await rejectionOf(store.fail(transfer.id, B))).toStrictEqual(
      await rejectionOf(store.fail(randomUUID(), B))
    )
  })

  // Expiry no longer observes pins (Addendum 10): that B's release leaves A's
  // pin under the same owner id in place is proven against the
  // protected-bytes cap in gfsDownloadStoreProtected.test.ts.
  it('U4: an owner id another caller pins is not refused, and releasing it twice is a no-op', async () => {
    const pinnedA = await completedCopy(store, rootA, A, 73, 8, { owner: 'task-73' })
    const pinnedB = await completedCopy(store, rootB, B, 74, 8, { owner: 'task-73' })
    const reused = await store.reusableReceipt(B, sourceFor(74), 8, { retentionOwnerId: 'task-73' })
    expect(reused?.id).toBe(pinnedB.receipt.id)

    await expect(store.releaseReceiptOwner('task-73', B)).resolves.toBeUndefined()
    await expect(store.releaseReceiptOwner('task-73', B)).resolves.toBeUndefined()
    // A release only unpins: both copies stay readable by their callers.
    await expect(store.readManagedFile(pinnedA.receipt.path, A)).resolves.toEqual(pinnedA.bytes)
    await expect(store.readManagedFile(pinnedB.receipt.path, B)).resolves.toEqual(pinnedB.bytes)
  })
})

/**
 * Replaces `users/<B>` by a symlink to a directory outside the Host root the
 * first time the store's realpath of `suffix` returns: the check has passed,
 * the use has not happened yet.
 */
function swapAfterCheck(suffix: string, outside: string): { swapped: () => boolean } {
  let swapped = false
  realpathBoundary.mockImplementation(async (target: string) => {
    const real = await nativeFs.realpath(target)
    if (!swapped && String(target).endsWith(suffix)) {
      swapped = true
      syncFs.renameSync(rootB, `${rootB}-moved`)
      syncFs.symlinkSync(outside, rootB)
    }
    return real
  })
  return { swapped: () => swapped }
}

function outsideDirectory(): string {
  const outside = syncFs.mkdtempSync(path.join(tmpdir(), 'gfs-store-swap-'))
  outsideRoots.push(outside)
  return outside
}

describe('GFS download store boundaries: path swapped between check and use', () => {
  it('K1: a removal whose parent is swapped after the check renames back and touches nothing outside', async () => {
    const { receipt, bytes } = await completedCopy(store, rootB, B, 80, 8)
    const outside = outsideDirectory()
    const decoy = plantDownload(outside, {
      id: receipt.id,
      bytes,
      meta: metaFor(receipt.id, bytes, Date.now(), { callerIdentity: B, source: sourceFor(80) }),
    })
    const failed = await expiryCount('remove_failed')
    const warn = vi.spyOn(logger, 'warn')
    const swap = swapAfterCheck(`/users/${B}/.gfs-downloads`, outside)
    renameBoundary.mockClear()

    await expect(store.cleanupExpired(Date.parse(receipt.expiresAt))).resolves.toMatchObject({
      removedExpired: 0,
      removeFailed: 1,
    })

    // Witness: the swap happened after the check and the trash rename was reached.
    expect(swap.swapped()).toBe(true)
    const renames = renameBoundary.mock.calls.map(([, to]) => path.basename(String(to)))
    expect(renames.some(name => name.startsWith('.trash-'))).toBe(true)
    expect(await expiryCount('remove_failed')).toBe(failed + 1)
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ component: 'GfsDownloadStore', code: 'workspace_unavailable' }),
      expect.stringContaining('could not remove')
    )
    expect(syncFs.readFileSync(decoy.sourcePath)).toEqual(bytes)
    expect(syncFs.readdirSync(path.dirname(decoy.directory))).toEqual([`input-${receipt.id}`])
  })

  it('K2: a publication whose caller directory is swapped after the check writes nothing outside', async () => {
    const { transfer, bytes } = await startTransfer(store, rootB, B, 81, 8)
    const outside = outsideDirectory()
    const decoy = downloadDirectory(outside, transfer.id)
    syncFs.mkdirSync(decoy, { recursive: true, mode: 0o700 })
    syncFs.chmodSync(path.dirname(decoy), 0o700)
    syncFs.writeFileSync(path.join(decoy, 'source.partial'), bytes, { mode: 0o600 })
    const swap = swapAfterCheck(`/users/${B}`, outside)
    openBoundary.mockClear()

    await expect(store.publish(transfer.id, B, digestOf(bytes))).rejects.toMatchObject({
      code: 'workspace_unavailable',
    })

    // Witness: the swap happened and the store opened the decoy's partial.
    expect(swap.swapped()).toBe(true)
    const opened = openBoundary.mock.calls.map(([target]) => String(target))
    expect(opened.some(target => target.endsWith(`input-${transfer.id}/source.partial`))).toBe(true)
    expect(syncFs.readdirSync(decoy)).toEqual(['source.partial'])
    expect(syncFs.readFileSync(path.join(decoy, 'source.partial'))).toEqual(bytes)
  })

  it('K2b: a caller directory swapped between the meta.json rename and the source rename publishes nothing', async () => {
    const { transfer, bytes } = await startTransfer(store, rootB, B, 83, 8)
    const outside = outsideDirectory()
    const decoy = downloadDirectory(outside, transfer.id)
    syncFs.mkdirSync(decoy, { recursive: true, mode: 0o700 })
    syncFs.chmodSync(path.dirname(decoy), 0o700)
    const decoyBytes = Buffer.alloc(8, 0x6d)
    syncFs.writeFileSync(path.join(decoy, 'source.partial'), decoyBytes, { mode: 0o600 })
    let swapped = false
    renameBoundary.mockImplementation(async (from: string, to: string) => {
      await nativeFs.rename(from, to)
      if (!swapped && path.basename(String(to)) === 'meta.json') {
        swapped = true
        syncFs.renameSync(rootB, `${rootB}-moved`)
        syncFs.symlinkSync(outside, rootB)
      }
    })

    await expect(store.publish(transfer.id, B, digestOf(bytes))).rejects.toMatchObject({
      code: 'workspace_unavailable',
    })

    // Witness: meta.json was renamed into place, then the swap happened.
    expect(swapped).toBe(true)
    const targets = renameBoundary.mock.calls.map(([, to]) => path.basename(String(to)))
    expect(targets).toContain('meta.json')
    expect(targets).not.toContain('source')
    // The swap target is untouched and the real directory holds no source.
    expect(syncFs.readdirSync(decoy)).toEqual(['source.partial'])
    expect(syncFs.readFileSync(path.join(decoy, 'source.partial'))).toEqual(decoyBytes)
    const moved = downloadDirectory(`${rootB}-moved`, transfer.id)
    expect(syncFs.readdirSync(moved).sort()).toEqual(['meta.json', 'source.partial'])
  })

  it('K3: a read whose caller directory is swapped after the check serves nothing from outside', async () => {
    const { receipt, bytes } = await completedCopy(store, rootB, B, 82, 8)
    // Witness: the owner's read works before the swap.
    await expect(store.readManagedFilePrefix(receipt.path, B, 4)).resolves.toEqual(
      bytes.subarray(0, 4)
    )
    const outside = outsideDirectory()
    const foreignBytes = Buffer.alloc(8, 0x5c)
    const decoy = plantDownload(outside, {
      id: receipt.id,
      bytes: foreignBytes,
      meta: metaFor(receipt.id, foreignBytes, Date.now(), { callerIdentity: B }),
    })
    const swap = swapAfterCheck(`/users/${B}`, outside)
    openBoundary.mockClear()

    await expect(store.readManagedFilePrefix(receipt.path, B, 4)).rejects.toMatchObject({
      code: 'download_missing',
    })

    // Witness: the swap happened and the store opened the decoy's source.
    expect(swap.swapped()).toBe(true)
    const opened = openBoundary.mock.calls.map(([target]) => String(target))
    expect(opened.some(target => target.endsWith(`input-${receipt.id}/source`))).toBe(true)
    expect(syncFs.readFileSync(decoy.sourcePath)).toEqual(foreignBytes)
  })
})
