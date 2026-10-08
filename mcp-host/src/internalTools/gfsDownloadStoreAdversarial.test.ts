/**
 * Adversarial round of the GFS download store: caller identity across
 * channels, transient I/O that is not corruption, stranded trash, eviction and
 * undo failures, and the retirement/expiry/recency edge cases. Faults are
 * injected through a pass-through `node:fs/promises` seam; every case runs on
 * a real temporary directory.
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
  exists,
  expiryCount,
  metaFor,
  plantDownload,
  sourceFor,
  startTransfer,
  withEnvironment,
} from '../__tests__/fixtures/gfsStoreTestKit'
import { logger } from '../logger'
import {
  GFS_DOWNLOADS_TRASH_PREFIX,
  isGfsDownloadPath,
  isProtectedWorkspacePath,
} from '../workspace/protectedPaths'
import { deriveUserKey } from '../workspace/userKey'
import { GfsDownloadStore } from './gfsDownloadStore'

type FsOperation = 'open' | 'lstat' | 'rename' | 'rm' | 'readdir' | 'realpath'
/**
 * A fault returns the errno to throw for this call, `SKIP_CALL` to resolve
 * without calling the real function, or undefined to pass through.
 */
type Fault = (target: string) => string | undefined
const SKIP_CALL = 'SKIP_CALL'

const { faults } = vi.hoisted(() => ({
  faults: new Map<string, (target: string) => string | undefined>(),
}))

function errnoError(code: string): NodeJS.ErrnoException {
  const error = new Error(`${code}: injected`) as NodeJS.ErrnoException
  error.code = code
  return error
}

vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof fs>()
  const wrap =
    <F extends (...args: never[]) => unknown>(operation: string, real: F) =>
    (...args: Parameters<F>) => {
      const code = faults.get(operation)?.(String(args[0]))
      if (code === 'SKIP_CALL') return Promise.resolve(undefined)
      if (code !== undefined) return Promise.reject(errnoError(code))
      return real(...args)
    }
  return {
    ...actual,
    open: wrap('open', actual.open),
    lstat: wrap('lstat', actual.lstat),
    rename: wrap('rename', actual.rename),
    rm: wrap('rm', actual.rm),
    readdir: wrap('readdir', actual.readdir),
    realpath: wrap('realpath', actual.realpath),
  }
})

function injectFault(operation: FsOperation, fault: Fault): void {
  faults.set(operation, fault)
}

/**
 * Watches `operation` on every path ending with `suffix`: records each call
 * and fails it with `code`, or only records it when `code` is undefined.
 */
function watch(operation: FsOperation, suffix: string, code?: string): string[] {
  const calls: string[] = []
  injectFault(operation, target => {
    if (!target.endsWith(suffix)) return undefined
    calls.push(target)
    return code
  })
  return calls
}

/** Every warning logged, as `{ code, message }`. */
function warnings(warn: {
  mock: { calls: unknown[][] }
}): Array<{ code: unknown; message: unknown }> {
  return warn.mock.calls.map(call => ({
    code: (call[0] as { code?: unknown }).code,
    message: call[1],
  }))
}

const REUSE_KEPT =
  'GFS download store could not verify a published copy for reuse; it is kept and checked again later'
const SWEEP_KEPT =
  'GFS download store could not inspect a download directory; it is kept and the next sweep retries it'
const READ_FAILED = 'GFS download store could not read a published copy for its caller'

let hostRoot: string
const stores: GfsDownloadStore[] = []

async function openStore(): Promise<GfsDownloadStore> {
  const opened = new GfsDownloadStore(hostRoot)
  stores.push(opened)
  await opened.initialize()
  return opened
}

beforeEach(() => {
  faults.clear()
  hostRoot = syncFs.mkdtempSync(path.join(tmpdir(), 'gfs-store-adversarial-'))
})

