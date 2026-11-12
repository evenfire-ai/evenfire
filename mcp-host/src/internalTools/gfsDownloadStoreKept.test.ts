/**
 * Files the Host keeps for a caller in `users/<key>/.clerum-outputs` (generated
 * files and their save records) count in the download store's budget, are
 * never evicted, and bound what a keep may take. statfs is the only boundary
 * replaced: a simulated 200 MiB volume (budget 140 MiB, floor 30 MiB) whose
 * free space is its size minus `foreign` bytes minus every regular file under
 * the Host root, so writing or removing a file changes free space as on a disk.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import * as syncFs from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  callerDirectory,
  completedCopy,
  exists,
  expiryCount,
  startTransfer,
} from '../__tests__/fixtures/gfsStoreTestKit'
import { logger } from '../logger'
import { GfsDownloadStore, GfsDownloadStoreError } from './gfsDownloadStore'

const { statfsBoundary } = vi.hoisted(() => ({ statfsBoundary: vi.fn() }))
vi.mock('node:fs/promises', async original => ({
  ...(await original<typeof fs>()),
  statfs: statfsBoundary,
}))

const A = 'caller-a'
const B = 'caller-b'
const C = 'caller-c'
const MIB = 1024 * 1024
const TOTAL = 200 * MIB
const FLOOR = 30 * MIB
const KEPT_FAILURE =
  'GFS download store could not read a kept-files folder; the next sweep retries it'

let nativeFs: typeof fs
let hostRoot: string
let outside: string
let foreign = 0
const stores: GfsDownloadStore[] = []

function regularBytes(directory: string): number {
  let sum = 0
  let children: syncFs.Dirent[]
  try {
    children = syncFs.readdirSync(directory, { withFileTypes: true })
  } catch (error) {
    // A folder a test made unreadable is sized as empty by the simulated volume.
    if ((error as NodeJS.ErrnoException).code === 'EACCES') return 0
    throw error
  }
  for (const child of children) {
    const target = path.join(directory, child.name)
    if (child.isDirectory()) sum += regularBytes(target)
    else if (child.isFile()) sum += syncFs.lstatSync(target).size
  }
  return sum
}

function leaveFree(freeBytes: number): void {
  foreign = TOTAL - freeBytes - regularBytes(hostRoot)
}

async function openStore(): Promise<GfsDownloadStore> {
  const opened = new GfsDownloadStore(hostRoot)
  stores.push(opened)
  await opened.initialize()
  return opened
}

function outputsOf(caller: string): string {
  return path.join(callerDirectory(hostRoot, caller), '.clerum-outputs')
}

/** A kept file of `bytes` in the caller's kept folder (or its `.save-ledger/`). */
function keepFile(caller: string, name: string, bytes: number, place = ''): string {
  const dir = path.join(outputsOf(caller), place)
  syncFs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, name)
  syncFs.writeFileSync(file, Buffer.alloc(bytes, 0x61))
  return file
}

async function refusal(pending: Promise<unknown>): Promise<GfsDownloadStoreError> {
  try {
    await pending
  } catch (error) {
    expect(error).toBeInstanceOf(GfsDownloadStoreError)
    return error as GfsDownloadStoreError
  }
  throw new Error('expected a refusal')
}

