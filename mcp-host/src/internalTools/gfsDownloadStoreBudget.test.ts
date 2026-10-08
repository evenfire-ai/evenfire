/**
 * The retained-storage budget of the GFS download store (#1028, Addendum 8):
 * `floor(volumeTotalBytes * percent / 100)`, with the volume measured by
 * statfs at every admission. There is no per-caller or file-count limit;
 * eviction order and the free-space check are unchanged. statfs is the only
 * boundary replaced: it reports the real free space and a chosen volume size.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hash } from 'node:crypto'
import * as syncFs from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import {
  callerDirectory,
  completedCopy,
  downloadDirectory,
  exists,
  metaFor,
  plantDownload,
  quotaCount,
  sourceFor,
  startTransfer,
  withEnvironment,
} from '../__tests__/fixtures/gfsStoreTestKit'
import { logger } from '../logger'
import { GfsDownloadStore, GfsDownloadStoreError } from './gfsDownloadStore'
import { REMOVED_GFS_STORAGE_VARIABLES } from './gfsFilePolicy'

const { statfsBoundary } = vi.hoisted(() => ({ statfsBoundary: vi.fn() }))
vi.mock('node:fs/promises', async original => ({
  ...(await original<typeof fs>()),
  statfs: statfsBoundary,
}))

const A = 'caller-a'
const B = 'caller-b'
const MIB = 1024 * 1024
const REMOVED_VARIABLE_WARNING =
  'GFS download store ignores a removed retained-storage variable; the budget is MCP_HOST_GFS_DOWNLOAD_STORAGE_PERCENT of the workspace volume'

let nativeFs: typeof fs
let hostRoot: string
let rootA: string
let rootB: string
const stores: GfsDownloadStore[] = []

/** statfs as the volume reports it, but with `blocks * bsize` total bytes. */
function volumeOf(blocks: bigint, bsize = 1n): void {
  statfsBoundary.mockImplementation(async (target: string) => {
    const real = await nativeFs.statfs(target, { bigint: true })
    return { ...real, bsize, blocks, bavail: (real.bavail * real.bsize) / bsize }
  })
}

async function openStore(root = hostRoot): Promise<GfsDownloadStore> {
  const opened = new GfsDownloadStore(root)
  stores.push(opened)
  await opened.initialize()
  return opened
}

/** A store re-imported with environment limits applied. */
async function limitedStore(env: Record<string, string>, root = hostRoot) {
  return withEnvironment(env, async () => {
    vi.resetModules()
    const { GfsDownloadStore: Store } = await import('./gfsDownloadStore')
    const opened = new Store(root) as unknown as GfsDownloadStore
    stores.push(opened)
    await opened.initialize()
    return opened
  })
}

/** Distinct createdAt values so the eviction order is deterministic. */
function tick(): void {
  vi.setSystemTime(Date.now() + 1_000)
}

beforeEach(async () => {
  nativeFs = await vi.importActual<typeof fs>('node:fs/promises')
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-08T10:00:00.000Z'))
  statfsBoundary.mockReset()
  statfsBoundary.mockImplementation(nativeFs.statfs)
  hostRoot = syncFs.mkdtempSync(path.join(tmpdir(), 'gfs-store-budget-'))
  rootA = callerDirectory(hostRoot, A)
  rootB = callerDirectory(hostRoot, B)
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.useRealTimers()
  for (const opened of stores.splice(0)) await opened.close(0)
  await nativeFs.rm(hostRoot, { recursive: true, force: true })
})

