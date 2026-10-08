/**
 * On-disk and lifecycle states the GFS download store recovers from (PR #1028
 * review R1-M2, R1-L2, R1-L5, R1-L9): a store directory a shell made
 * unwritable, a non-regular `meta.json`, close() racing initialize() or
 * itself, and the removed-variable warning across initialize() retries.
 * statfs is the only boundary replaced, and only to size a small budget.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import * as syncFs from 'node:fs'
import * as fs from 'node:fs/promises'
import * as net from 'node:net'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import {
  callerDirectory,
  completedCopy,
  digestOf,
  downloadDirectory,
  exists,
  metaFor,
  plantDownload,
  quotaCount,
  startTransfer,
} from '../__tests__/fixtures/gfsStoreTestKit'
import { logger } from '../logger'
import { GfsDownloadStore } from './gfsDownloadStore'
import { REMOVED_GFS_STORAGE_VARIABLES } from './gfsFilePolicy'

const { statfsBoundary } = vi.hoisted(() => ({ statfsBoundary: vi.fn() }))
vi.mock('node:fs/promises', async original => ({
  ...(await original<typeof fs>()),
  statfs: statfsBoundary,
}))

const A = 'caller-a'
const B = 'caller-b'
const C = 'caller-c'
const HOUR = 60 * 60_000
const REMOVED_VARIABLE_WARNING =
  'GFS download store ignores a removed retained-storage variable; the budget is MCP_HOST_GFS_DOWNLOAD_STORAGE_PERCENT of the workspace volume'

let nativeFs: typeof fs
let hostRoot: string
let outside: string
let rootA: string
let rootB: string
let rootC: string
const stores: GfsDownloadStore[] = []

/** statfs reports the real free space but a `totalBytes` volume (block size 1). */
function volumeOf(totalBytes: number): void {
  statfsBoundary.mockImplementation(async (target: string) => {
    const real = await nativeFs.statfs(target, { bigint: true })
    return { ...real, bsize: 1n, blocks: BigInt(totalBytes), bavail: real.bavail * real.bsize }
  })
}

function trackStore(root = hostRoot): GfsDownloadStore {
  const opened = new GfsDownloadStore(root)
  stores.push(opened)
  return opened
}

async function openStore(): Promise<GfsDownloadStore> {
  const opened = trackStore()
  await opened.initialize()
  return opened
}

/** Gives the owner rwx on every real directory under `root` so it can be removed. */
function restoreOwnerAccess(root: string): void {
  if (!exists(root) || !syncFs.lstatSync(root).isDirectory()) return
  syncFs.chmodSync(root, 0o700)
  for (const child of syncFs.readdirSync(root, { withFileTypes: true }))
    if (child.isDirectory()) restoreOwnerAccess(path.join(root, child.name))
}

/** The store's own directories, by name: input-<uuid> and .trash-<uuid>. */
function storeDirectories(callerRoot: string): string[] {
  const downloads = path.join(callerRoot, '.gfs-downloads')
  return exists(downloads) ? syncFs.readdirSync(downloads).sort() : []
}

beforeEach(async () => {
  nativeFs = await vi.importActual<typeof fs>('node:fs/promises')
  statfsBoundary.mockReset()
  statfsBoundary.mockImplementation(nativeFs.statfs)
  hostRoot = syncFs.mkdtempSync(path.join(tmpdir(), 'gfs-store-recovery-'))
  outside = syncFs.mkdtempSync(path.join(tmpdir(), 'gfs-store-recovery-outside-'))
  rootA = callerDirectory(hostRoot, A)
  rootB = callerDirectory(hostRoot, B)
  rootC = callerDirectory(hostRoot, C)
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.useRealTimers()
  for (const opened of stores.splice(0)) await opened.close(0)
  restoreOwnerAccess(hostRoot)
  restoreOwnerAccess(outside)
  await nativeFs.rm(hostRoot, { recursive: true, force: true })
  await nativeFs.rm(outside, { recursive: true, force: true })
})

