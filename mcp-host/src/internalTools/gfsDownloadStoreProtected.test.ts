/**
 * R3-F1 (#1028, Addendum 9): eviction never reclaims a pinned copy or an
 * active reservation, so one caller's protected bytes — pins of its retention
 * owners plus its reservations, each id once — may reach at most half the
 * budget. Unpinned copies still use the whole budget. Ported from the final
 * review's SOL-R3-PINS repro. A 100-byte volume at the default 85% gives a
 * budget of 85 and a per-caller protected cap of floor(85 / 2) = 42.
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
  quotaCount,
  sourceFor,
  startTransfer,
} from '../__tests__/fixtures/gfsStoreTestKit'
import { GfsDownloadStore, GfsDownloadStoreError } from './gfsDownloadStore'

const { statfsBoundary } = vi.hoisted(() => ({ statfsBoundary: vi.fn() }))
vi.mock('node:fs/promises', async original => ({
  ...(await original<typeof fs>()),
  statfs: statfsBoundary,
}))

const A = 'caller-a'
const B = 'caller-b'
const C = 'caller-c'

let nativeFs: typeof fs
let hostRoot: string
let rootA: string
let rootB: string
let rootC: string
const stores: GfsDownloadStore[] = []

async function openStore(): Promise<GfsDownloadStore> {
  const opened = new GfsDownloadStore(hostRoot)
  stores.push(opened)
  await opened.initialize()
  return opened
}

/** `count` published 5-byte copies, pinned by `owner` when given. */
async function copies(
  store: GfsDownloadStore,
  root: string,
  caller: string,
  first: number,
  count: number,
  owner?: string
) {
  const receipts = []
  for (let index = first; index < first + count; index += 1)
    receipts.push(
      (await completedCopy(store, root, caller, index, 5, owner ? { owner } : {})).receipt
    )
  return receipts
}

const protectedRefusals = () => quotaCount('caller', 'protected_bytes')
const hostRefusals = () => quotaCount('host', 'storage_bytes')