describe('GFS download store budget: share of the workspace volume', () => {
  it('BUD-1: the default 85% budget admits exactly up to floor(total * 85 / 100) bytes', async () => {
    // 101 bytes of volume: 85.85 floors to 85. A caller may protect at most
    // floor(85 / 2) = 42 bytes, so the pinned 85 are spread over three callers:
    // A 40 + B 40 + C 5. The refused 1-byte request leaves A at 41, under its half.
    volumeOf(101n)
    const store = await openStore()
    const C = 'caller-c'
    const rootC = callerDirectory(hostRoot, C)
    await completedCopy(store, rootA, A, 1, 40, { owner: 'task-a' })
    await completedCopy(store, rootB, B, 4, 40, { owner: 'task-b' })
    const denied = await quotaCount('host', 'storage_bytes')

    const atBudget = await completedCopy(store, rootC, C, 2, 5, { owner: 'task-c' })
    expect(await quotaCount('host', 'storage_bytes')).toBe(denied)
    await expect(store.readManagedFile(atBudget.receipt.path, C)).resolves.toEqual(atBudget.bytes)

    await expect(startTransfer(store, rootA, A, 3, 1)).rejects.toMatchObject({
      code: 'host_quota_exceeded',
    })
    expect(await quotaCount('host', 'storage_bytes')).toBe(denied + 1)
    // Witness: the budget was sized from statfs at that admission.
    expect(statfsBoundary).toHaveBeenCalled()
  })

  it.each([
    { percent: '1', blocks: 1000n, budget: 10 },
    { percent: '100', blocks: 10n, budget: 10 },
  ])(
    'BUD-2: percent $percent of a $blocks-byte volume admits $budget bytes and refuses one more',
    async ({ percent, blocks, budget }) => {
      volumeOf(blocks)
      const store = await limitedStore({ MCP_HOST_GFS_DOWNLOAD_STORAGE_PERCENT: percent })
      const denied = await quotaCount('host', 'storage_bytes')

      // A caller may protect at most half the budget, so the pinned budget is
      // two halves held by A and B; the refused byte comes from a third caller
      // that protects nothing yet, so only the host budget can refuse it.
      await completedCopy(store, rootA, A, 10, budget / 2, { owner: 'task-a' })
      await completedCopy(store, rootB, B, 12, budget - budget / 2, { owner: 'task-b' })
      expect(await quotaCount('host', 'storage_bytes')).toBe(denied)
      const C = 'caller-c'
      await expect(
        startTransfer(store, callerDirectory(hostRoot, C), C, 11, 1)
      ).rejects.toMatchObject({
        code: 'host_quota_exceeded',
      })
      expect(await quotaCount('host', 'storage_bytes')).toBe(denied + 1)
    }
  )

  it('BUD-3: a volume resized between two admissions is used by the second, without restart', async () => {
    // Budget 20, so each caller protects at most 10: 15 bytes pinned by A (10)
    // and C (5), then B asks for 10. 15 + 10 > 20 is refused by the host budget;
    // after the resize 15 + 10 fits in 25, and B's 10 stays under floor(25 / 2).
    volumeOf(20n)
    const store = await limitedStore({ MCP_HOST_GFS_DOWNLOAD_STORAGE_PERCENT: '100' })
    await completedCopy(store, rootA, A, 20, 10, { owner: 'task-a' })
    const C = 'caller-c'
    await completedCopy(store, callerDirectory(hostRoot, C), C, 22, 5, { owner: 'task-c' })
    const denied = await quotaCount('host', 'storage_bytes')

    await expect(startTransfer(store, rootB, B, 21, 10)).rejects.toMatchObject({
      code: 'host_quota_exceeded',
    })
    expect(await quotaCount('host', 'storage_bytes')).toBe(denied + 1)

    volumeOf(25n)
    statfsBoundary.mockClear()
    const admitted = await startTransfer(store, rootB, B, 21, 10)
    expect(admitted.transfer.sizeBytes).toBe(10)
    // Witness: the new size came from a statfs taken by this admission.
    expect(statfsBoundary).toHaveBeenCalled()
  })

  it('BUD-4: a large volume is sized in bigint without rounding', async () => {
    // 2^53 + 2 blocks of 4096 bytes is far beyond Number precision.
    volumeOf(2n ** 53n + 2n, 4096n)
    const store = await openStore()
    const admitted = await startTransfer(store, rootA, A, 30, 1024)
    expect(admitted.transfer.sizeBytes).toBe(1024)
  })

  it.each([
    { name: 'a zero block size', bsize: 0n, blocks: 1000n },
    { name: 'a zero block count', bsize: 1n, blocks: 0n },
    { name: 'a negative block count', bsize: 1n, blocks: -1n },
  ])('BUD-5: statfs reporting $name refuses with free_space', async ({ bsize, blocks }) => {
    const store = await openStore()
    const observed = await nativeFs.statfs(hostRoot, { bigint: true })
    statfsBoundary.mockResolvedValue({ ...observed, bsize, blocks })
    const denied = await quotaCount('host', 'free_space')

    await expect(startTransfer(store, rootA, A, 31, 4)).rejects.toMatchObject({
      code: 'host_quota_exceeded',
    })
    expect(await quotaCount('host', 'free_space')).toBe(denied + 1)

    // Witness: the real statfs admits the same request.
    statfsBoundary.mockImplementation(nativeFs.statfs)
    await expect(startTransfer(store, rootA, A, 31, 4)).resolves.toBeDefined()
  })
})