describe('GFS download store: a store directory made unwritable is still removed', () => {
  it('RCV-1: expired copies in input directories chmod 0500 are removed by the sweep, release their charge, and another caller is admitted', async () => {
    // Precondition: a 0500 directory refuses the removal of its children for
    // this user (it does not for root, which bypasses the mode).
    const probe = syncFs.mkdtempSync(path.join(outside, 'probe-'))
    syncFs.writeFileSync(path.join(probe, 'child'), 'x')
    syncFs.chmodSync(probe, 0o500)
    await expect(nativeFs.rm(probe, { recursive: true, force: true })).rejects.toMatchObject({
      code: 'EACCES',
    })
    syncFs.chmodSync(probe, 0o700)

    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-08T10:00:00.000Z'))
    // 100-byte volume, budget 85: A and B hold 40 bytes each.
    volumeOf(100)
    const store = await openStore()
    const copyA = await completedCopy(store, rootA, A, 800, 40)
    const copyB = await completedCopy(store, rootB, B, 801, 40)
    const directoryA = downloadDirectory(rootA, copyA.receipt.id)
    const directoryB = downloadDirectory(rootB, copyB.receipt.id)
    // A symlink inside the tree to a directory outside the Host root whose
    // mode must not change: the walk never follows it.
    const target = path.join(outside, 'target')
    syncFs.mkdirSync(target, { mode: 0o500 })
    syncFs.symlinkSync(target, path.join(directoryA, 'link'))
    syncFs.chmodSync(directoryA, 0o500)
    syncFs.chmodSync(directoryB, 0o500)
    vi.setSystemTime(Date.now() + 2 * HOUR)
    const budgetDenied = await quotaCount('host', 'storage_bytes')

    const sweep = await store.cleanupExpired()

    expect(sweep).toMatchObject({ removedExpired: 2, removeFailed: 0 })
    expect(storeDirectories(rootA)).toEqual([])
    expect(storeDirectories(rootB)).toEqual([])
    const admitted = await startTransfer(store, rootC, C, 802, 40)
    expect(admitted.transfer.sizeBytes).toBe(40)
    expect(await quotaCount('host', 'storage_bytes')).toBe(budgetDenied)
    // The symlink was removed, never followed: its target keeps its mode.
    expect(syncFs.statSync(target).mode & 0o777).toBe(0o500)
  })
})

describe('GFS download store: a non-regular meta.json', () => {
  it('RCV-2: a Unix socket planted as meta.json makes the directory incomplete, and the sweep removes it', async () => {
    const store = await openStore()
    const kept = await completedCopy(store, rootA, A, 810, 8)
    const id = randomUUID()
    const planted = plantDownload(rootA, {
      id,
      bytes: Buffer.alloc(8, 1),
      meta: 'omit',
    })
    // A socket path is limited to about 100 bytes, so it is bound at a short
    // path and renamed into place; the server is closed once it is there.
    const socketPath = path.join(outside, 's')
    const server = net.createServer()
    await new Promise<void>(resolve => server.listen(socketPath, resolve))
    syncFs.renameSync(socketPath, path.join(planted.directory, 'meta.json'))
    await new Promise<void>(resolve => server.close(() => resolve()))
    expect(syncFs.lstatSync(path.join(planted.directory, 'meta.json')).isSocket()).toBe(true)

    const sweep = await store.cleanupExpired()

    expect(sweep.removedIncomplete).toBe(1)
    expect(exists(planted.directory)).toBe(false)
    // Witness: the sweep inspected the tree and kept the valid sibling.
    expect(exists(downloadDirectory(rootA, kept.receipt.id))).toBe(true)
    await expect(store.readManagedFile(kept.receipt.path, A)).resolves.toEqual(kept.bytes)
  })

  it('RCV-2b: at initialize, a socket meta.json is removed as incomplete', async () => {
    const id = randomUUID()
    const bytes = Buffer.alloc(8, 2)
    const validId = randomUUID()
    const valid = plantDownload(rootB, {
      id: validId,
      bytes,
      meta: metaFor(validId, bytes, Date.now()),
    })
    const planted = plantDownload(rootA, { id, bytes, meta: 'omit' })
    const socketPath = path.join(outside, 's')
    const server = net.createServer()
    await new Promise<void>(resolve => server.listen(socketPath, resolve))
    syncFs.renameSync(socketPath, path.join(planted.directory, 'meta.json'))
    await new Promise<void>(resolve => server.close(() => resolve()))
    const info = vi.spyOn(logger, 'info')

    await openStore()

    expect(exists(planted.directory)).toBe(false)
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ component: 'GfsDownloadStore', removedIncomplete: 1, adopted: 1 }),
      'GFS download store initialized'
    )
    // Witness: the sweep inspected the tree and adopted the valid sibling.
    expect(exists(valid.directory)).toBe(true)
  })
})

