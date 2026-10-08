/**
 * R2-F2: a duplicate whose removal failed stays charged against the Host
 * budget until its removal succeeds or `lstat` proves it gone, including
 * through sweeps that cannot inspect or list it. Ported from the final
 * review's `SOL-R2-HELD-meta-open` and `SOL-R2-HELD-caller-list` repros to the
 * byte budget. Every case runs on a real temporary directory; faults are
 * injected only on the operation that fails.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import * as syncFs from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import {
  callerDirectory,
  downloadDirectory,
  exists,
  metaFor,
  plantDownload,
  startTransfer,
} from '../__tests__/fixtures/gfsStoreTestKit'
import { GfsDownloadStore } from './gfsDownloadStore'

type FsOperation = 'open' | 'lstat' | 'rename' | 'readdir'

const { faults } = vi.hoisted(() => ({
  faults: new Map<string, (target: string) => string | undefined>(),
}))

// A 95-byte volume at the default 85% gives a budget of floor(80.75) = 80:
// eight 5-byte copies per caller fill it exactly.
const VOLUME_BYTES = 95n

vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof fs>()
  const wrap =
    <F extends (...args: never[]) => unknown>(operation: string, real: F) =>
    (...args: Parameters<F>) => {
      const code = faults.get(operation)?.(String(args[0]))
      if (code !== undefined) {
        const error = new Error(`${code}: injected`) as NodeJS.ErrnoException
        error.code = code
        return Promise.reject(error)
      }
      return real(...args)
    }
  return {
    ...actual,
    open: wrap('open', actual.open),
    lstat: wrap('lstat', actual.lstat),
    rename: wrap('rename', actual.rename),
    readdir: wrap('readdir', actual.readdir),
    statfs: async (target: string, options: { bigint: true }) => {
      const real = await actual.statfs(target, options)
      return { ...real, bsize: 1n, blocks: VOLUME_BYTES, bavail: real.bavail * real.bsize }
    },
  }
})

/** Records every `operation` call that `matches`, failing it with EIO. */
function failWithEio(operation: FsOperation, matches: (target: string) => boolean): string[] {
  const calls: string[] = []
  faults.set(operation, target => {
    if (!matches(target)) return undefined
    calls.push(target)
    return 'EIO'
  })
  return calls
}

const OWNER = 'caller-b'
const PLANTER = 'caller-a'
const DOWNLOADS = `${path.sep}users${path.sep}${PLANTER}${path.sep}.gfs-downloads`

let hostRoot: string
const stores: GfsDownloadStore[] = []

async function openStore(): Promise<GfsDownloadStore> {
  const opened = new GfsDownloadStore(hostRoot)
  stores.push(opened)
  await opened.initialize()
  return opened
}

function plantCopies(root: string, ids: string[]): void {
  const bytes = Buffer.from('quota')
  for (const id of ids) plantDownload(root, { id, bytes, meta: metaFor(id, bytes, Date.now()) })
}

/** Renames of the given ids' input directories fail; `only` limits it to one caller root. */
function failRemovals(ids: string[], only?: string): string[] {
  const names = new Set(ids.map(id => `input-${id}`))
  return failWithEio(
    'rename',
    target => names.has(path.basename(target)) && (only === undefined || target.includes(only))
  )
}

/**
 * The owner's 8 copies are indexed at startup, the planter's 8 duplicates of
 * the same ids appear afterwards, and every removal of either fails: 80 bytes
 * on disk against a budget of 80, so a 5-byte admission must be refused.
 */
async function heldDuplicates() {
  const owner = callerDirectory(hostRoot, OWNER)
  const planter = callerDirectory(hostRoot, PLANTER)
  const ids = Array.from({ length: 8 }, () => randomUUID())
  plantCopies(owner, ids)
  const store = await openStore()
  const renames = failRemovals(ids)
  plantCopies(planter, ids)
  const first = await store.cleanupExpired()
  // Witness: both copies of every id were removal attempts, and each failed.
  expect(first.removeFailed).toBe(ids.length * 2)
  expect(renames.length).toBeGreaterThanOrEqual(ids.length * 2)
  await expect(startTransfer(store, planter, PLANTER, 100, 5)).rejects.toMatchObject({
    code: 'host_quota_exceeded',
  })
  return { store, owner, planter, ids }
}

beforeEach(() => {
  faults.clear()
  hostRoot = syncFs.mkdtempSync(path.join(tmpdir(), 'gfs-store-held-'))
})

afterEach(async () => {
  faults.clear()
  vi.restoreAllMocks()
  for (const opened of stores.splice(0)) await opened.close(0)
  await fs.rm(hostRoot, { recursive: true, force: true })
})