describe('GFS download store budget: a full disk and a full cache are distinct refusals', () => {
  it('DSK-1: a full disk refuses as disk_full while a full budget still refuses as host_quota_exceeded', async () => {
    // Budget floor(20 * 85 / 100) = 17; A and B pin 8 each, so 2 more bytes
    // exceed the budget while 1 more fits.
    volumeOf(20n)
    const store = await openStore()
    const C = 'caller-c'
    const rootC = callerDirectory(hostRoot, C)
    await completedCopy(store, rootA, A, 40, 8, { owner: 'task-a' })
    await completedCopy(store, rootB, B, 41, 8, { owner: 'task-b' })
    const budgetDenied = await quotaCount('host', 'storage_bytes')
    const diskDenied = await quotaCount('host', 'free_space')

    await expect(startTransfer(store, rootC, C, 42, 2)).rejects.toMatchObject({
      code: 'host_quota_exceeded',
    })
    expect(await quotaCount('host', 'storage_bytes')).toBe(budgetDenied + 1)
    expect(await quotaCount('host', 'free_space')).toBe(diskDenied)

    // The same volume with one byte less than the 16 MiB margin plus the request.
    statfsBoundary.mockImplementation(async (target: string) => ({
      ...(await nativeFs.statfs(target, { bigint: true })),
      bsize: 1n,
      blocks: 20n,
      bavail: 16n * BigInt(MIB),
    }))
    await expect(startTransfer(store, rootC, C, 43, 1)).rejects.toMatchObject({
      code: 'disk_full',
      message: 'GFS download store failed (disk_full)',
    })
    expect(await quotaCount('host', 'free_space')).toBe(diskDenied + 1)
    expect(await quotaCount('host', 'storage_bytes')).toBe(budgetDenied + 1)

    // Witness: with the real free space the same request fits the budget.
    volumeOf(20n)
    await expect(startTransfer(store, rootC, C, 43, 1)).resolves.toBeDefined()
  })

  it('DSK-2: statfs reporting a negative available-block count keeps host_quota_exceeded, not disk_full', async () => {
    const store = await openStore()
    const observed = await nativeFs.statfs(hostRoot, { bigint: true })
    statfsBoundary.mockResolvedValue({ ...observed, bavail: -1n })
    const denied = await quotaCount('host', 'free_space')

    const refusal = await startTransfer(store, rootA, A, 44, 4).catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(GfsDownloadStoreError)
    expect((refusal as GfsDownloadStoreError).code).toBe('host_quota_exceeded')
    expect(await quotaCount('host', 'free_space')).toBe(denied + 1)

    // Witness: the real statfs admits the same request.
    statfsBoundary.mockImplementation(nativeFs.statfs)
    await expect(startTransfer(store, rootA, A, 44, 4)).resolves.toBeDefined()
  })

  it.each([
    { name: 'one byte above the file limit', size: 11 },
    { name: 'a negative size', size: -1 },
    { name: 'a fractional size', size: 1.5 },
  ])('DSK-3: $name is refused as limit_exceeded without a space metric', async ({ size }) => {
    // Budget 850 bytes, so only the 10-byte file limit can refuse.
    volumeOf(1000n)
    const store = await limitedStore({ MCP_HOST_GFS_MAX_FILE_BYTES: '10' })
    const budgetDenied = await quotaCount('host', 'storage_bytes')
    const diskDenied = await quotaCount('host', 'free_space')
    statfsBoundary.mockClear()

    // Called directly: the kit's helper allocates the bytes before admission.
    const refused = store.createTransfer({
      callerIdentity: A,
      callerWorkspacePath: rootA,
      source: sourceFor(45),
      sizeBytes: size,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    })
    await expect(refused).rejects.toMatchObject({
      code: 'limit_exceeded',
      message: 'GFS download store failed (limit_exceeded)',
    })
    expect(await quotaCount('host', 'storage_bytes')).toBe(budgetDenied)
    expect(await quotaCount('host', 'free_space')).toBe(diskDenied)
    expect(statfsBoundary).not.toHaveBeenCalled()

    // Witness: a size exactly at the file limit is admitted and measured.
    const admitted = await startTransfer(store, rootA, A, 45, 10)
    expect(admitted.transfer.sizeBytes).toBe(10)
    expect(statfsBoundary).toHaveBeenCalled()
  })
})

