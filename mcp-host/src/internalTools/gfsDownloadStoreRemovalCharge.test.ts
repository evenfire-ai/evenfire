/**
 * Removal-charge accounting of the GFS download store.
 *
 * Whenever a removal leaves bytes on disk (in place, or under a `.trash-` name), those bytes stay
 * charged against the Host budget until the directory is removed or confirmed absent. Each test
 * runs on a coherent simulated volume (1000 MiB at 1%, so a 10 MiB budget) whose free space is the
 * source bytes actually present, injects one filesystem fault, asserts the refusal, then clears the
 * fault and proves the store recovers with a fresh publish and read.
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
  plantDownload,
  quotaCount,
  sourceFor,
  startTransfer,
  withEnvironment,
} from '../__tests__/fixtures/gfsStoreTestKit'
import type { GfsDownloadStore } from './gfsDownloadStore'

const boundaries = vi.hoisted(() => ({
  open: vi.fn(),
  statfs: vi.fn(),
  rm: vi.fn(),
  rename: vi.fn(),
  realpath: vi.fn(),
  lstat: vi.fn(),
  readdir: vi.fn(),
}))
vi.mock('node:fs/promises', async original => ({
  ...(await original<typeof fs>()),
  ...boundaries,
}))

const MIB = 1024 * 1024
const HOUR = 60 * 60_000
const TOTAL = 1000n * BigInt(MIB)
let nativeFs: typeof fs
let hostRoot: string
let roots: Record<string, string>
const stores: GfsDownloadStore[] = []
const releases: Array<() => void> = []
const eio = () => Object.assign(new Error('EIO: injected fault'), { code: 'EIO' })

function storedBytes(directory: string): number {
  let sum = 0
  for (const child of syncFs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, child.name)
    if (child.isDirectory()) sum += storedBytes(target)
    else if (child.isFile() && ['source', 'source.partial'].includes(child.name))
      sum += syncFs.statSync(target).size
  }
  return sum
}

// Every regular file, `meta.json` included: what a chargeless measurement counts.
function regularBytes(directory: string): number {
  let sum = 0
  for (const child of syncFs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, child.name)
    if (child.isDirectory()) sum += regularBytes(target)
    else if (child.isFile()) sum += syncFs.statSync(target).size
  }
  return sum
}

function view(store: GfsDownloadStore) {
  const state = store as unknown as {
    entries: Map<string, { sizeBytes: number }>
    active: Map<string, { sizeBytes: number }>
    held: Map<string, { sizeBytes: number }>
    pins: Map<string, Set<string>>
  }
  const sum = (map: Map<string, { sizeBytes: number }>) =>
    [...map.values()].reduce((n, item) => n + item.sizeBytes, 0)
  return {
    state,
    entries: sum(state.entries),
    active: sum(state.active),
    held: sum(state.held),
    charged: sum(state.entries) + sum(state.active) + sum(state.held),
  }
}

function restoreBoundary(name: keyof typeof boundaries): void {
  boundaries[name].mockReset()
  boundaries[name].mockImplementation((...args: unknown[]) =>
    Reflect.apply(nativeFs[name] as (...args: unknown[]) => unknown, nativeFs, args)
  )
}

async function storeWithBudget(): Promise<GfsDownloadStore> {
  return withEnvironment({ MCP_HOST_GFS_DOWNLOAD_STORAGE_PERCENT: '1' }, async () => {
    vi.resetModules()
    const { GfsDownloadStore: Store } = await import('./gfsDownloadStore')
    const store = new Store(hostRoot) as GfsDownloadStore
    stores.push(store)
    await store.initialize()
    return store
  })
}

function failTrashRemoval(): string[] {
  const hits: string[] = []
  boundaries.rm.mockImplementation((...args: unknown[]) => {
    if (path.basename(String(args[0])).startsWith('.trash-')) {
      hits.push(String(args[0]))
      return Promise.reject(eio())
    }
    return Reflect.apply(nativeFs.rm, nativeFs, args)
  })
  return hits
}

async function expiredTrash(store: GfsDownloadStore) {
  await completedCopy(store, roots.a, 'a', 1, 4 * MIB, { owner: 'owner-a' })
  await completedCopy(store, roots.b, 'b', 2, 4 * MIB, { owner: 'owner-b' })
  vi.setSystemTime(Date.now() + 2 * HOUR)
  const hits = failTrashRemoval()
  expect((await store.cleanupExpired()).removeFailed).toBe(2)
  expect(hits).toHaveLength(2)
  expect(storedBytes(hostRoot)).toBe(8 * MIB)
  expect(view(store)).toMatchObject({ entries: 0, active: 0, held: 8 * MIB, charged: 8 * MIB })
  return hits
}

/** 8 MiB stay on disk, so a third 4 MiB admission would exceed the 10 MiB budget. */
async function expectRefused(store: GfsDownloadStore): Promise<void> {
  await expect(startTransfer(store, roots.c, 'c', 3, 4 * MIB)).rejects.toMatchObject({
    code: 'host_quota_exceeded',
  })
}