describe('GFS download store: held duplicate charges survive transient failures (R2-F2)', () => {
  it('SOL-R2-HELD-meta-open: a duplicate whose meta.json cannot be opened keeps its charge', async () => {
    const { store, planter, ids } = await heldDuplicates()
    const reads = failWithEio(
      'open',
      target => target.includes(`${DOWNLOADS}${path.sep}`) && path.basename(target) === 'meta.json'
    )

    // The sweep inside this admission inspects every duplicate and cannot.
    await expect(startTransfer(store, planter, PLANTER, 101, 5)).rejects.toMatchObject({
      code: 'host_quota_exceeded',
    })
    // Witness: the inspection was attempted and failed.
    expect(reads.length).toBeGreaterThan(0)
    for (const id of ids) expect(exists(downloadDirectory(planter, id))).toBe(true)

    // Inspection back, removals still failing: still refused.
    faults.delete('open')
    await expect(startTransfer(store, planter, PLANTER, 102, 5)).rejects.toMatchObject({
      code: 'host_quota_exceeded',
    })

    // Removals back: the sweep removes every duplicate and capacity returns.
    faults.delete('rename')
    await store.cleanupExpired()
    for (const id of ids) expect(exists(downloadDirectory(planter, id))).toBe(false)
    const admitted = await startTransfer(store, planter, PLANTER, 103, 5)
    await store.fail(admitted.transfer.id, PLANTER)
  })

  it('SOL-R2-HELD-caller-list: a duplicate whose .gfs-downloads cannot be listed keeps its charge', async () => {
    const { store, planter, ids } = await heldDuplicates()
    const listings = failWithEio('readdir', target => target.endsWith(DOWNLOADS))

    await expect(startTransfer(store, planter, PLANTER, 101, 5)).rejects.toMatchObject({
      code: 'host_quota_exceeded',
    })
    // Witness: the listing was attempted and failed.
    expect(listings.length).toBeGreaterThan(0)
    for (const id of ids) expect(exists(downloadDirectory(planter, id))).toBe(true)

    faults.delete('readdir')
    await expect(startTransfer(store, planter, PLANTER, 102, 5)).rejects.toMatchObject({
      code: 'host_quota_exceeded',
    })

    faults.delete('rename')
    await store.cleanupExpired()
    for (const id of ids) expect(exists(downloadDirectory(planter, id))).toBe(false)
    const admitted = await startTransfer(store, planter, PLANTER, 103, 5)
    await store.fail(admitted.transfer.id, PLANTER)
  })

  it('a carried charge is dropped once lstat reports the directory gone', async () => {
    const { store, planter, ids } = await heldDuplicates()
    const listings = failWithEio('readdir', target => target.endsWith(DOWNLOADS))
    // The duplicates disappear while their parent cannot be listed.
    for (const id of ids)
      syncFs.rmSync(downloadDirectory(planter, id), { recursive: true, force: true })

    // Only the owner's 40 bytes remain on disk: 40 + 5 fits the budget of 80.
    const admitted = await startTransfer(store, planter, PLANTER, 101, 5)
    // Witness: the sweep inside the admission could not list the duplicates,
    // so only the lstat re-check can have released their charge.
    expect(listings.length).toBeGreaterThan(0)
    await store.fail(admitted.transfer.id, PLANTER)
  })

  it('a carried charge whose lstat fails with anything but ENOENT is kept', async () => {
    const { store, planter, ids } = await heldDuplicates()
    const listings = failWithEio('readdir', target => target.endsWith(DOWNLOADS))
    const probes = failWithEio('lstat', target =>
      ids.some(id => target.endsWith(`${DOWNLOADS}${path.sep}input-${id}`))
    )

    await expect(startTransfer(store, planter, PLANTER, 101, 5)).rejects.toMatchObject({
      code: 'host_quota_exceeded',
    })
    // Witness: the re-check ran on the carried directories and failed.
    expect(listings.length).toBeGreaterThan(0)
    expect(probes.length).toBeGreaterThanOrEqual(ids.length)

    faults.clear()
    await store.cleanupExpired()
    const admitted = await startTransfer(store, planter, PLANTER, 102, 5)
    await store.fail(admitted.transfer.id, PLANTER)
  })

  it('a carried directory that is now indexed is charged once, not twice', async () => {
    const owner = callerDirectory(hostRoot, OWNER)
    const planter = callerDirectory(hostRoot, PLANTER)
    const ids = Array.from({ length: 8 }, () => randomUUID())
    plantCopies(owner, ids)
    const store = await openStore()
    // Only the planter's removals fail: the owner's indexed copies go.
    const renames = failRemovals(ids, `${path.sep}${PLANTER}${path.sep}`)
    plantCopies(planter, ids)

    const first = await store.cleanupExpired()
    expect(first.removeFailed).toBe(ids.length)
    expect(renames.length).toBeGreaterThanOrEqual(ids.length)
    for (const id of ids) expect(exists(downloadDirectory(owner, id))).toBe(false)

    // The next sweep finds each planter copy alone and indexes it as adopted.
    const second = await store.cleanupExpired()
    expect(second.removeFailed).toBe(0)
    expect((await store.debugInventory()).byCaller.get(PLANTER)).toEqual({ files: 8, bytes: 40 })

    // 40 indexed + 40 requested = 80 fits the budget exactly; a second charge
    // of the same 40 bytes would refuse it.
    const renamesBefore = renames.length
    const admitted = await startTransfer(store, planter, PLANTER, 101, 40)
    // Witness: nothing had to be evicted to make room.
    expect(renames.length).toBe(renamesBefore)
    await store.fail(admitted.transfer.id, PLANTER)
  })
})