afterEach(async () => {
  faults.clear()
  vi.restoreAllMocks()
  vi.useRealTimers()
  for (const opened of stores.splice(0)) await opened.close(0)
  await fs.rm(hostRoot, { recursive: true, force: true })
})

describe('GFS download store adversarial round: caller identity (ADV-1)', () => {
  const SENDER = 'same-sender'
  const KEY_A = deriveUserKey(SENDER, 'channel-a')
  const KEY_B = deriveUserKey(SENDER, 'channel-b')

  it('two channels with the same sender never see each other’s copy', async () => {
    expect(KEY_A).not.toBe(KEY_B)
    const store = await openStore()
    const rootA = callerDirectory(hostRoot, KEY_A)
    const rootB = callerDirectory(hostRoot, KEY_B)
    const published = await completedCopy(store, rootA, KEY_A, 1, 64)

    // Witness: the owner's reuse and read hit the published copy.
    await expect(store.reusableReceipt(KEY_A, sourceFor(1), 64)).resolves.toMatchObject({
      id: published.receipt.id,
    })
    await expect(store.readManagedFile(published.receipt.path, KEY_A)).resolves.toEqual(
      published.bytes
    )

    // The other channel's caller: no reuse, and the foreign id reads exactly
    // like an id that never existed.
    await expect(store.reusableReceipt(KEY_B, sourceFor(1), 64)).resolves.toBeUndefined()
    const missing = `.gfs-downloads/input-${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}/source`
    const foreign = await store.readManagedFile(published.receipt.path, KEY_B).catch(e => e)
    const nonexistent = await store.readManagedFile(missing, KEY_B).catch(e => e)
    expect(foreign).toMatchObject({ code: 'download_missing' })
    expect(nonexistent).toMatchObject({ code: 'download_missing' })
    expect(String(foreign)).toBe(String(nonexistent))

    // B downloads its own copy into its own root.
    const own = await completedCopy(store, rootB, KEY_B, 1, 64)
    expect(own.receipt.id).not.toBe(published.receipt.id)
    expect(syncFs.existsSync(path.join(rootB, own.receipt.path))).toBe(true)
  })

  it('refuses an identity that is not the caller root’s key', async () => {
    const store = await openStore()
    const rootA = callerDirectory(hostRoot, KEY_A)
    const admission = {
      callerWorkspacePath: rootA,
      source: sourceFor(2),
      sizeBytes: 8,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }
    await expect(
      store.createTransfer({ ...admission, callerIdentity: SENDER })
    ).rejects.toMatchObject({ code: 'caller_mismatch' })
    await expect(
      store.createTransfer({ ...admission, callerIdentity: KEY_B })
    ).rejects.toMatchObject({ code: 'caller_mismatch' })
    // Witness: the root's own key is admitted.
    await expect(
      store.createTransfer({ ...admission, callerIdentity: KEY_A })
    ).resolves.toMatchObject({ sizeBytes: 8 })
  })
})

