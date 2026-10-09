/**
 * R3-F1 (#1028, Addendum 9): eviction never reclaims a pinned copy or an
 * active reservation, so one caller's protected bytes — pins of its retention
 * owners plus its reservations, each id once — may reach at most half the
 * budget. The protected bytes of all callers together are capped at three
 * quarters, so one caller at its cap leaves room for the others. Unpinned
 * copies still use the whole budget. Ported from the final review's
 * SOL-R3-PINS repro. A 122-byte volume at the default 70% gives a budget of
 * floor(85.4) = 85, a per-caller cap of floor(85 / 2) = 42 and a Host-wide cap
 * of floor(85 * 3 / 4) = 63.
 *
 * Addendum 10: expiry is absolute. A pin protects a copy from eviction, never
 * past its `expiresAt`: the sweep removes an expired pinned copy, it stops
 * counting toward its caller's cap, and eviction may reclaim it.
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

const { statfsBoundary, lstatBoundary } = vi.hoisted(() => ({
  statfsBoundary: vi.fn(),
  lstatBoundary: vi.fn(),
}))
vi.mock('node:fs/promises', async original => ({
  ...(await original<typeof fs>()),
  statfs: statfsBoundary,
  lstat: lstatBoundary,
}))

const HOUR_MS = 60 * 60 * 1000

function ioError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: injected by the test`), { code })
}

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
const hostProtectedRefusals = () => quotaCount('host', 'protected_bytes')

beforeEach(async () => {
  nativeFs = await vi.importActual<typeof fs>('node:fs/promises')
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-08T12:00:00.000Z'))
  statfsBoundary.mockReset()
  statfsBoundary.mockImplementation(async (target: string) => {
    const real = await nativeFs.statfs(target, { bigint: true })
    return { ...real, bsize: 1n, blocks: 122n, bavail: real.bavail * real.bsize }
  })
  lstatBoundary.mockReset()
  lstatBoundary.mockImplementation((...args: unknown[]) =>
    (nativeFs.lstat as (...forwarded: unknown[]) => Promise<unknown>)(...args)
  )
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
  it('SOL-R3-PINS: one caller pins up to its cap, exactly, and another caller is still admitted beside it', async () => {
    const store = await openStore()
    const pinned = await copies(store, rootA, A, 0, 8, 'task-a')
    // 40 pinned + 2 = 42, the cap exactly.
    await completedCopy(store, rootA, A, 8, 2, { owner: 'task-a' })
    const protectedBefore = await protectedRefusals()
    const hostBefore = await hostProtectedRefusals()

    const refusal = await startTransfer(store, rootA, A, 9, 1).catch(error => error)
    expect(refusal).toBeInstanceOf(GfsDownloadStoreError)
    expect(refusal).toMatchObject({ code: 'host_quota_exceeded' })
    expect(await protectedRefusals()).toBe(protectedBefore + 1)
    expect(await hostProtectedRefusals()).toBe(hostBefore)

    // A at its cap does not block B: B's 21-byte reservation brings the Host
    // to 63, the Host-wide cap exactly, and is admitted. A's pinned copies
    // stay. Expiry of pinned copies is covered by the absolute-retention tests
    // below.
    const b = await startTransfer(store, rootB, B, 10, 21)
    expect(b.transfer.id).toEqual(expect.any(String))
    expect(await hostProtectedRefusals()).toBe(hostBefore)
    expect(await protectedRefusals()).toBe(protectedBefore + 1)
    await store.fail(b.transfer.id, B)
    for (const receipt of pinned) expect(exists(downloadDirectory(rootA, receipt.id))).toBe(true)

    // Releasing the owner gives A its room back.
    await store.releaseReceiptOwner('task-a', A)
    const again = await startTransfer(store, rootA, A, 12, 1)
    await store.fail(again.transfer.id, A)
  })

  it('TWO-CALLERS-HOST-CAP: two callers that together protect three quarters of the budget refuse a third caller with the Host-wide scope', async () => {
    const store = await openStore()
    // A pins 42, its cap, and B pins 21, under its cap: 63, the Host-wide cap.
    await copies(store, rootA, A, 0, 8, 'task-a')
    await completedCopy(store, rootA, A, 8, 2, { owner: 'task-a' })
    await copies(store, rootB, B, 20, 4, 'task-b')
    await completedCopy(store, rootB, B, 24, 1, { owner: 'task-b' })
    const callerBefore = await protectedRefusals()
    const hostBefore = await hostProtectedRefusals()

    // C protects nothing, so its own cap is not the bound that refuses it.
    await expect(startTransfer(store, rootC, C, 40, 1)).rejects.toMatchObject({
      code: 'host_quota_exceeded',
    })
    expect(await hostProtectedRefusals()).toBe(hostBefore + 1)
    expect(await protectedRefusals()).toBe(callerBefore)

    // Witness: the same request is admitted once B's pins are released.
    await store.releaseReceiptOwner('task-b', B)
    const admitted = await startTransfer(store, rootC, C, 40, 1)
    await store.fail(admitted.transfer.id, C)
    expect(await hostProtectedRefusals()).toBe(hostBefore + 1)
  })

  it('a refused caller gets the same error object as a Host-wide refusal', async () => {
    const store = await openStore()
    await copies(store, rootA, A, 0, 4, 'task-a')
    await completedCopy(store, rootA, A, 8, 2, { owner: 'task-a' })
    // A protects 22: its 21-byte request exceeds its own cap of 42.
    const protectedBefore = await protectedRefusals()
    const capRefusal = await startTransfer(store, rootA, A, 9, 21).catch(error => error)
    expect(await protectedRefusals()).toBe(protectedBefore + 1)

    // B pins 40 beside A's 22: 62, so C's 4 bytes exceed the Host-wide cap
    // of 63 while C protects nothing.
    await copies(store, rootB, B, 20, 8, 'task-b')
    const hostBefore = await hostProtectedRefusals()
    const hostRefusal = await startTransfer(store, rootC, C, 40, 4).catch(error => error)
    expect(await hostProtectedRefusals()).toBe(hostBefore + 1)
    expect(await protectedRefusals()).toBe(protectedBefore + 1)
    expect(hostRefusal).toBeInstanceOf(GfsDownloadStoreError)
    expect(capRefusal).toBeInstanceOf(GfsDownloadStoreError)
    expect({ code: capRefusal.code, message: capRefusal.message }).toEqual({
      code: hostRefusal.code,
      message: hostRefusal.message,
    })
  })

  it('HOST-CAP: two callers each under their own cap are refused once their sum would exceed three quarters of the budget, and admitted after a release', async () => {
    const store = await openStore()
    // A pins 40 and B 20: each under its own cap of 42, 60 together.
    await copies(store, rootA, A, 0, 8, 'task-a')
    await copies(store, rootB, B, 20, 4, 'task-b')
    const callerBefore = await protectedRefusals()
    const hostBefore = await hostProtectedRefusals()

    // B's 5 more would leave B at 25 of its 42, but the Host at 65 of 63.
    await expect(startTransfer(store, rootB, B, 30, 5)).rejects.toMatchObject({
      code: 'host_quota_exceeded',
    })
    expect(await hostProtectedRefusals()).toBe(hostBefore + 1)
    expect(await protectedRefusals()).toBe(callerBefore)

    // Witness: the same request is admitted once A's pins are released.
    await store.releaseReceiptOwner('task-a', A)
    const admitted = await startTransfer(store, rootB, B, 30, 5)
    await store.fail(admitted.transfer.id, B)
    expect(await hostProtectedRefusals()).toBe(hostBefore + 1)
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
    // B holds 80 unpinned bytes, so A's 43 bytes would need eviction: a cap
    // check placed after reclaimForAdmission would delete B's copies first.
    const others = await copies(store, rootB, B, 0, 16)
    const before = await protectedRefusals()

    await expect(startTransfer(store, rootA, A, 100, 43)).rejects.toMatchObject({
      code: 'host_quota_exceeded',
    })
    expect(await protectedRefusals()).toBe(before + 1)
    for (const receipt of others) expect(exists(downloadDirectory(rootB, receipt.id))).toBe(true)
    const admitted = await startTransfer(store, rootA, A, 101, 42)
    await store.fail(admitted.transfer.id, A)
    expect(await protectedRefusals()).toBe(before + 1)
  })

  it('SOL-R4-ORDER: a caller at its cap is refused before eviction, so a full budget keeps the other caller copies', async () => {
    const store = await openStore()
    // B first: 43 unpinned bytes. Then A pins 42, the cap: 85 of 85.
    const others = [
      ...(await copies(store, rootB, B, 0, 8)),
      (await completedCopy(store, rootB, B, 8, 3)).receipt,
    ]
    await copies(store, rootA, A, 20, 8, 'task-a')
    await completedCopy(store, rootA, A, 28, 2, { owner: 'task-a' })
    const before = await protectedRefusals()

    await expect(startTransfer(store, rootA, A, 30, 1)).rejects.toMatchObject({
      code: 'host_quota_exceeded',
    })
    expect(await protectedRefusals()).toBe(before + 1)
    for (const receipt of others) expect(exists(downloadDirectory(rootB, receipt.id))).toBe(true)

    // Releasing A's owner unpins its 42 bytes: the same byte is admitted.
    await store.releaseReceiptOwner('task-a', A)
    const admitted = await startTransfer(store, rootA, A, 31, 1)
    await store.fail(admitted.transfer.id, A)
    expect(await protectedRefusals()).toBe(before + 1)
  })
})

describe('GFS download store: retention pins never outlive expiresAt (Addendum 10)', () => {
  it('an expired copy still on disk is not reused', async () => {
    const store = await openStore()
    const pinned = await completedCopy(store, rootA, A, 0, 10, { owner: 'task-a' })
    const directory = downloadDirectory(rootA, pinned.receipt.id)
    // Witness: before expiry the same lookup reuses the copy.
    await expect(store.reusableReceipt(A, sourceFor(0), 10)).resolves.toMatchObject({
      id: pinned.receipt.id,
    })

    // Past expiresAt with no sweep in between: the copy is still on disk.
    vi.setSystemTime(Date.now() + 2 * HOUR_MS)
    await expect(store.reusableReceipt(A, sourceFor(0), 10)).resolves.toBeUndefined()
    await expect(
      store.reusableReceipt(A, sourceFor(0), 10, { retentionOwnerId: 'task-b' })
    ).resolves.toBeUndefined()
    expect(exists(directory)).toBe(true)
    await expect(store.readManagedFile(pinned.receipt.path, A)).rejects.toMatchObject({
      code: 'download_expired',
    })

    // Witness: a fresh download of the same source is published and served.
    const fresh = await completedCopy(store, rootA, A, 0, 10, { owner: 'task-b' })
    expect(fresh.receipt.id).not.toBe(pinned.receipt.id)
    await expect(store.readManagedFile(fresh.receipt.path, A)).resolves.toEqual(fresh.bytes)
  })

  it('the sweep removes a pinned copy once it is past its expiry', async () => {
    const store = await openStore()
    const pinned = await completedCopy(store, rootA, A, 0, 10, { owner: 'task-a' })
    const directory = downloadDirectory(rootA, pinned.receipt.id)

    // Witness: before expiry the same sweep keeps the pinned copy readable.
    expect((await store.cleanupExpired()).removedExpired).toBe(0)
    expect(exists(directory)).toBe(true)
    await expect(store.readManagedFile(pinned.receipt.path, A)).resolves.toEqual(pinned.bytes)

    // Past expiresAt, the owner still open: removed anyway.
    vi.setSystemTime(Date.now() + 2 * HOUR_MS)
    expect((await store.cleanupExpired()).removedExpired).toBe(1)
    expect(exists(directory)).toBe(false)
    await expect(store.readManagedFile(pinned.receipt.path, A)).rejects.toMatchObject({
      code: 'download_missing',
    })
  })

  it('an expired pinned copy stops counting toward its caller cap without releasing the owner', async () => {
    const store = await openStore()
    // A 20-byte unpinned copy that lives a day (first: its open reservation
    // beside 30 pinned bytes would itself exceed the cap), then 30 pinned
    // bytes expiring in one hour. Pinning the first one would make 50.
    const lasting = await completedCopy(store, rootA, A, 1, 20, {
      expiresAt: new Date(Date.now() + 24 * HOUR_MS).toISOString(),
    })
    await completedCopy(store, rootA, A, 0, 30, { owner: 'task-a' })
    const before = await protectedRefusals()
    await expect(
      store.reusableReceipt(A, sourceFor(1), 20, { retentionOwnerId: 'task-b' })
    ).rejects.toMatchObject({ code: 'host_quota_exceeded' })
    expect(await protectedRefusals()).toBe(before + 1)

    // Two hours later, with no sweep between and task-a never released, the
    // expired 30 bytes protect nothing: the same pin is admitted.
    vi.setSystemTime(Date.now() + 2 * HOUR_MS)
    await expect(
      store.reusableReceipt(A, sourceFor(1), 20, { retentionOwnerId: 'task-b' })
    ).resolves.toMatchObject({ id: lasting.receipt.id })
    expect(await protectedRefusals()).toBe(before + 1)

    // A new reservation is admitted under the cap as well: 20 + 22 = 42.
    const admitted = await startTransfer(store, rootA, A, 2, 22)
    await store.fail(admitted.transfer.id, A)
    expect(await protectedRefusals()).toBe(before + 1)
  })

  it('eviction reclaims an expired pinned copy the admission sweep could not inspect, and keeps unexpired pins', async () => {
    const store = await openStore()
    // 40 unpinned bytes that live a day come first. Then A pins 22 bytes for
    // two hours and B pins 20 bytes for a day: 82 of 85.
    const lastingExpiry = new Date(Date.now() + 24 * HOUR_MS).toISOString()
    const loose = [
      await completedCopy(store, rootC, C, 3, 20, { expiresAt: lastingExpiry }),
      await completedCopy(store, rootC, C, 4, 20, { expiresAt: lastingExpiry }),
    ]
    const expiring = await completedCopy(store, rootA, A, 0, 22, { owner: 'task-a' })
    const lasting = await completedCopy(store, rootB, B, 1, 20, {
      owner: 'task-b',
      expiresAt: lastingExpiry,
    })
    vi.setSystemTime(Date.now() + 3 * HOUR_MS)
    // Reading the loose copies makes A's expired copy the least recently used.
    for (const copy of loose)
      await expect(store.readManagedFile(copy.receipt.path, C)).resolves.toEqual(copy.bytes)

    // The admission sweep removes expired copies before eviction plans, so
    // the eviction path is isolated by making the sweep's one inspection of
    // A's copy fail transiently: the sweep keeps it indexed, unexamined.
    const sourceSuffix = path.join(`input-${expiring.receipt.id}`, 'source')
    let injected = 0
    const passThrough = lstatBoundary.getMockImplementation()!
    lstatBoundary.mockImplementation((...args: unknown[]) => {
      if (injected === 0 && String(args[0]).endsWith(sourceSuffix)) {
        injected += 1
        return Promise.reject(ioError('EIO'))
      }
      return passThrough(...args)
    })

    // C's 5 bytes need 2 bytes evicted: A's expired copy, first in order, gives them.
    const admitted = await startTransfer(store, rootC, C, 2, 5)
    expect(injected).toBe(1)
    expect(exists(downloadDirectory(rootA, expiring.receipt.id))).toBe(false)
    expect(exists(downloadDirectory(rootB, lasting.receipt.id))).toBe(true)
    await expect(store.readManagedFile(lasting.receipt.path, B)).resolves.toEqual(lasting.bytes)
    for (const copy of loose) expect(exists(downloadDirectory(rootC, copy.receipt.id))).toBe(true)
    await store.fail(admitted.transfer.id, C)
  })
})

describe('GFS download store: re-pinning an already protected copy (R4-F1)', () => {
  it('reuses a copy the caller already protects without measuring the volume', async () => {
    const store = await openStore()
    const held = await completedCopy(store, rootA, A, 0, 30, { owner: 'task-a' })
    await completedCopy(store, rootA, A, 1, 5)
    statfsBoundary.mockRejectedValueOnce(ioError('EIO'))
    const callsBefore = statfsBoundary.mock.calls.length

    // Already pinned by task-a: task-b's pin adds nothing and needs no statfs,
    // so the armed EIO is not consumed.
    await expect(
      store.reusableReceipt(A, sourceFor(0), 30, { retentionOwnerId: 'task-b' })
    ).resolves.toMatchObject({ id: held.receipt.id })
    expect(statfsBoundary.mock.calls.length).toBe(callsBefore)

    // Control: a copy A does not protect yet must size the budget, and the
    // same armed EIO refuses it with that exact errno.
    await expect(
      store.reusableReceipt(A, sourceFor(1), 5, { retentionOwnerId: 'task-b' })
    ).rejects.toMatchObject({ code: 'EIO', message: 'EIO: injected by the test' })
    expect(statfsBoundary.mock.calls.length).toBe(callsBefore + 1)
  })
})

describe('GFS download store: pins are per caller and per process (F24/U4 ported)', () => {
  it('releasing an owner id unpins only the releasing caller; the same id under another caller keeps counting', async () => {
    const store = await openStore()
    // A pins 22 and B pins 39, both under the same owner id: 61 of the
    // Host-wide cap of 63.
    await copies(store, rootA, A, 0, 4, 'task-shared')
    await completedCopy(store, rootA, A, 8, 2, { owner: 'task-shared' })
    await copies(store, rootB, B, 20, 7, 'task-shared')
    await completedCopy(store, rootB, B, 27, 4, { owner: 'task-shared' })
    const before = await protectedRefusals()
    const hostBefore = await hostProtectedRefusals()

    // Before any release B is refused by the Host-wide cap: 61 + 3 > 63, while
    // B itself stays at its cap, 39 + 3 = 42.
    await expect(startTransfer(store, rootB, B, 30, 3)).rejects.toMatchObject({
      code: 'host_quota_exceeded',
    })
    expect(await hostProtectedRefusals()).toBe(hostBefore + 1)

    await expect(store.releaseReceiptOwner('task-shared', B)).resolves.toBeUndefined()
    await expect(store.releaseReceiptOwner('unknown-owner', A)).resolves.toBeUndefined()

    // B's release freed B: its 3 bytes are admitted (22 + 3 protected).
    const admittedB = await startTransfer(store, rootB, B, 31, 3)
    await store.fail(admittedB.transfer.id, B)
    expect(await hostProtectedRefusals()).toBe(hostBefore + 1)
    // A's pin under the same id still counts toward A's cap: 22 + 21 > 42 is
    // refused, 22 + 20 is admitted.
    await expect(startTransfer(store, rootA, A, 32, 21)).rejects.toMatchObject({
      code: 'host_quota_exceeded',
    })
    expect(await protectedRefusals()).toBe(before + 1)
    const admittedA = await startTransfer(store, rootA, A, 33, 20)
    await store.fail(admittedA.transfer.id, A)
  })

  it('a second store on the same root holds no pins', async () => {
    const first = await openStore()
    await copies(first, rootA, A, 0, 8, 'task-a')
    await completedCopy(first, rootA, A, 8, 2, { owner: 'task-a' })
    const before = await protectedRefusals()
    // Witness: in the first store A's pins hold it at the cap.
    await expect(startTransfer(first, rootA, A, 9, 1)).rejects.toMatchObject({
      code: 'host_quota_exceeded',
    })
    expect(await protectedRefusals()).toBe(before + 1)

    await first.close(0)
    const second = await openStore()
    const admitted = await startTransfer(second, rootA, A, 10, 1)
    await second.fail(admitted.transfer.id, A)
    expect(await protectedRefusals()).toBe(before + 1)
  })
})