beforeEach(async () => {
  nativeFs = await vi.importActual<typeof fs>('node:fs/promises')
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T10:00:00.000Z'))
  statfsBoundary.mockReset()
  foreign = 0
  statfsBoundary.mockImplementation(async (target: string) => {
    const real = await nativeFs.statfs(target, { bigint: true })
    const free = BigInt(TOTAL - foreign - regularBytes(hostRoot))
    return { ...real, bsize: 1n, blocks: BigInt(TOTAL), bavail: free < 0n ? 0n : free }
  })
  hostRoot = syncFs.mkdtempSync(path.join(tmpdir(), 'gfs-store-kept-'))
  outside = syncFs.mkdtempSync(path.join(tmpdir(), 'gfs-store-kept-outside-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  for (const opened of stores.splice(0)) await opened.close(0)
  for (const dir of [hostRoot, outside]) {
    for (const caller of [A, B, C]) {
      try {
        syncFs.chmodSync(path.join(dir, 'users', caller, '.clerum-outputs'), 0o700)
      } catch {
        // Not every test makes it.
      }
    }
    await nativeFs.rm(dir, { recursive: true, force: true })
  }
})

describe('kept files in the download store budget', () => {
  it('counts generated files and their records in the budget', async () => {
    const store = await openStore()
    const file = keepFile(A, 'big.md', 120 * MIB)
    keepFile(A, 'record.json', 10 * MIB, '.save-ledger')
    const rootB = callerDirectory(hostRoot, B)
    const refused = await refusal(startTransfer(store, rootB, B, 1, 15 * MIB))
    expect(refused.code).toBe('host_quota_exceeded')
    // Witness: without the generated file the same download is admitted.
    syncFs.rmSync(file)
    const { transfer } = await startTransfer(store, rootB, B, 1, 15 * MIB)
    expect(transfer.sizeBytes).toBe(15 * MIB)
  })

  it('does not count kept files twice against the free space', async () => {
    const store = await openStore()
    keepFile(A, 'kept.md', 60 * MIB)
    const rootB = callerDirectory(hostRoot, B)
    leaveFree(FLOOR + 10 * MIB)
    await startTransfer(store, rootB, B, 1, 10 * MIB)
    // One byte less free and the same request does not fit.
    leaveFree(FLOOR + 10 * MIB - 1)
    expect(
      (await refusal(startTransfer(store, callerDirectory(hostRoot, C), C, 2, 10 * MIB))).code
    ).toBe('disk_full')
  })

  it('evicts the least recently used download copy for a keep, never a kept file', async () => {
    const store = await openStore()
    const rootB = callerDirectory(hostRoot, B)
    const copies = []
    for (let index = 1; index <= 4; index++) {
      copies.push(await completedCopy(store, rootB, B, index, 15 * MIB))
      vi.setSystemTime(Date.now() + 1_000)
    }
    const kept = keepFile(C, 'kept.md', 60 * MIB)
    // 60 MiB of copies plus 60 kept plus this 30 pass the 140 MiB budget by 10.
    const release = await store.reserveKept({ callerIdentity: A, sizeBytes: 30 * MIB })
    release()
    expect(copies.map(copy => exists(path.join(rootB, copy.receipt.path)))).toEqual([
      false,
      true,
      true,
      true,
    ])
    expect(exists(kept)).toBe(true)
  })

  it('never evicts a kept file to restore the floor, and reports what a keep is short of', async () => {
    const store = await openStore()
    const rootB = callerDirectory(hostRoot, B)
    const copy = await completedCopy(store, rootB, B, 1, 15 * MIB)
    const kept = keepFile(A, 'kept.md', 40 * MIB)
    leaveFree(FLOOR - 5 * MIB)
    await store.cleanupExpired()
    expect(exists(path.join(rootB, copy.receipt.path))).toBe(false)
    expect(exists(kept)).toBe(true)

    // With kept files only, nothing can be evicted for the keep.
    leaveFree(FLOOR + MIB)
    const short = await refusal(store.reserveKept({ callerIdentity: A, sizeBytes: 10 * MIB }))
    expect(short.code).toBe('disk_full')
    expect(short.neededBytes).toBe(9 * MIB)
    expect(exists(kept)).toBe(true)
  })

  it("bounds one caller's kept bytes at half the budget, generated files included", async () => {
    const store = await openStore()
    keepFile(A, 'kept.md', 65 * MIB)
    const refused = await refusal(store.reserveKept({ callerIdentity: A, sizeBytes: 10 * MIB }))
    expect(refused.code).toBe('host_quota_exceeded')
    expect(refused.neededBytes).toBe(5 * MIB)
    // Another caller is admitted.
    ;(await store.reserveKept({ callerIdentity: B, sizeBytes: 10 * MIB }))()
  })

  it('refuses a keep to a caller whose generated files alone pass half the budget', async () => {
    const store = await openStore()
    const generated = keepFile(A, 'generated.pdf', 71 * MIB)
    expect((await refusal(store.reserveKept({ callerIdentity: A, sizeBytes: 1 }))).code).toBe(
      'host_quota_exceeded'
    )
    syncFs.rmSync(generated)
    ;(await store.reserveKept({ callerIdentity: A, sizeBytes: 1 }))()
  })

  it('bounds every caller together at three quarters, while a download that fits is admitted', async () => {
    const store = await openStore()
    keepFile(A, 'a.md', 60 * MIB)
    keepFile(B, 'b.md', 40 * MIB)
    const refused = await refusal(store.reserveKept({ callerIdentity: C, sizeBytes: 10 * MIB }))
    expect(refused.code).toBe('host_quota_exceeded')
    expect(refused.neededBytes).toBe(5 * MIB)
    const { transfer } = await startTransfer(store, callerDirectory(hostRoot, C), C, 1, 10 * MIB)
    expect(transfer.sizeBytes).toBe(10 * MIB)
  })

  it('counts a live reservation, and lets a download through while a keep writes', async () => {
    const store = await openStore()
    const release = await store.reserveKept({ callerIdentity: A, sizeBytes: 60 * MIB })
    expect(
      (await refusal(store.reserveKept({ callerIdentity: A, sizeBytes: 20 * MIB }))).code
    ).toBe('host_quota_exceeded')
    // The keep writes outside the store's section: a download admission in the
    // meantime completes, and the files written so far stay.
    const written = keepFile(A, 'being-kept.bin', 10 * MIB, '.uploads')
    const { transfer } = await startTransfer(store, callerDirectory(hostRoot, B), B, 1, MIB)
    expect(transfer.sizeBytes).toBe(MIB)
    expect(exists(written)).toBe(true)
    release()
    ;(await store.reserveKept({ callerIdentity: A, sizeBytes: 20 * MIB }))()
  })

  it('does not enter a kept folder that is a link', async () => {
    const store = await openStore()
    syncFs.mkdirSync(callerDirectory(hostRoot, A), { recursive: true })
    syncFs.writeFileSync(path.join(outside, 'elsewhere.md'), Buffer.alloc(130 * MIB, 0x61))
    syncFs.symlinkSync(outside, outputsOf(A))
    const rootC = callerDirectory(hostRoot, C)
    await completedCopy(store, rootC, C, 1, 5 * MIB)
    // Witness: the same bytes in a real kept folder count.
    keepFile(B, 'real.md', 130 * MIB)
    expect((await refusal(startTransfer(store, rootC, C, 2, 15 * MIB))).code).toBe(
      'host_quota_exceeded'
    )
  })

  it('settles at once with a FIFO as a kept file or a record', async () => {
    const store = await openStore()
    keepFile(A, 'real.md', MIB)
    execFileSync('mkfifo', [path.join(outputsOf(A), 'pipe.md')])
    syncFs.mkdirSync(path.join(outputsOf(A), '.save-ledger'), { mode: 0o700 })
    execFileSync('mkfifo', [path.join(outputsOf(A), '.save-ledger', 'pipe.json')])
    const settled = await Promise.race([
      (async () => {
        await store.cleanupExpired()
        await startTransfer(store, callerDirectory(hostRoot, B), B, 1, MIB)
        return 'settled' as const
      })(),
      delay(2_000).then(() => 'blocked' as const),
    ])
    expect(settled).toBe('settled')
  })

  it('treats a caller with no kept folder as silent, and reports a folder it cannot read', async () => {
    const store = await openStore()
    callerDirectory(hostRoot, A)
    const warn = vi.spyOn(logger, 'warn')
    const before = await expiryCount('sweep_failed')
    await store.cleanupExpired()
    expect(await expiryCount('sweep_failed')).toBe(before)
    if (process.getuid?.() === 0) return
    keepFile(B, 'b.md', 126 * MIB)
    keepFile(C, 'c.md', MIB)
    syncFs.chmodSync(outputsOf(C), 0o000)
    // The failing folder does not stop the next one: B's bytes still count.
    const refused = await refusal(
      startTransfer(store, callerDirectory(hostRoot, A), A, 1, 15 * MIB)
    )
    expect(refused.code).toBe('host_quota_exceeded')
    expect(await expiryCount('sweep_failed')).toBe(before + 1)
    expect(warn.mock.calls.filter(call => call[1] === KEPT_FAILURE)).toHaveLength(1)
  })

  it('refuses a keep before the store is initialized, and admits it after', async () => {
    const store = new GfsDownloadStore(hostRoot)
    stores.push(store)
    await expect(store.reserveKept({ callerIdentity: A, sizeBytes: 1 })).rejects.toThrow()
    await store.initialize()
    ;(await store.reserveKept({ callerIdentity: A, sizeBytes: 1 }))()
  })
})