describe('GFS download store budget: no per-caller storage or file-count limit', () => {
  it('BUD-6: one caller fills the whole budget with 18 files of 16 MiB and another caller evicts its least recently used copy', async () => {
    const size = 16 * MIB
    const files = 18
    const zeros = hash('sha256', Buffer.alloc(size), 'hex')
    volumeOf(BigInt(files * size))
    const store = await limitedStore({ MCP_HOST_GFS_DOWNLOAD_STORAGE_PERCENT: '100' })
    const ids: string[] = []
    for (let index = 0; index < files; index += 1) {
      const transfer = await store.createTransfer({
        callerIdentity: A,
        callerWorkspacePath: rootA,
        source: sourceFor(100 + index),
        sizeBytes: size,
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      })
      // A sparse partial: 16 MiB of zeros without writing them.
      syncFs.truncateSync(path.join(rootA, transfer.partialPath), size)
      ids.push((await store.publish(transfer.id, A, zeros)).id)
      tick()
    }
    // 288 MiB and 18 files: above the removed 256 MiB and 8-file caller limits.
    expect((await store.debugInventory()).byCaller.get(A)).toEqual({ files, bytes: files * size })

    const admitted = await store.createTransfer({
      callerIdentity: B,
      callerWorkspacePath: rootB,
      source: sourceFor(200),
      sizeBytes: size,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    })

    expect(admitted.sizeBytes).toBe(size)
    expect(exists(downloadDirectory(rootA, ids[0]!))).toBe(false)
    // Witness: only the least recently used copy went.
    for (const id of ids.slice(1)) expect(exists(downloadDirectory(rootA, id))).toBe(true)
    expect((await store.debugInventory()).byCaller.get(A)?.files).toBe(files - 1)
  }, 60_000)

  it("BUD-7: another caller's admission never evicts a pinned copy and takes an adopted one first", async () => {
    volumeOf(30n)
    const store = await limitedStore({ MCP_HOST_GFS_DOWNLOAD_STORAGE_PERCENT: '100' })
    const pinned = await completedCopy(store, rootA, A, 40, 10, { owner: 'task-a' })
    tick()
    // A protects at most floor(30 / 2) = 15: the pinned 10 plus this 5-byte
    // reservation while it is written.
    const unpinned = await completedCopy(store, rootA, A, 41, 5)
    tick()
    const bytes = Buffer.alloc(10, 0x42)
    const plantedId = '00000000-0000-4000-8000-000000000042'
    const planted = plantDownload(rootA, {
      id: plantedId,
      bytes,
      meta: metaFor(plantedId, bytes, Date.now()),
    })
    tick()

    // 25 retained + 10 requested against 30: one copy goes, and it is the adopted one.
    await startTransfer(store, rootB, B, 42, 10)
    expect(exists(planted.directory)).toBe(false)
    expect(exists(downloadDirectory(rootA, unpinned.receipt.id))).toBe(true)
    expect(exists(downloadDirectory(rootA, pinned.receipt.id))).toBe(true)

    // Next, 15 retained + B's 10 reserved + 10 requested against 30: the
    // unpinned published copy goes; the pinned one, older, never does.
    const second = await startTransfer(
      store,
      callerDirectory(hostRoot, 'caller-c'),
      'caller-c',
      43,
      10
    )
    expect(second.transfer.sizeBytes).toBe(10)
    expect(exists(downloadDirectory(rootA, unpinned.receipt.id))).toBe(false)
    expect(exists(downloadDirectory(rootA, pinned.receipt.id))).toBe(true)
  })

  it('BUD-8: the quota denial is identical whoever fills the budget', async () => {
    const denialFor = async (fillOwnRoot: boolean) => {
      const host = syncFs.mkdtempSync(path.join(tmpdir(), 'gfs-store-budget-denial-'))
      try {
        const own = callerDirectory(host, A)
        const other = callerDirectory(host, `caller-${'b'.repeat(12)}`)
        const third = callerDirectory(host, `caller-${'c'.repeat(12)}`)
        const store = await openStore(host)
        // 80 pinned bytes either way; no caller protects more than floor(85 / 2) = 42.
        const fillers: Array<[string, number]> = fillOwnRoot
          ? [
              [own, 30],
              [other, 40],
              [third, 10],
            ]
          : [
              [other, 40],
              [third, 40],
            ]
        for (const [index, [filler, sizeBytes]] of fillers.entries())
          await completedCopy(store, filler, path.basename(filler), 50 + index * 2, sizeBytes, {
            owner: 'task-fill',
          })
        const denied = await quotaCount('host', 'storage_bytes')
        const error = await startTransfer(store, own, A, 51, 10).then(
          () => undefined,
          (rejection: unknown) => rejection
        )
        // The refusal came from the host budget: A stays under its own half
        // (at most 30 + 10 = 40 of 42).
        expect(await quotaCount('host', 'storage_bytes')).toBe(denied + 1)
        // Witness: the refusal was the budget; releasing the pins admits the same request.
        for (const [filler] of fillers)
          await store.releaseReceiptOwner('task-fill', path.basename(filler))
        await expect(startTransfer(store, own, A, 51, 10)).resolves.toBeDefined()
        return error
      } finally {
        await nativeFs.rm(host, { recursive: true, force: true })
      }
    }
    // 100 bytes of volume, default 85%: 80 retained + 10 requested is over.
    volumeOf(100n)
    const ownFill = await denialFor(true)
    const foreignFill = await denialFor(false)

    expect(ownFill).toBeInstanceOf(GfsDownloadStoreError)
    expect(foreignFill).toBeInstanceOf(GfsDownloadStoreError)
    const shape = (error: unknown) => {
      const visible = error as Error & Record<string, unknown>
      return JSON.stringify({ ...visible, name: visible.name, message: visible.message })
    }
    expect(shape(foreignFill)).toBe(shape(ownFill))
    expect(shape(foreignFill)).toBe(
      JSON.stringify({
        code: 'host_quota_exceeded',
        name: 'GfsDownloadStoreError',
        message: 'GFS download store failed (host_quota_exceeded)',
      })
    )
    expect(shape(foreignFill)).not.toContain('caller-b')
  })
})