/** Clears every fault, lets cleanup remove the leftovers, then publishes and reads a fresh copy. */
async function recoverAndWitness(store: GfsDownloadStore): Promise<void> {
  for (const name of ['rm', 'rename', 'realpath', 'open'] as const) restoreBoundary(name)
  await store.cleanupExpired()
  expect(storedBytes(hostRoot)).toBe(0)
  const fresh = await completedCopy(store, roots.c, 'c', 3, 4 * MIB, { owner: 'fresh' })
  expect((await store.readManagedFile(fresh.receipt.path, 'c')).equals(fresh.bytes)).toBe(true)
  expect(view(store).charged).toBe(4 * MIB)
}

beforeEach(async () => {
  nativeFs = await vi.importActual<typeof fs>('node:fs/promises')
  for (const name of Object.keys(boundaries) as Array<keyof typeof boundaries>)
    restoreBoundary(name)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-08T12:00:00Z'))
  hostRoot = await nativeFs.realpath(syncFs.mkdtempSync(path.join(tmpdir(), 'gfs-removal-charge-')))
  roots = Object.fromEntries(['a', 'b', 'c', 'd'].map(id => [id, callerDirectory(hostRoot, id)]))
  boundaries.statfs.mockImplementation(async (target: string) => ({
    ...(await nativeFs.statfs(target, { bigint: true })),
    bsize: 1n,
    blocks: TOTAL,
    bavail: TOTAL - BigInt(storedBytes(hostRoot)),
  }))
})

afterEach(async () => {
  for (const release of releases.splice(0)) release()
  vi.restoreAllMocks()
  vi.useRealTimers()
  for (const store of stores.splice(0)) await store.close(0)
  await nativeFs.rm(hostRoot, { recursive: true, force: true })
})