describe('GFS download store adversarial round: caller root shape (F9)', () => {
  it.each([
    ['the Host root', (host: string) => host],
    ['the users directory', (host: string) => path.join(host, 'users')],
    ['a directory inside a caller root', (host: string) => path.join(host, 'users', 'k', 'nested')],
    ['a directory outside users', (host: string) => path.join(host, 'other', 'k')],
  ])('refuses %s as a caller root', async (_label, rootOf) => {
    const store = await openStore()
    const root = rootOf(hostRoot)
    syncFs.mkdirSync(root, { recursive: true, mode: 0o700 })
    await expect(
      store.createTransfer({
        callerIdentity: path.basename(root),
        callerWorkspacePath: root,
        source: sourceFor(3),
        sizeBytes: 8,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
    ).rejects.toMatchObject({ code: 'workspace_unavailable' })
    // Witness: `users/<key>` itself is admitted.
    const valid = callerDirectory(hostRoot, 'k')
    await expect(
      store.createTransfer({
        callerIdentity: 'k',
        callerWorkspacePath: valid,
        source: sourceFor(3),
        sizeBytes: 8,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
    ).resolves.toMatchObject({ sizeBytes: 8 })
  })
})

describe('GFS download store adversarial round: transient I/O is not corruption (F1/ADV-3)', () => {
  const KEY = 'alice-key'

  it('reuse that cannot open a pinned copy keeps it for the task that holds it', async () => {
    const store = await openStore()
    const root = callerDirectory(hostRoot, KEY)
    const { receipt, bytes } = await completedCopy(store, root, KEY, 1, 128, { owner: 'task-1' })
    const warn = vi.spyOn(logger, 'warn')
    const opens = watch('open', `input-${receipt.id}/source`, 'EMFILE')

    await expect(
      store.reusableReceipt(KEY, sourceFor(1), 128, { retentionOwnerId: 'task-2' })
    ).resolves.toBeUndefined()
    faults.clear()

    // Witness: reuse reached the copy and failed on it.
    expect(opens.length).toBeGreaterThan(0)
    expect(warnings(warn)).toContainEqual({ code: 'EMFILE', message: REUSE_KEPT })
    expect(exists(path.join(root, receipt.path))).toBe(true)
    await expect(store.readManagedFile(receipt.path, KEY)).resolves.toEqual(bytes)
    // Once the disk answers, the same copy is reused.
    await expect(store.reusableReceipt(KEY, sourceFor(1), 128)).resolves.toMatchObject({
      id: receipt.id,
    })
  })

  it('reuse still removes a copy whose bytes no longer match its receipt', async () => {
    const store = await openStore()
    const root = callerDirectory(hostRoot, KEY)
    const { receipt } = await completedCopy(store, root, KEY, 2, 64)
    const removed = await expiryCount('incomplete_removed')
    syncFs.writeFileSync(path.join(root, receipt.path), Buffer.alloc(64, 0xee))

    await expect(store.reusableReceipt(KEY, sourceFor(2), 64)).resolves.toBeUndefined()
    expect(exists(path.join(root, `.gfs-downloads/input-${receipt.id}`))).toBe(false)
    expect(await expiryCount('incomplete_removed')).toBe(removed + 1)
  })

  it('a sweep that cannot lstat a published copy keeps it and counts sweep_failed', async () => {
    const store = await openStore()
    const root = callerDirectory(hostRoot, KEY)
    const { receipt, bytes } = await completedCopy(store, root, KEY, 3, 96, { owner: 'task-1' })
    const swept = await expiryCount('sweep_failed')
    const warn = vi.spyOn(logger, 'warn')
    const lstats = watch('lstat', `input-${receipt.id}/source`, 'EMFILE')

    const result = await store.cleanupExpired()
    faults.clear()

    expect(lstats.length).toBeGreaterThan(0)
    expect(result).toMatchObject({ removedIncomplete: 0, removedExpired: 0, removeFailed: 0 })
    expect(await expiryCount('sweep_failed')).toBe(swept + 1)
    expect(warnings(warn)).toContainEqual({ code: 'EMFILE', message: SWEEP_KEPT })
    await expect(store.readManagedFile(receipt.path, KEY)).resolves.toEqual(bytes)
    // Contrast: a source that is really gone is removed by the next sweep.
    syncFs.rmSync(path.join(root, receipt.path))
    await expect(store.cleanupExpired()).resolves.toMatchObject({ removedIncomplete: 1 })
  })

  it('a startup sweep that cannot open meta.json keeps the copy for the next start', async () => {
    const root = callerDirectory(hostRoot, KEY)
    const bytes = Buffer.alloc(100, 7)
    const id = '00000000-0000-4000-8000-000000000001'
    const planted = plantDownload(root, { id, bytes, meta: metaFor(id, bytes, Date.now()) })
    const opens = watch('open', '/meta.json', 'EMFILE')

    await openStore()
    faults.clear()

    expect(opens.length).toBeGreaterThan(0)
    expect(exists(planted.directory)).toBe(true)
    // Witness: a start that can read it adopts it.
    const second = await openStore()
    expect((await second.debugInventory()).byCaller.get(KEY)).toEqual({ files: 1, bytes: 100 })
  })

  it('an admission that cannot verify .gfs-downloads fails and keeps every copy', async () => {
    const store = await openStore()
    const root = callerDirectory(hostRoot, KEY)
    const { receipt, bytes } = await completedCopy(store, root, KEY, 4, 80, { owner: 'task-1' })
    const opens = watch('open', `${KEY}/.gfs-downloads`, 'EMFILE')

    await expect(startTransfer(store, root, KEY, 5, 40)).rejects.toMatchObject({
      code: 'storage_write_failed',
    })
    faults.clear()

    expect(opens.length).toBeGreaterThan(0)
    await expect(store.readManagedFile(receipt.path, KEY)).resolves.toEqual(bytes)
    // Contrast: a `.gfs-downloads` with a non-private mode is replaced.
    syncFs.chmodSync(path.join(root, '.gfs-downloads'), 0o755)
    const replaced = await startTransfer(store, root, KEY, 6, 40)
    expect(exists(path.join(root, receipt.path))).toBe(false)
    expect(exists(path.join(root, replaced.transfer.partialPath))).toBe(true)
  })

  it.each([
    ['readManagedFile', (store: GfsDownloadStore, p: string) => store.readManagedFile(p, KEY)],
    [
      'readManagedFilePrefix',
      (store: GfsDownloadStore, p: string) => store.readManagedFilePrefix(p, KEY),
    ],
  ])(
    '%s logs a non-ENOENT failure of the owner’s copy and still answers download_missing',
    async (_name, read) => {
      const store = await openStore()
      const root = callerDirectory(hostRoot, KEY)
      const { receipt } = await completedCopy(store, root, KEY, 7, 32)
      const warn = vi.spyOn(logger, 'warn')
      const failed = watch('open', `input-${receipt.id}/source`, 'EMFILE')

      await expect(read(store, receipt.path)).rejects.toMatchObject({ code: 'download_missing' })
      expect(failed).toHaveLength(1)
      expect(warnings(warn)).toContainEqual({ code: 'EMFILE', message: READ_FAILED })

      // ENOENT is the copy's absence: the same answer, nothing logged. The
      // witness is the open the read had to attempt.
      warn.mockClear()
      syncFs.rmSync(path.join(root, receipt.path))
      const attempted = watch('open', `input-${receipt.id}/source`)
      await expect(read(store, receipt.path)).rejects.toMatchObject({ code: 'download_missing' })
      expect(attempted).toHaveLength(1)
      expect(warnings(warn).map(entry => entry.message)).not.toContain(READ_FAILED)
    }
  )
})

const REMOVE_FAILED =
  'GFS download store could not remove a download directory; the next sweep retries it'
const UNDO_FAILED = 'GFS download store could not restore a directory after refusing to remove it'

describe('GFS download store adversarial round: trash, eviction and undo (ADV-2/F2/F3/F8)', () => {
  const KEY = 'bob-key'

  it('a replaced .gfs-downloads stranded by a failed rm is protected and swept', async () => {
    const store = await openStore()
    const root = callerDirectory(hostRoot, KEY)
    const { receipt } = await completedCopy(store, root, KEY, 1, 48)
    syncFs.chmodSync(path.join(root, '.gfs-downloads'), 0o755)
    const removals = watch('rm', '', 'EIO')

    await expect(startTransfer(store, root, KEY, 2, 16)).rejects.toMatchObject({
      code: 'storage_write_failed',
    })
    faults.clear()

    expect(removals).toHaveLength(1)
    const stranded = syncFs.readdirSync(root).filter(name => name.startsWith('.gfs-downloads.'))
    expect(stranded).toHaveLength(1)
    expect(stranded[0]).toMatch(new RegExp(`^${GFS_DOWNLOADS_TRASH_PREFIX.replaceAll('.', '\\.')}`))
    expect(isProtectedWorkspacePath(`${stranded[0]}/input-${receipt.id}/source`)).toBe(true)
    expect(isGfsDownloadPath(stranded[0]!)).toBe(true)

    const removed = await expiryCount('incomplete_removed')
    await store.cleanupExpired()
    expect(exists(path.join(root, stranded[0]!))).toBe(false)
    expect(await expiryCount('incomplete_removed')).toBeGreaterThan(removed)
  })

  it('an eviction whose removal fails keeps the copy published and charged', async () => {
    const limited = await withEnvironment(
      {
        MCP_HOST_GFS_MAX_FILE_BYTES: '10',
        MCP_HOST_GFS_DOWNLOAD_STORAGE_BYTES: '30',
        MCP_HOST_GFS_CALLER_DOWNLOAD_STORAGE_BYTES: '15',
      },
      async () => {
        vi.resetModules()
        const { GfsDownloadStore: Store } = await import('./gfsDownloadStore')
        const opened = new Store(hostRoot) as unknown as GfsDownloadStore
        stores.push(opened)
        await opened.initialize()
        return opened
      }
    )
    const root = callerDirectory(hostRoot, KEY)
    const { receipt, bytes } = await completedCopy(limited, root, KEY, 3, 10)
    const failedRemovals = await expiryCount('remove_failed')
    const renames = watch('rename', `input-${receipt.id}`, 'EIO')

    await expect(startTransfer(limited, root, KEY, 4, 10)).rejects.toMatchObject({
      code: 'caller_quota_exceeded',
    })
    faults.clear()

    // Witness: the eviction was attempted and failed.
    expect(renames).toHaveLength(1)
    expect(await expiryCount('remove_failed')).toBe(failedRemovals + 1)
    await expect(limited.readManagedFile(receipt.path, KEY)).resolves.toEqual(bytes)
    await expect(limited.reusableReceipt(KEY, sourceFor(3), 10)).resolves.toMatchObject({
      id: receipt.id,
    })
    // A sweep does not turn it into an adopted copy either.
    await limited.cleanupExpired()
    await expect(limited.readManagedFile(receipt.path, KEY)).resolves.toEqual(bytes)
  })

  it('a refused removal whose undo also fails reports the refusal, not the undo', async () => {
    const store = await openStore()
    const root = callerDirectory(hostRoot, KEY)
    const { transfer } = await startTransfer(store, root, KEY, 5, 16)
    const warn = vi.spyOn(logger, 'warn')
    let renamedToTrash = false
    injectFault('rename', target => {
      if (target.endsWith(`input-${transfer.id}`)) {
        renamedToTrash = true
        return undefined
      }
      return path.basename(target).startsWith('.trash-') ? 'EXDEV' : undefined
    })
    injectFault('realpath', target =>
      renamedToTrash && target.endsWith('.gfs-downloads') ? 'EIO' : undefined
    )

    await expect(store.fail(transfer.id, KEY)).rejects.toMatchObject({
      code: 'storage_write_failed',
    })
    faults.clear()

    expect(renamedToTrash).toBe(true)
    expect(warnings(warn)).toContainEqual({ code: 'EXDEV', message: UNDO_FAILED })
    expect(warnings(warn)).toContainEqual({ code: 'EIO', message: REMOVE_FAILED })
    expect(warnings(warn)).not.toContainEqual({ code: 'EXDEV', message: REMOVE_FAILED })
  })

  it('a removal of a directory that never existed is not counted as removed', async () => {
    const store = await openStore()
    const root = callerDirectory(hostRoot, KEY)
    await completedCopy(store, root, KEY, 6, 16)
    const removed = await expiryCount('incomplete_removed')
    const opens = watch('open', `${KEY}/.gfs-downloads`, 'EMFILE')
    const renames: string[] = []
    injectFault('rename', target => {
      if (path.basename(target).startsWith('input-')) renames.push(target)
      return undefined
    })

    await expect(startTransfer(store, root, KEY, 7, 16)).rejects.toMatchObject({
      code: 'storage_write_failed',
    })
    faults.clear()

    // Witness: the admission failed after reserving its directory name and
    // tried to remove it.
    expect(opens.length).toBeGreaterThan(0)
    expect(renames).toHaveLength(1)
    expect(exists(renames[0]!)).toBe(false)
    expect(await expiryCount('incomplete_removed')).toBe(removed)
  })

  it('a sweep keeps an incomplete entry indexed until its removal succeeds', async () => {
    const store = await openStore()
    const root = callerDirectory(hostRoot, KEY)
    const { receipt } = await completedCopy(store, root, KEY, 8, 16)
    const directory = path.join(root, `.gfs-downloads/input-${receipt.id}`)
    // A shorter source makes the indexed copy incomplete for the sweep.
    syncFs.writeFileSync(path.join(directory, 'source'), 'short')
    const failedRemovals = await expiryCount('remove_failed')
    const removals = watch('rm', '', 'EIO')

    await store.cleanupExpired()
    faults.clear()

    // Witness: the sweep tried to remove it, and the removal failed.
    expect(removals).toHaveLength(1)
    expect(await expiryCount('remove_failed')).toBe(failedRemovals + 1)
    expect(indexedEntry(store, receipt.id)).toBeDefined()

    await store.cleanupExpired()
    expect(exists(directory)).toBe(false)
    expect(() => indexedEntry(store, receipt.id)).toThrow('entry is not indexed')
  })
})

interface IndexedEntryView {
  sourceIdentity?: { dev: bigint; ino: bigint }
}

/** White-box view of the index, for the one identity field no fs seam can reach. */
function indexedEntry(store: GfsDownloadStore, id: string): IndexedEntryView {
  const entry = (store as unknown as { entries: Map<string, IndexedEntryView> }).entries.get(id)
  if (entry === undefined) throw new Error('entry is not indexed')
  return entry
}

describe('GFS download store adversarial round: expiry, close, recency and removal proof', () => {
  const KEY = 'carol-key'
  const T0 = new Date('2026-10-08T10:00:00.000Z')

  it('S17: createTransfer refuses an expiry at or before its creation instant', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
    const store = await openStore()
    const root = callerDirectory(hostRoot, KEY)
    const admit = (expiresAtMs: number) =>
      store.createTransfer({
        callerIdentity: KEY,
        callerWorkspacePath: root,
        source: sourceFor(1),
        sizeBytes: 4,
        expiresAt: new Date(expiresAtMs).toISOString(),
      })

    await expect(admit(T0.getTime() - 1)).rejects.toThrow(RangeError)
    await expect(admit(T0.getTime())).rejects.toThrow(RangeError)
    // Witness: one millisecond later is admitted.
    await expect(admit(T0.getTime() + 1)).resolves.toMatchObject({ sizeBytes: 4 })
  })

  it('S18: close() does not wait for pinned copies, only for active transfers', async () => {
    const store = await openStore()
    const root = callerDirectory(hostRoot, KEY)
    await completedCopy(store, root, KEY, 2, 16, { owner: 'task-1' })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let closed = false
    const closing = store.close(60_000).then(() => {
      closed = true
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(closed).toBe(true)
    expect(store.isAvailable()).toBe(false)
    await closing

    // Contrast: an active transfer holds close() until its deadline.
    const busy = await openStore()
    await startTransfer(busy, root, KEY, 3, 16)
    let busyClosed = false
    const busyClosing = busy.close(60_000).then(() => {
      busyClosed = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(busyClosed).toBe(false)
    await vi.advanceTimersByTimeAsync(60_000)
    await busyClosing
    expect(busyClosed).toBe(true)
  })

  it('S28: a managed read refreshes recency, so the unread copy is evicted first', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
    const limited = await withEnvironment(
      {
        MCP_HOST_GFS_MAX_FILE_BYTES: '10',
        MCP_HOST_GFS_DOWNLOAD_STORAGE_BYTES: '30',
        MCP_HOST_GFS_CALLER_DOWNLOAD_STORAGE_BYTES: '15',
      },
      async () => {
        vi.resetModules()
        const { GfsDownloadStore: Store } = await import('./gfsDownloadStore')
        const opened = new Store(hostRoot) as unknown as GfsDownloadStore
        stores.push(opened)
        await opened.initialize()
        return opened
      }
    )
    const root = callerDirectory(hostRoot, KEY)
    const tick = () => vi.setSystemTime(Date.now() + 1_000)
    const older = await completedCopy(limited, root, KEY, 4, 5)
    tick()
    const newer = await completedCopy(limited, root, KEY, 5, 5)
    tick()
    await expect(limited.readManagedFile(older.receipt.path, KEY)).resolves.toEqual(older.bytes)
    tick()

    await startTransfer(limited, root, KEY, 6, 10)

    expect(exists(path.join(root, `.gfs-downloads/input-${newer.receipt.id}`))).toBe(false)
    expect(exists(path.join(root, `.gfs-downloads/input-${older.receipt.id}`))).toBe(true)
  })

  it('S31: a removal is proven by ENOENT, not by rm returning', async () => {
    const store = await openStore()
    const root = callerDirectory(hostRoot, KEY)
    const { transfer } = await startTransfer(store, root, KEY, 7, 16)
    const failedRemovals = await expiryCount('remove_failed')
    const removals = watch('rm', '', SKIP_CALL)

    await expect(store.fail(transfer.id, KEY)).rejects.toMatchObject({
      code: 'storage_write_failed',
    })
    faults.clear()

    expect(removals).toHaveLength(1)
    expect(await expiryCount('remove_failed')).toBe(failedRemovals + 1)
    const downloads = path.join(root, '.gfs-downloads')
    const stranded = syncFs.readdirSync(downloads).filter(name => name.startsWith('.trash-'))
    expect(stranded).toHaveLength(1)
    // The next sweep removes what the failed removal left.
    await store.cleanupExpired()
    expect(exists(path.join(downloads, stranded[0]!))).toBe(false)
  })

  it('S01: a descriptor with the published inode number on another device is not served', async () => {
    const store = await openStore()
    const root = callerDirectory(hostRoot, KEY)
    const { receipt, bytes } = await completedCopy(store, root, KEY, 8, 24)
    // Witness: the published identity serves the bytes.
    await expect(store.readManagedFile(receipt.path, KEY)).resolves.toEqual(bytes)
    const identity = indexedEntry(store, receipt.id).sourceIdentity!
    identity.dev += 1n

    await expect(store.readManagedFile(receipt.path, KEY)).rejects.toMatchObject({
      code: 'download_missing',
    })
    await expect(store.reusableReceipt(KEY, sourceFor(8), 24)).resolves.toBeUndefined()
  })

  it('S09: publication syncs the download directory after the source rename', async () => {
    const store = await openStore()
    const root = callerDirectory(hostRoot, KEY)
    const { transfer, bytes } = await startTransfer(store, root, KEY, 9, 12)
    const directory = path.join(root, `.gfs-downloads/input-${transfer.id}`)
    const events: string[] = []
    injectFault('rename', target => {
      if (target.endsWith(`input-${transfer.id}/source.partial`)) events.push('rename-source')
      return undefined
    })
    injectFault('open', target => {
      if (path.resolve(target) === path.resolve(syncFs.realpathSync(directory)))
        events.push('open-directory')
      return undefined
    })

    await store.publish(transfer.id, KEY, digestOf(bytes))
    faults.clear()

    expect(events).toContain('rename-source')
    expect(events.slice(events.indexOf('rename-source'))).toContain('open-directory')
  })
})