beforeEach(async () => {
  nativeFs = await vi.importActual<typeof fs>('node:fs/promises')
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-08T12:00:00.000Z'))
  statfsBoundary.mockReset()
  statfsBoundary.mockImplementation(async (target: string) => {
    const real = await nativeFs.statfs(target, { bigint: true })
    return { ...real, bsize: 1n, blocks: 100n, bavail: real.bavail * real.bsize }
  })
  hostRoot = syncFs.mkdtempSync(path.join(tmpdir(), 'gfs-store-protected-'))
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

describe('GFS download store: a caller protects at most half the budget (R3-F1)', () => {
  it('SOL-R3-PINS: one caller pins up to the cap, exactly, and other callers keep admitting', async () => {
    const store = await openStore()
    const pinned = await copies(store, rootA, A, 0, 8, 'task-a')
    // 40 pinned + 2 = 42, the cap exactly.
    await completedCopy(store, rootA, A, 8, 2, { owner: 'task-a' })
    const protectedBefore = await protectedRefusals()
    const hostBefore = await hostRefusals()

    const refusal = await startTransfer(store, rootA, A, 9, 1).catch(error => error)
    expect(refusal).toBeInstanceOf(GfsDownloadStoreError)
    expect(refusal).toMatchObject({ code: 'host_quota_exceeded' })
    expect(await protectedRefusals()).toBe(protectedBefore + 1)
    expect(await hostRefusals()).toBe(hostBefore)

    // The repro's denial: B and C are admitted, before and after expiry.
    const b = await startTransfer(store, rootB, B, 10, 1)
    await store.fail(b.transfer.id, B)
    vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1000)
    expect((await store.cleanupExpired()).removedExpired).toBe(0)
    const c = await startTransfer(store, rootC, C, 11, 1)
    await store.fail(c.transfer.id, C)
    for (const receipt of pinned) expect(exists(downloadDirectory(rootA, receipt.id))).toBe(true)

    // Releasing the owner gives A its room back.
    await store.releaseReceiptOwner('task-a', A)
    const again = await startTransfer(store, rootA, A, 12, 1)
    await store.fail(again.transfer.id, A)
  })

  it('a refused caller gets the same error object as a full Host budget', async () => {
    const store = await openStore()
    await copies(store, rootA, A, 0, 8, 'task-a')
    await completedCopy(store, rootA, A, 8, 2, { owner: 'task-a' })
    const capRefusal = await startTransfer(store, rootA, A, 9, 1).catch(error => error)

    // B pins 40 beside A's 42: 82 of 85, so C's 4 bytes exceed the Host
    // budget while C protects nothing.
    await copies(store, rootB, B, 20, 8, 'task-b')
    const hostBefore = await hostRefusals()
    const protectedBefore = await protectedRefusals()
    const budgetRefusal = await startTransfer(store, rootC, C, 40, 4).catch(error => error)
    expect(await hostRefusals()).toBe(hostBefore + 1)
    expect(await protectedRefusals()).toBe(protectedBefore)
    expect(budgetRefusal).toBeInstanceOf(GfsDownloadStoreError)
    expect(capRefusal).toBeInstanceOf(GfsDownloadStoreError)
    expect({ code: capRefusal.code, message: capRefusal.message }).toEqual({
      code: budgetRefusal.code,
      message: budgetRefusal.message,
    })
  })

  it('the new reservation itself counts, pinned or not', async () => {
    const store = await openStore()
    await copies(store, rootA, A, 0, 8, 'task-a')
    const before = await protectedRefusals()

    // 40 pinned + a 3-byte reservation without owner = 43.
    await expect(startTransfer(store, rootA, A, 9, 3)).rejects.toMatchObject({
      code: 'host_quota_exceeded',
    })
    expect(await protectedRefusals()).toBe(before + 1)
    // 40 + 2 = 42 is admitted.
    const admitted = await startTransfer(store, rootA, A, 10, 2)
    await store.fail(admitted.transfer.id, A)
  })

  it("a caller's open reservation counts when it pins a reused copy", async () => {
    const store = await openStore()
    // 5 unpinned, then 30 pinned, then an open 10-byte reservation without
    // owner: 40 protected. One caller holds one reservation at a time by
    // default, so reuse is where an existing reservation meets a new pin.
    await completedCopy(store, rootA, A, 1, 5)
    await completedCopy(store, rootA, A, 0, 30, { owner: 'task-a' })
    const open = await startTransfer(store, rootA, A, 2, 10)
    const before = await protectedRefusals()

    // 30 + 10 + 5 = 45: refused while the reservation is open.
    await expect(
      store.reusableReceipt(A, sourceFor(1), 5, { retentionOwnerId: 'task-b' })
    ).rejects.toMatchObject({ code: 'host_quota_exceeded' })
    expect(await protectedRefusals()).toBe(before + 1)

    // Once it settles, 30 + 5 = 35 is admitted.
    await store.fail(open.transfer.id, A)
    await expect(
      store.reusableReceipt(A, sourceFor(1), 5, { retentionOwnerId: 'task-b' })
    ).resolves.toMatchObject({ sizeBytes: 5 })
    expect(await protectedRefusals()).toBe(before + 1)
  })

  it('unpinned copies are not protected: one caller still fills the whole budget', async () => {
    const store = await openStore()
    await copies(store, rootA, A, 0, 16)
    const before = await protectedRefusals()

    // 80 unpinned + 5 = 85, the budget exactly, far over the 42 cap.
    const last = await completedCopy(store, rootA, A, 16, 5)
    expect(await protectedRefusals()).toBe(before)
    await expect(store.readManagedFile(last.receipt.path, A)).resolves.toEqual(last.bytes)
  })

  it('pinning a reused copy counts it once, and only when it is not already protected', async () => {
    const store = await openStore()
    // The unpinned copy first: its 20-byte reservation beside 30 pinned
    // bytes would itself exceed the cap.
    await completedCopy(store, rootA, A, 1, 20)
    const held = await completedCopy(store, rootA, A, 0, 30, { owner: 'task-a' })
    const before = await protectedRefusals()

    // A copy already pinned by A adds nothing: 30 stays 30.
    await expect(
      store.reusableReceipt(A, sourceFor(0), 30, { retentionOwnerId: 'task-b' })
    ).resolves.toMatchObject({ id: held.receipt.id })
    expect(await protectedRefusals()).toBe(before)

    // The unpinned 20-byte copy would make 50: refused, and still reusable
    // without an owner.
    await expect(
      store.reusableReceipt(A, sourceFor(1), 20, { retentionOwnerId: 'task-b' })
    ).rejects.toMatchObject({ code: 'host_quota_exceeded' })
    expect(await protectedRefusals()).toBe(before + 1)
    await expect(store.reusableReceipt(A, sourceFor(1), 20)).resolves.toMatchObject({
      sizeBytes: 20,
    })
  })

  it('a file larger than the cap is refused before any eviction', async () => {
    const store = await openStore()
    const other = await completedCopy(store, rootB, B, 0, 5)
    const before = await protectedRefusals()

    await expect(startTransfer(store, rootA, A, 1, 43)).rejects.toMatchObject({
      code: 'host_quota_exceeded',
    })
    expect(await protectedRefusals()).toBe(before + 1)
    expect(exists(downloadDirectory(rootB, other.receipt.id))).toBe(true)
    const admitted = await startTransfer(store, rootA, A, 2, 42)
    await store.fail(admitted.transfer.id, A)
  })
})