describe('GFS download store budget: removed variables', () => {
  function removedWarnings(warn: { mock: { calls: unknown[][] } }) {
    return warn.mock.calls.filter(call => call[1] === REMOVED_VARIABLE_WARNING)
  }

  it.each(REMOVED_GFS_STORAGE_VARIABLES)(
    'BUD-9: %s still set is warned about once, by name and never by value',
    async variable => {
      for (const name of REMOVED_GFS_STORAGE_VARIABLES) vi.stubEnv(name, undefined)
      const value = 'secret-value-1073741824'
      vi.stubEnv(variable, value)
      const warn = vi.spyOn(logger, 'warn')

      const store = await openStore()

      expect(store.isAvailable()).toBe(true)
      const logged = removedWarnings(warn)
      expect(logged).toHaveLength(1)
      expect(logged[0]![0]).toEqual({ component: 'GfsDownloadStore', variable })
      expect(JSON.stringify(warn.mock.calls)).not.toContain(value)
    }
  )

  it('BUD-9b: every removed variable set at once gives one warning each', async () => {
    for (const name of REMOVED_GFS_STORAGE_VARIABLES) vi.stubEnv(name, '1')
    const warn = vi.spyOn(logger, 'warn')

    const store = await openStore()

    expect(store.isAvailable()).toBe(true)
    expect(
      removedWarnings(warn)
        .map(call => (call[0] as { variable: string }).variable)
        .sort()
    ).toEqual([...REMOVED_GFS_STORAGE_VARIABLES].sort())
  })

  it('BUD-10: with no removed variable set nothing is warned and the store initializes', async () => {
    for (const name of REMOVED_GFS_STORAGE_VARIABLES) vi.stubEnv(name, undefined)
    const warn = vi.spyOn(logger, 'warn')
    const info = vi.spyOn(logger, 'info')

    const store = await openStore()

    // Witness: initialization ran to its own log line.
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ component: 'GfsDownloadStore' }),
      'GFS download store initialized'
    )
    expect(store.isAvailable()).toBe(true)
    expect(removedWarnings(warn)).toHaveLength(0)
  })
})