describe('GFS download store removal charges', () => {
  it('RC-UNDO-FAIL: post-rename verification and undo failures retain the renamed bytes', async () => {
    const store = await storeWithBudget()
    await completedCopy(store, roots.a, 'a', 1, 4 * MIB, { owner: 'a-owner' })
    await completedCopy(store, roots.b, 'b', 2, 4 * MIB, { owner: 'b-owner' })
    vi.setSystemTime(Date.now() + 2 * HOUR)
    const checkFault = new Set<string>()
    const undone: string[] = []
    boundaries.rename.mockImplementation(async (...args: unknown[]) => {
      const from = String(args[0])
      const to = String(args[1])
      if (path.basename(from).startsWith('.trash-') && path.basename(to).startsWith('input-')) {
        undone.push(from)
        throw eio()
      }
      const result = await Reflect.apply(nativeFs.rename, nativeFs, args)
      if (path.basename(from).startsWith('input-') && path.basename(to).startsWith('.trash-'))
        checkFault.add(path.dirname(to))
      return result
    })
    boundaries.realpath.mockImplementation(async (...args: unknown[]) => {
      if (checkFault.delete(String(args[0]))) throw eio()
      return Reflect.apply(nativeFs.realpath, nativeFs, args)
    })
    failTrashRemoval()
    expect((await store.cleanupExpired()).removeFailed).toBe(2)
    expect(undone).toHaveLength(2)
    expect(storedBytes(hostRoot)).toBe(8 * MIB)
    // The carried charges moved to the trash names in this sweep, not in a later one.
    expect(view(store)).toMatchObject({ entries: 0, held: 8 * MIB, charged: 8 * MIB })
    expect([...view(store).state.held.keys()].sort()).toEqual([...undone].sort())
    await expectRefused(store)
    await recoverAndWitness(store)
  })

  it.each(['partial', 'post-source-rename'] as const)(
    'RC-FAILED-TRANSFER-%s: failed transfer trash keeps its former reservation charged',
    async stage => {
      const store = await storeWithBudget()
      const attempts = []
      for (const [index, caller] of ['a', 'b'].entries()) {
        const attempt = await startTransfer(store, roots[caller], caller, index, 4 * MIB)
        attempts.push({ ...attempt, caller })
        if (stage === 'post-source-rename') {
          const directory = downloadDirectory(roots[caller], attempt.transfer.id)
          boundaries.open.mockImplementation(async (...args: unknown[]) => {
            const handle = (await Reflect.apply(nativeFs.open, nativeFs, args)) as fs.FileHandle
            if (String(args[0]) === directory) vi.spyOn(handle, 'sync').mockRejectedValueOnce(eio())
            return handle
          })
          await expect(
            store.publish(attempt.transfer.id, caller, digestOf(attempt.bytes))
          ).rejects.toMatchObject({ code: 'storage_write_failed' })
          expect(syncFs.existsSync(path.join(directory, 'source'))).toBe(true)
          expect(syncFs.existsSync(path.join(directory, 'meta.json'))).toBe(true)
          restoreBoundary('open')
        }
      }
      expect(view(store).active).toBe(8 * MIB)
      const hits = failTrashRemoval()
      for (const attempt of attempts)
        await expect(store.fail(attempt.transfer.id, attempt.caller)).rejects.toMatchObject({
          code: 'storage_write_failed',
        })
      expect(hits).toHaveLength(2)
      expect(storedBytes(hostRoot)).toBe(8 * MIB)
      // Each reservation moved, unchanged, to the trash name its removal left.
      expect(view(store)).toMatchObject({ active: 0, held: 8 * MIB, charged: 8 * MIB })
      expect([...view(store).state.held.keys()].sort()).toEqual([...hits].sort())
      await expectRefused(store)
      await recoverAndWitness(store)
    }
  )

  it('RC-NO-DOUBLE-CHARGE: repeated trash failures charge exactly once and admission at the remainder works', async () => {
    const store = await storeWithBudget()
    await expiredTrash(store)
    for (let i = 0; i < 4; i++) {
      expect((await store.cleanupExpired()).removeFailed).toBe(2)
      expect(view(store)).toMatchObject({ held: 8 * MIB, charged: 8 * MIB })
      expect(storedBytes(hostRoot)).toBe(8 * MIB)
    }
    await expect(startTransfer(store, roots.c, 'c', 3, 4 * MIB)).rejects.toMatchObject({
      code: 'host_quota_exceeded',
    })
    const fits = await startTransfer(store, roots.c, 'c', 4, 2 * MIB)
    expect(view(store).charged).toBe(10 * MIB)
    expect(storedBytes(hostRoot)).toBe(10 * MIB)
    restoreBoundary('rm')
    await store.fail(fits.transfer.id, 'c')
    await store.cleanupExpired()
    expect(view(store).charged).toBe(0)
    await expect(startTransfer(store, roots.c, 'c', 3, 4 * MIB)).resolves.toBeDefined()
  })

  it.each(['file', 'missing', 'parent-file'] as const)(
    'RC-TRASH-ABSENCE-%s: definitive absence releases a held trash charge despite a failed listing',
    async replacement => {
      const store = await storeWithBudget()
      const hits = await expiredTrash(store)
      await expect(startTransfer(store, roots.c, 'c', 3, 4 * MIB)).rejects.toMatchObject({
        code: 'host_quota_exceeded',
      })
      const trash = [...view(store).state.held.keys()].find(p =>
        p.includes(`${path.sep}a${path.sep}`)
      )!
      expect(hits.length).toBeGreaterThanOrEqual(4)
      if (replacement === 'parent-file') {
        syncFs.rmSync(path.dirname(trash), { recursive: true, force: true })
        syncFs.writeFileSync(path.dirname(trash), '', { mode: 0o600 })
        await expect(nativeFs.lstat(trash)).rejects.toMatchObject({ code: 'ENOTDIR' })
      } else {
        syncFs.rmSync(trash, { recursive: true, force: true })
        if (replacement === 'file') syncFs.writeFileSync(trash, '', { mode: 0o600 })
        else await expect(nativeFs.lstat(trash)).rejects.toMatchObject({ code: 'ENOENT' })
      }
      const listed: string[] = []
      boundaries.readdir.mockImplementation((...args: unknown[]) => {
        if (String(args[0]) === path.join(roots.a, '.gfs-downloads')) {
          listed.push(String(args[0]))
          return Promise.reject(eio())
        }
        return Reflect.apply(nativeFs.readdir, nativeFs, args)
      })
      const fits = await startTransfer(store, roots.c, 'c', 3, 4 * MIB)
      expect(view(store)).toMatchObject({ held: 4 * MIB, active: 4 * MIB, charged: 8 * MIB })
      expect(storedBytes(hostRoot)).toBe(8 * MIB)
      if (replacement !== 'parent-file') expect(listed.length).toBeGreaterThan(0)
      restoreBoundary('rm')
      await store.fail(fits.transfer.id, 'c')
    }
  )

  it('RC-TRASH-UNKNOWN: failed listing and EIO probing retain trash charges until cleanup recovers', async () => {
    const store = await storeWithBudget()
    await expiredTrash(store)
    const trash = new Set(view(store).state.held.keys())
    const probed: string[] = []
    boundaries.readdir.mockImplementation((...args: unknown[]) => {
      if (String(args[0]).endsWith('.gfs-downloads')) return Promise.reject(eio())
      return Reflect.apply(nativeFs.readdir, nativeFs, args)
    })
    boundaries.lstat.mockImplementation((...args: unknown[]) => {
      if (trash.has(String(args[0]))) {
        probed.push(String(args[0]))
        return Promise.reject(eio())
      }
      return Reflect.apply(nativeFs.lstat, nativeFs, args)
    })
    await expect(startTransfer(store, roots.c, 'c', 3, 4 * MIB)).rejects.toMatchObject({
      code: 'host_quota_exceeded',
    })
    expect(probed).toHaveLength(2)
    expect(view(store).held).toBe(8 * MIB)
    for (const name of ['readdir', 'lstat', 'rm'] as const) restoreBoundary(name)
    expect((await store.cleanupExpired()).removedIncomplete).toBe(2)
    expect(view(store).charged).toBe(0)
    const fresh = await completedCopy(store, roots.c, 'c', 3, 4 * MIB)
    expect((await store.readManagedFile(fresh.receipt.path, 'c')).equals(fresh.bytes)).toBe(true)
  })

  it('RC-SERIAL-SWEEPS: concurrent admission and cleanup queue behind the pre-check sweep and preserve live pins and active transfers', async () => {
    const store = await storeWithBudget()
    const expiry = new Date(Date.now() + 24 * HOUR).toISOString()
    const live = await completedCopy(store, roots.a, 'a', 0, 2 * MIB, {
      owner: 'live',
      expiresAt: expiry,
    })
    const active = await startTransfer(store, roots.a, 'a', 1, 2 * MIB, { expiresAt: expiry })
    const expiring = await completedCopy(store, roots.b, 'b', 2, 4 * MIB, { owner: 'expire' })
    vi.setSystemTime(Date.now() + 2 * HOUR)
    let enter!: () => void
    let release!: () => void
    const entered = new Promise<void>(resolve => {
      enter = resolve
    })
    const released = new Promise<void>(resolve => {
      release = resolve
    })
    releases.push(release)
    let armed = true
    boundaries.rm.mockImplementation(async (...args: unknown[]) => {
      if (armed && path.basename(String(args[0])).startsWith('.trash-')) {
        armed = false
        enter()
        await released
      }
      return Reflect.apply(nativeFs.rm, nativeFs, args)
    })
    boundaries.statfs.mockClear()
    const first = startTransfer(store, roots.c, 'c', 3, 4 * MIB)
    await entered
    let secondSettled = false
    let cleanupSettled = false
    const second = startTransfer(store, roots.d, 'd', 4, 4 * MIB).then(
      value => {
        secondSettled = true
        return value
      },
      error => {
        secondSettled = true
        return error as { code: string }
      }
    )
    const cleanup = store.cleanupExpired().then(value => {
      cleanupSettled = true
      return value
    })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(secondSettled).toBe(false)
    expect(cleanupSettled).toBe(false)
    expect(boundaries.statfs).not.toHaveBeenCalled()
    release()
    const admitted = await first
    await expect(second).resolves.toMatchObject({ code: 'download_busy' })
    await cleanup
    expect(secondSettled).toBe(true)
    expect(cleanupSettled).toBe(true)
    expect(syncFs.existsSync(downloadDirectory(roots.b, expiring.receipt.id))).toBe(false)
    expect(
      syncFs.readFileSync(path.join(roots.a, active.transfer.partialPath)).equals(active.bytes)
    ).toBe(true)
    expect((await store.readManagedFile(live.receipt.path, 'a')).equals(live.bytes)).toBe(true)
    await expect(store.readManagedFile(live.receipt.path, 'd')).rejects.toMatchObject({
      code: 'download_missing',
      message: 'GFS download store failed (download_missing)',
    })
    expect(view(store).charged).toBe(8 * MIB)
    await store.fail(active.transfer.id, 'a')
    const next = await startTransfer(store, roots.d, 'd', 4, 4 * MIB)
    expect(view(store).charged).toBe(10 * MIB)
    expect((await store.readManagedFile(live.receipt.path, 'a')).equals(live.bytes)).toBe(true)
    await store.fail(admitted.transfer.id, 'c')
    await store.fail(next.transfer.id, 'd')
  })

  it.each([false, true])(
    'RC-REUSE-UNPINNED-%s: post-hash expiry is a miss with and without a new retention owner',
    async owner => {
      const store = await storeWithBudget()
      const copy = await completedCopy(store, roots.a, 'a', 0, 1024)
      await expect(store.reusableReceipt('a', sourceFor(0), 1024)).resolves.toMatchObject({
        id: copy.receipt.id,
      })
      vi.setSystemTime(Date.parse(copy.receipt.expiresAt) - 1)
      let enter!: () => void
      let release!: () => void
      const entered = new Promise<void>(resolve => {
        enter = resolve
      })
      const released = new Promise<void>(resolve => {
        release = resolve
      })
      releases.push(release)
      let armed = true
      boundaries.open.mockImplementation(async (...args: unknown[]) => {
        const handle = (await Reflect.apply(nativeFs.open, nativeFs, args)) as fs.FileHandle
        if (armed && String(args[0]).endsWith(`${path.sep}source`)) {
          armed = false
          const read = handle.read.bind(handle)
          vi.spyOn(handle, 'read').mockImplementationOnce(async (...readArgs: unknown[]) => {
            enter()
            await released
            return Reflect.apply(read, handle, readArgs)
          })
        }
        return handle
      })
      const reuse = store.reusableReceipt(
        'a',
        sourceFor(0),
        1024,
        owner ? { retentionOwnerId: 'new-owner' } : undefined
      )
      await entered
      vi.setSystemTime(Date.parse(copy.receipt.expiresAt))
      release()
      await expect(reuse).resolves.toBeUndefined()
      expect(view(store).state.pins.size).toBe(0)
      await store.cleanupExpired()
      const fresh = await completedCopy(store, roots.a, 'a', 0, 1024, { owner: 'new-owner' })
      expect((await store.readManagedFile(fresh.receipt.path, 'a')).equals(fresh.bytes)).toBe(true)
    }
  )

  it('RC-RESTART-TRASH: trash that survives startup cleanup remains charged after reopening the store', async () => {
    const original = await storeWithBudget()
    const hits = await expiredTrash(original)
    await original.close(0)
    const reopened = await storeWithBudget()
    expect(hits).toHaveLength(4)
    expect(storedBytes(hostRoot)).toBe(8 * MIB)
    // Measured once on restart: both trees' regular files, meta.json included.
    expect(regularBytes(hostRoot)).toBeGreaterThan(8 * MIB)
    expect(view(reopened).held).toBe(regularBytes(hostRoot))
    await expectRefused(reopened)
    await recoverAndWitness(reopened)
  })

  it('RC-FAIL-BEFORE-RENAME: a failed transfer still in its original incomplete directory retains its charge', async () => {
    const store = await storeWithBudget()
    const a = await startTransfer(store, roots.a, 'a', 1, 4 * MIB)
    const b = await startTransfer(store, roots.b, 'b', 2, 4 * MIB)
    const hits: string[] = []
    boundaries.rename.mockImplementation((...args: unknown[]) => {
      if (path.basename(String(args[0])).startsWith('input-')) {
        hits.push(String(args[0]))
        return Promise.reject(eio())
      }
      return Reflect.apply(nativeFs.rename, nativeFs, args)
    })
    await expect(store.fail(a.transfer.id, 'a')).rejects.toMatchObject({
      code: 'storage_write_failed',
    })
    await expect(store.fail(b.transfer.id, 'b')).rejects.toMatchObject({
      code: 'storage_write_failed',
    })
    expect(hits).toHaveLength(2)
    expect(storedBytes(hostRoot)).toBe(8 * MIB)
    expect(view(store).held).toBe(8 * MIB)
    await expectRefused(store)
    expect(hits).toHaveLength(4)
    await recoverAndWitness(store)
  })

  it.each([false, true])(
    'RC-VOLUME-SECOND-CHECK-%s: the post-reclaim measurement retries invalid readings and retains the correct error',
    async persistent => {
      const store = await storeWithBudget()
      const valid = {
        ...(await nativeFs.statfs(hostRoot, { bigint: true })),
        bsize: 1n,
        blocks: TOTAL,
        bavail: TOTAL,
      }
      const invalid = { ...valid, bavail: -1n }
      boundaries.statfs.mockReset()
      boundaries.statfs
        .mockResolvedValueOnce(valid)
        .mockResolvedValueOnce(invalid)
        .mockResolvedValueOnce(persistent ? invalid : valid)
      const before = await quotaCount('host', 'free_space')
      const budgetBefore = await quotaCount('host', 'storage_bytes')
      const outcome = await startTransfer(store, roots.a, 'a', 1, 1024).then(
        admitted => ({ admitted }),
        error => error as { code: string; message: string }
      )
      expect(boundaries.statfs).toHaveBeenCalledTimes(3)
      expect(await quotaCount('host', 'storage_bytes')).toBe(budgetBefore)
      if (persistent) {
        expect(outcome).toMatchObject({
          code: 'volume_unmeasurable',
          message: 'GFS download store failed (volume_unmeasurable)',
        })
        expect(await quotaCount('host', 'free_space')).toBe(before + 1)
        expect(view(store).active).toBe(0)
      } else {
        expect('admitted' in outcome).toBe(true)
        expect(await quotaCount('host', 'free_space')).toBe(before)
        if ('admitted' in outcome) await store.fail(outcome.admitted.transfer.id, 'a')
      }
      boundaries.statfs.mockResolvedValue(valid)
      const fresh = await startTransfer(store, roots.a, 'a', 1, 1024)
      await store.fail(fresh.transfer.id, 'a')
    }
  )

  it.each([false, true])(
    'RC-VOLUME-REUSE-%s: a new retention owner shares the invalid-statfs retry and category',
    async persistent => {
      const store = await storeWithBudget()
      const copy = await completedCopy(store, roots.a, 'a', 0, 1024)
      const valid = {
        ...(await nativeFs.statfs(hostRoot, { bigint: true })),
        bsize: 1n,
        blocks: TOTAL,
        bavail: TOTAL,
      }
      boundaries.statfs.mockReset()
      boundaries.statfs
        .mockResolvedValueOnce({ ...valid, bsize: 0n })
        .mockResolvedValueOnce(persistent ? { ...valid, bsize: 0n } : valid)
      const before = await quotaCount('host', 'free_space')
      const outcome = await store
        .reusableReceipt('a', sourceFor(0), 1024, { retentionOwnerId: 'new' })
        .then(
          receipt => ({ receipt }),
          error => error as { code: string; message: string }
        )
      expect(boundaries.statfs).toHaveBeenCalledTimes(2)
      if (persistent) {
        expect(outcome).toMatchObject({
          code: 'volume_unmeasurable',
          message: 'GFS download store failed (volume_unmeasurable)',
        })
        expect(await quotaCount('host', 'free_space')).toBe(before + 1)
        expect(view(store).state.pins.size).toBe(0)
      } else {
        expect(outcome).toMatchObject({ receipt: { id: copy.receipt.id } })
        expect(await quotaCount('host', 'free_space')).toBe(before)
        expect(view(store).state.pins.size).toBe(1)
      }
      boundaries.statfs.mockResolvedValue(valid)
      await expect(
        store.reusableReceipt('a', sourceFor(0), 1024, { retentionOwnerId: 'new' })
      ).resolves.toMatchObject({ id: copy.receipt.id })
      expect((await store.readManagedFile(copy.receipt.path, 'a')).equals(copy.bytes)).toBe(true)
    }
  )

  it.each([false, true])(
    'RC-VOLUME-EIO-%s: a rejected statfs propagates without treating it as an invalid reading',
    async invalidFirst => {
      const store = await storeWithBudget()
      const valid = {
        ...(await nativeFs.statfs(hostRoot, { bigint: true })),
        bsize: 1n,
        blocks: TOTAL,
        bavail: TOTAL,
      }
      boundaries.statfs.mockReset()
      if (invalidFirst) boundaries.statfs.mockResolvedValueOnce({ ...valid, blocks: 0n })
      boundaries.statfs.mockRejectedValueOnce(eio())
      const before = await quotaCount('host', 'free_space')
      await expect(startTransfer(store, roots.a, 'a', 1, 1024)).rejects.toMatchObject({
        code: 'EIO',
        message: 'EIO: injected fault',
      })
      expect(boundaries.statfs).toHaveBeenCalledTimes(invalidFirst ? 2 : 1)
      expect(await quotaCount('host', 'free_space')).toBe(before)
      boundaries.statfs.mockResolvedValue(valid)
      const admitted = await startTransfer(store, roots.a, 'a', 1, 1024)
      await store.fail(admitted.transfer.id, 'a')
    }
  )

  it('RC-FAIL-PARENT-REFUSED: a failed transfer whose parent check refuses before the rename keeps its reservation charged', async () => {
    const store = await storeWithBudget()
    const a = await startTransfer(store, roots.a, 'a', 1, 4 * MIB)
    const b = await startTransfer(store, roots.b, 'b', 2, 4 * MIB)
    const faulted = new Set([
      path.join(roots.a, '.gfs-downloads'),
      path.join(roots.b, '.gfs-downloads'),
    ])
    const hits: string[] = []
    boundaries.realpath.mockImplementation(async (...args: unknown[]) => {
      if (faulted.has(String(args[0]))) {
        hits.push(String(args[0]))
        throw eio()
      }
      return Reflect.apply(nativeFs.realpath, nativeFs, args)
    })
    for (const [attempt, caller] of [
      [a, 'a'],
      [b, 'b'],
    ] as const)
      await expect(store.fail(attempt.transfer.id, caller)).rejects.toMatchObject({
        code: 'storage_write_failed',
      })
    expect(hits.length).toBeGreaterThanOrEqual(2)
    expect(storedBytes(hostRoot)).toBe(8 * MIB)
    expect(view(store)).toMatchObject({ entries: 0, active: 0, held: 8 * MIB, charged: 8 * MIB })
    await expectRefused(store)
    await recoverAndWitness(store)
  })

  it('RC-SYMLINK-ROOT: a .gfs-downloads symlink that cannot be removed is never walked into', async () => {
    const store = await storeWithBudget()
    const copy = await completedCopy(store, roots.b, 'b', 2, 4 * MIB, {
      owner: 'b-owner',
      expiresAt: new Date(Date.now() + 24 * HOUR).toISOString(),
    })
    const link = path.join(roots.a, '.gfs-downloads')
    syncFs.rmSync(link, { recursive: true, force: true })
    syncFs.symlinkSync(path.join(roots.b, '.gfs-downloads'), link)
    const renames: string[] = []
    boundaries.rename.mockImplementation((...args: unknown[]) => {
      if (String(args[0]) === link) {
        renames.push(String(args[0]))
        return Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' }))
      }
      return Reflect.apply(nativeFs.rename, nativeFs, args)
    })
    const walked: string[] = []
    boundaries.readdir.mockImplementation((...args: unknown[]) => {
      const target = String(args[0])
      if (target === link || target.startsWith(link + path.sep)) walked.push(target)
      return Reflect.apply(nativeFs.readdir, nativeFs, args)
    })
    for (let i = 0; i < 3; i++) await store.cleanupExpired()
    expect(renames).toHaveLength(3)
    expect(walked).toEqual([])
    expect(view(store)).toMatchObject({ held: 0, charged: 4 * MIB })
    expect((await store.readManagedFile(copy.receipt.path, 'b')).equals(copy.bytes)).toBe(true)
  })

  it('RC-REFUSED-TRASH-NOT-READ: a trash left in a refused parent with no charge in hand is not measured', async () => {
    const original = await storeWithBudget()
    await expiredTrash(original)
    await original.close(0)
    const downloads = new Set([
      path.join(roots.a, '.gfs-downloads'),
      path.join(roots.b, '.gfs-downloads'),
    ])
    const renamedInto = new Set<string>()
    const undone: string[] = []
    boundaries.rename.mockImplementation(async (...args: unknown[]) => {
      const from = String(args[0])
      const to = String(args[1])
      if (renamedInto.has(from)) {
        undone.push(from)
        throw eio()
      }
      const result = await Reflect.apply(nativeFs.rename, nativeFs, args)
      if (downloads.has(path.dirname(to))) renamedInto.add(to)
      return result
    })
    boundaries.realpath.mockImplementation(async (...args: unknown[]) => {
      const target = String(args[0])
      if (downloads.has(target) && renamedInto.size > undone.length) throw eio()
      return Reflect.apply(nativeFs.realpath, nativeFs, args)
    })
    const walked: string[] = []
    boundaries.readdir.mockImplementation((...args: unknown[]) => {
      if (renamedInto.has(String(args[0]))) walked.push(String(args[0]))
      return Reflect.apply(nativeFs.readdir, nativeFs, args)
    })
    const reopened = await storeWithBudget()
    expect(undone).toHaveLength(2)
    expect(walked).toEqual([])
    for (const trash of undone) expect(view(reopened).state.held.has(trash)).toBe(false)
    expect(storedBytes(hostRoot)).toBe(8 * MIB)
    await recoverAndWitness(reopened)
  })

  it('RC-ROOT-REFUSAL-CODE: a replaced .gfs-downloads whose undo fails reports the refusal and keeps its copies charged on the trash', async () => {
    const store = await storeWithBudget()
    await completedCopy(store, roots.a, 'a', 1, 4 * MIB, { owner: 'keep' })
    const downloads = path.join(roots.a, '.gfs-downloads')
    syncFs.chmodSync(downloads, 0o755)
    let trash: string | undefined
    boundaries.rename.mockImplementation(async (...args: unknown[]) => {
      const from = String(args[0])
      if (from === downloads) {
        trash = String(args[1])
        return Reflect.apply(nativeFs.rename, nativeFs, args)
      }
      if (trash !== undefined && from === trash) throw eio()
      return Reflect.apply(nativeFs.rename, nativeFs, args)
    })
    boundaries.realpath.mockImplementation(async (...args: unknown[]) => {
      if (trash !== undefined && String(args[0]) === roots.a) return '/elsewhere'
      return Reflect.apply(nativeFs.realpath, nativeFs, args)
    })
    await expect(startTransfer(store, roots.a, 'a', 2, 1024)).rejects.toMatchObject({
      code: 'workspace_unavailable',
    })
    expect(trash).toBeDefined()
    expect(view(store).state.held.get(trash!)?.sizeBytes).toBe(4 * MIB)
    expect(view(store)).toMatchObject({ entries: 0, charged: 4 * MIB })
  })

  it('RC-INDEXED-KEPT: an evicted entry whose rename fails stays indexed and is charged once', async () => {
    const store = await storeWithBudget()
    await completedCopy(store, roots.a, 'a', 1, 4 * MIB)
    await completedCopy(store, roots.b, 'b', 2, 4 * MIB)
    const hits: string[] = []
    boundaries.rename.mockImplementation((...args: unknown[]) => {
      const source = String(args[0])
      const cached = source.startsWith(roots.a) || source.startsWith(roots.b)
      if (cached && path.basename(source).startsWith('input-')) {
        hits.push(source)
        return Promise.reject(eio())
      }
      return Reflect.apply(nativeFs.rename, nativeFs, args)
    })
    // The plan evicts one of the two copies (the frozen clock ties them); its
    // rename fails, so the admission still exceeds the budget.
    for (let i = 0; i < 3; i++) {
      await expect(startTransfer(store, roots.c, 'c', 3 + i, 4 * MIB)).rejects.toMatchObject({
        code: 'host_quota_exceeded',
      })
      expect(view(store)).toMatchObject({ entries: 8 * MIB, held: 0, active: 0, charged: 8 * MIB })
    }
    expect(hits).toHaveLength(3)
    expect(storedBytes(hostRoot)).toBe(8 * MIB)
    restoreBoundary('rename')
    const fits = await startTransfer(store, roots.c, 'c', 6, 4 * MIB)
    // One copy is evicted now; the other and c's partial are what remains.
    expect(view(store)).toMatchObject({ entries: 4 * MIB, held: 0, active: 4 * MIB })
    expect(storedBytes(roots.a) + storedBytes(roots.b)).toBe(4 * MIB)
    expect(storedBytes(hostRoot)).toBe(8 * MIB)
    await store.fail(fits.transfer.id, 'c')
  })

  it('RC-UNDO-RESTORED-UNINDEXED: startup leftovers restored by an undone refusal are measured once their parent passes again', async () => {
    for (const caller of ['a', 'b'])
      plantDownload(roots[caller], { bytes: Buffer.alloc(4 * MIB), meta: 'omit' })
    // The check after each rename to a trash name fails once with EIO; the
    // rename back succeeds, so each leftover is under its own name again.
    const refused = new Set<string>()
    const undone: string[] = []
    boundaries.rename.mockImplementation(async (...args: unknown[]) => {
      const [from, to] = [String(args[0]), String(args[1])]
      const result = await Reflect.apply(nativeFs.rename, nativeFs, args)
      if (path.basename(from).startsWith('.trash-')) undone.push(to)
      else if (path.basename(to).startsWith('.trash-')) refused.add(path.dirname(to))
      return result
    })
    boundaries.realpath.mockImplementation(async (...args: unknown[]) => {
      if (refused.delete(String(args[0]))) throw eio()
      return Reflect.apply(nativeFs.realpath, nativeFs, args)
    })
    const store = await storeWithBudget()
    expect(undone).toHaveLength(2)
    expect(view(store)).toMatchObject({ entries: 0, held: 8 * MIB, charged: 8 * MIB })
    expect([...view(store).state.held.keys()].sort()).toEqual([...undone].sort())
    expect(storedBytes(hostRoot)).toBe(8 * MIB)
    // Each admission retries both removals, which are undone again.
    await expectRefused(store)
    expect(undone).toHaveLength(4)
    await recoverAndWitness(store)
  })

  it('RC-WALK-SWAP: a directory replaced by a symlink while a leftover is measured is not walked', async () => {
    const planted = plantDownload(roots.a, { bytes: Buffer.alloc(4 * MIB), meta: 'omit' })
    syncFs.mkdirSync(path.join(planted.directory, 'nested'))
    const victim = path.join(roots.b, 'ordinary-workspace-data')
    syncFs.mkdirSync(victim)
    const victimFile = path.join(victim, 'outside.bin')
    syncFs.writeFileSync(victimFile, Buffer.alloc(8 * MIB, 29))
    const swapped: string[] = []
    const walked: string[] = []
    boundaries.readdir.mockImplementation(async (...args: unknown[]) => {
      const target = String(args[0])
      walked.push(target)
      const listing = await Reflect.apply(nativeFs.readdir, nativeFs, args)
      // After the trash is listed, its child directory becomes a symlink.
      if (path.basename(target).startsWith('.trash-') && swapped.length === 0) {
        const nested = path.join(target, 'nested')
        syncFs.rmdirSync(nested)
        syncFs.symlinkSync(victim, nested)
        swapped.push(nested)
      }
      return listing
    })
    failTrashRemoval()
    const store = await storeWithBudget()
    expect(swapped).toHaveLength(1)
    expect(walked).not.toContain(swapped[0])
    expect(walked).not.toContain(victim)
    expect(view(store)).toMatchObject({ entries: 0, held: 4 * MIB, charged: 4 * MIB })
    // 4 MiB held plus 4 MiB requested fit the 10 MiB budget.
    const fits = await startTransfer(store, roots.c, 'c', 3, 4 * MIB)
    expect(view(store)).toMatchObject({ held: 4 * MIB, active: 4 * MIB })
    restoreBoundary('rm')
    await store.fail(fits.transfer.id, 'c')
    restoreBoundary('readdir')
    await recoverAndWitness(store)
    expect(syncFs.statSync(victimFile).size).toBe(8 * MIB)
  })

  it('RC-REFUSED-IN-PLACE-NOT-READ: a leftover whose parent check keeps failing is not walked to measure it', async () => {
    plantDownload(roots.a, { bytes: Buffer.alloc(4 * MIB), meta: 'omit' })
    const downloads = path.join(roots.a, '.gfs-downloads')
    const checks: string[] = []
    boundaries.realpath.mockImplementation(async (...args: unknown[]) => {
      if (String(args[0]) === downloads) {
        checks.push(downloads)
        throw eio()
      }
      return Reflect.apply(nativeFs.realpath, nativeFs, args)
    })
    const walked: string[] = []
    boundaries.readdir.mockImplementation((...args: unknown[]) => {
      if (path.basename(String(args[0])).startsWith('input-')) walked.push(String(args[0]))
      return Reflect.apply(nativeFs.readdir, nativeFs, args)
    })
    const store = await storeWithBudget()
    expect((await store.cleanupExpired()).removeFailed).toBe(1)
    // Refused before the rename and again by the recheck, in both sweeps.
    expect(checks.length).toBeGreaterThanOrEqual(4)
    expect(walked).toEqual([])
    expect(view(store)).toMatchObject({ entries: 0, held: 0 })
    expect(storedBytes(hostRoot)).toBe(4 * MIB)
    await recoverAndWitness(store)
  })
})