describe('GFS download store: close() and initialize()', () => {
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

  it('RCV-3: close() requested while initialize() is sweeping waits for that sweep', async () => {
    const store = trackStore()
    const sweeps = blockSweeps(store)
    const initializing = store.initialize()
    const initialized = initializing.catch((error: unknown) => error)
    await vi.waitFor(() => expect(sweeps.started).toEqual([0]))
    let closed = false
    const closing = store.close(5_000).then(() => {
      closed = true
    })

    await new Promise(resolve => setTimeout(resolve, 20))
    expect(closed).toBe(false)

    sweeps.releases[0]!()
    await closing
    // Witness: the initialization sweep finished before close() resolved.
    expect(sweeps.finished).toEqual([0])
    expect(closed).toBe(true)
    await expect(initialized).resolves.toMatchObject({ code: 'download_busy' })
    expect(store.isAvailable()).toBe(false)
  })

  it('RCV-4: a second close() while the first is draining resolves only when the first does', async () => {
    const store = await openStore()
    const { transfer, bytes } = await startTransfer(store, rootA, A, 820, 8)
    let firstClosed = false
    let secondClosed = false
    const first = store.close(5_000).then(() => {
      firstClosed = true
    })
    const second = store.close(5_000).then(() => {
      secondClosed = true
    })

    await new Promise(resolve => setTimeout(resolve, 20))
    expect(firstClosed).toBe(false)
    expect(secondClosed).toBe(false)

    // Witness: the transfer close() waits for completes while it drains.
    const receipt = await store.publish(transfer.id, A, digestOf(bytes))
    expect(receipt.id).toBe(transfer.id)
    await Promise.all([first, second])
    expect(firstClosed).toBe(true)
    expect(secondClosed).toBe(true)
  })

  it('RCV-5: a managed read whose digest check finishes after close() does not remove the copy', async () => {
    const store = await openStore()
    const copy = await completedCopy(store, rootA, A, 830, 8)
    const directory = downloadDirectory(rootA, copy.receipt.id)
    // Same size, mode and inode, other bytes: only the digest check refuses it.
    syncFs.writeFileSync(path.join(directory, 'source'), Buffer.alloc(8, 0xee))
    const internals = store as unknown as { openEntryContent: (entry: unknown) => Promise<unknown> }
    const realOpen = internals.openEntryContent.bind(store)
    let releaseOpen!: () => void
    const opened: unknown[] = []
    vi.spyOn(internals, 'openEntryContent').mockImplementation(async (entry: unknown) => {
      await new Promise<void>(resolve => {
        releaseOpen = resolve
      })
      const handle = await realOpen(entry)
      opened.push(handle)
      return handle
    })

    const read = store.readManagedFile(copy.receipt.path, A).catch((error: unknown) => error)
    await vi.waitFor(() => expect(releaseOpen).toBeDefined())
    await store.close(5_000)
    releaseOpen()

    await expect(read).resolves.toMatchObject({ code: 'download_missing' })
    // Witness: the read opened the copy and reached the digest check.
    expect(opened).toHaveLength(1)
    expect(exists(directory)).toBe(true)
  })
})

describe('GFS download store: removed variables across initialize() retries', () => {
  it('RCV-6: a removed variable is warned about once although initialize() runs twice', async () => {
    for (const name of REMOVED_GFS_STORAGE_VARIABLES) vi.stubEnv(name, undefined)
    vi.stubEnv(REMOVED_GFS_STORAGE_VARIABLES[0]!, '1')
    // The Host root is a regular file first, so the first attempt fails.
    const root = path.join(outside, 'host-root')
    syncFs.writeFileSync(root, 'not a directory')
    const store = trackStore(root)
    const warn = vi.spyOn(logger, 'warn')

    await expect(store.initialize()).rejects.toMatchObject({ code: 'workspace_unavailable' })
    syncFs.rmSync(root)
    await store.initialize()

    // Witness: both attempts ran; the second one initialized the store.
    expect(store.isAvailable()).toBe(true)
    expect(warn.mock.calls.filter(call => call[1] === REMOVED_VARIABLE_WARNING)).toHaveLength(1)
  })
})
