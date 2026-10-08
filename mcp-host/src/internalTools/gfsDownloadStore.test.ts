import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { register } from 'prom-client'
import { logger } from '../logger'
import type { GfsImageSource } from '../visualInput/policy'
import { GfsDownloadStore, GfsDownloadStoreError } from './gfsDownloadStore'

const { statfsBoundary, renameBoundary, rmBoundary, lstatBoundary, hashBoundary } = vi.hoisted(
  () => ({
    statfsBoundary: vi.fn(),
    renameBoundary: vi.fn(),
    rmBoundary: vi.fn(),
    lstatBoundary: vi.fn(),
    hashBoundary: vi.fn(),
  })
)
// Pass-through boundaries: every test starts with the real implementation and
// overrides one call only where it simulates a filesystem failure or observes
// an order. Test setup and assertions use the actual modules.
vi.mock('node:fs/promises', async original => ({
  ...(await original<typeof fs>()),
  statfs: statfsBoundary,
  rename: renameBoundary,
  rm: rmBoundary,
  lstat: lstatBoundary,
}))
vi.mock('node:crypto', async original => ({
  ...(await original<typeof crypto>()),
  createHash: hashBoundary,
}))

let nativeFs: typeof fs
let nativeCrypto: typeof crypto
let hostRoot: string
let callerRoot: string
let store: GfsDownloadStore
const extraStores: GfsDownloadStore[] = []

const CALLER = 'caller-a'

function sourceFor(index: number, version = 1): GfsImageSource {
  const resourceId = index.toString(16).padStart(32, '0')
  return {
    kind: 'gfs',
    drive: 'main',
    resourceId,
    gfsUri: `gfs://main/${resourceId}`,
    name: `fixture-${index}.bin`,
    version,
  }
}

function future(ms = 60 * 60_000): string {
  return new Date(Date.now() + ms).toISOString()
}

function digest(bytes: Buffer): string {
  return nativeCrypto.createHash('sha256').update(bytes).digest('hex')
}

async function callerDirectory(host: string, caller: string): Promise<string> {
  const root = path.join(host, 'users', caller)
  await nativeFs.mkdir(root, { recursive: true, mode: 0o700 })
  return root
}

function downloadDirectory(root: string, id: string): string {
  return path.join(root, '.gfs-downloads', `input-${id}`)
}

async function exists(target: string): Promise<boolean> {
  try {
    await nativeFs.lstat(target)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function startTransfer(
  target: GfsDownloadStore,
  root: string,
  caller: string,
  index: number,
  sizeBytes: number,
  options: { version?: number; owner?: string } = {}
) {
  const bytes = Buffer.alloc(sizeBytes, (index % 251) + 1)
  const transfer = await target.createTransfer({
    callerIdentity: caller,
    callerWorkspacePath: root,
    source: sourceFor(index, options.version ?? 1),
    sizeBytes,
    expiresAt: future(),
    ...(options.owner === undefined ? {} : { retentionOwnerId: options.owner }),
  })
  await nativeFs.writeFile(path.join(root, transfer.partialPath), bytes)
  return { transfer, bytes }
}

async function completedCopy(
  target: GfsDownloadStore,
  root: string,
  caller: string,
  index: number,
  sizeBytes: number,
  options: { version?: number; owner?: string } = {}
) {
  const { transfer, bytes } = await startTransfer(target, root, caller, index, sizeBytes, options)
  const receipt = await target.publish(transfer.id, caller, digest(bytes))
  return { receipt, bytes }
}

async function metricValue(name: string, labels: Record<string, string>): Promise<number> {
  const metric = register.getSingleMetric(name)
  if (metric === undefined) throw new Error(`metric ${name} is not registered`)
  const { values } = await metric.get()
  return values
    .filter(sample => Object.entries(labels).every(([key, value]) => sample.labels[key] === value))
    .reduce((sum, sample) => sum + sample.value, 0)
}

const expiryCount = (outcome: string) =>
  metricValue('clerum_gfs_download_expiry_total', { outcome })
const quotaCount = (scope: string, reason: string) =>
  metricValue('clerum_gfs_download_quota_total', { scope, reason })

async function openStore(host: string): Promise<GfsDownloadStore> {
  const opened = new GfsDownloadStore(host)
  extraStores.push(opened)
  await opened.initialize()
  return opened
}

/** Re-imports the store with environment limits; the logger of that copy is not spied. */
async function loadLimitedStore(env: Record<string, string>) {
  const saved = { ...process.env }
  Object.assign(process.env, env)
  try {
    vi.resetModules()
    const storeModule = await import('./gfsDownloadStore')
    const policyModule = await import('./gfsFilePolicy')
    return { Store: storeModule.GfsDownloadStore, limits: policyModule.GFS_FILE_LIMITS }
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

async function limitedStore(env: Record<string, string>) {
  const { Store, limits } = await loadLimitedStore(env)
  const limited = new Store(hostRoot)
  extraStores.push(limited as unknown as GfsDownloadStore)
  await limited.initialize()
  return { limited, limits }
}

/** Distinct createdAt values so the oldest-first eviction order is deterministic. */
function tick(): void {
  vi.setSystemTime(Date.now() + 1_000)
}

async function writeMeta(directory: string, meta: Record<string, unknown>): Promise<void> {
  await nativeFs.writeFile(path.join(directory, 'meta.json'), JSON.stringify(meta), {
    mode: 0o600,
  })
}

function metaFor(id: string, bytes: Buffer, overrides: Record<string, unknown> = {}) {
  const now = Date.now()
  return {
    schemaVersion: 1,
    id,
    callerIdentity: CALLER,
    source: sourceFor(900),
    sizeBytes: bytes.byteLength,
    sha256: digest(bytes),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60 * 60_000).toISOString(),
    ...overrides,
  }
}

async function handMadeDirectory(root: string): Promise<{ id: string; directory: string }> {
  const id = nativeCrypto.randomUUID()
  const directory = downloadDirectory(root, id)
  await nativeFs.mkdir(directory, { recursive: true, mode: 0o700 })
  await nativeFs.chmod(path.dirname(directory), 0o700)
  return { id, directory }
}

beforeEach(async () => {
  nativeFs = await vi.importActual<typeof fs>('node:fs/promises')
  nativeCrypto = await vi.importActual<typeof crypto>('node:crypto')
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-08T10:00:00.000Z'))
  for (const boundary of [statfsBoundary, renameBoundary, rmBoundary, lstatBoundary, hashBoundary])
    boundary.mockReset()
  statfsBoundary.mockImplementation(nativeFs.statfs)
  renameBoundary.mockImplementation(nativeFs.rename)
  rmBoundary.mockImplementation(nativeFs.rm)
  lstatBoundary.mockImplementation(nativeFs.lstat)
  hashBoundary.mockImplementation((algorithm: string) => nativeCrypto.createHash(algorithm))
  hostRoot = await nativeFs.mkdtemp(path.join(tmpdir(), 'gfs-store-'))
  callerRoot = await callerDirectory(hostRoot, CALLER)
  store = new GfsDownloadStore(hostRoot)
  await store.initialize()
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  for (const opened of extraStores.splice(0)) await opened.close(0)
  await store.close(0)
  await nativeFs.rm(hostRoot, { recursive: true, force: true })
})

describe('GFS download store: publication', () => {
  it('F1: publish writes meta.json before source and every visible source has a meta.json', async () => {
    const { transfer, bytes } = await startTransfer(store, callerRoot, CALLER, 1, 32)
    renameBoundary.mockClear()
    const receipt = await store.publish(transfer.id, CALLER, digest(bytes))

    const renamedTo = renameBoundary.mock.calls.map(([, to]) => path.basename(String(to)))
    // Witness: both renames of the publication happened.
    expect(renamedTo).toHaveLength(2)
    expect(renamedTo).toEqual(['meta.json', 'source'])
    const directory = downloadDirectory(callerRoot, receipt.id)
    expect((await nativeFs.readdir(directory)).sort()).toEqual(['meta.json', 'source'])
    const meta = JSON.parse(await nativeFs.readFile(path.join(directory, 'meta.json'), 'utf8'))
    expect(meta).toMatchObject({
      schemaVersion: 1,
      id: receipt.id,
      callerIdentity: CALLER,
      sizeBytes: 32,
      sha256: digest(bytes),
    })
    expect(receipt.path).toBe(`.gfs-downloads/input-${receipt.id}/source`)
  })

  it('F2: a cancelled publish leaves an incomplete directory that is not reusable and is swept', async () => {
    const { transfer, bytes } = await startTransfer(store, callerRoot, CALLER, 2, 16)
    const controller = new AbortController()
    renameBoundary.mockImplementation(async (from: string, to: string) => {
      await nativeFs.rename(from, to)
      // Cancelled after meta.json is visible and before source is.
      if (path.basename(to) === 'meta.json') controller.abort()
    })
    await expect(
      store.publish(transfer.id, CALLER, digest(bytes), { signal: controller.signal })
    ).rejects.toMatchObject({ code: 'publication_cancelled' })
    renameBoundary.mockImplementation(nativeFs.rename)

    const directory = downloadDirectory(callerRoot, transfer.id)
    // Witness: the cancelled directory is on disk with meta.json and no source.
    expect((await nativeFs.readdir(directory)).sort()).toEqual(['meta.json', 'source.partial'])
    await expect(store.reusableReceipt(CALLER, sourceFor(2), 16)).resolves.toBeUndefined()

    // A Host stop leaves the reservation behind; the next start sweeps it.
    await store.close(0)
    const info = vi.spyOn(logger, 'info')
    await openStore(hostRoot)
    expect(await exists(directory)).toBe(false)
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ component: 'GfsDownloadStore', removedIncomplete: 1 }),
      'GFS download store initialized'
    )
  })

  it('F3: a crash between the two renames leaves meta.json and source.partial and the next store removes it', async () => {
    const bytes = Buffer.alloc(24, 7)
    const { id, directory } = await handMadeDirectory(callerRoot)
    await writeMeta(directory, metaFor(id, bytes))
    await nativeFs.writeFile(path.join(directory, 'source.partial'), bytes, { mode: 0o600 })
    const info = vi.spyOn(logger, 'info')

    await openStore(hostRoot)

    expect(await exists(directory)).toBe(false)
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ removedIncomplete: 1, retainedCompleted: 0 }),
      'GFS download store initialized'
    )
  })

  it('F4: an EIO while writing meta.json fails that publish only and the next admission succeeds', async () => {
    const { transfer, bytes } = await startTransfer(store, callerRoot, CALLER, 4, 16)
    renameBoundary.mockImplementationOnce(async () => {
      throw Object.assign(new Error('injected EIO'), { code: 'EIO' })
    })
    await expect(store.publish(transfer.id, CALLER, digest(bytes))).rejects.toMatchObject({
      code: 'storage_write_failed',
    })
    // The producer's cleanup path: the id stayed active so fail() can remove it.
    await store.fail(transfer.id, CALLER)
    expect(await exists(downloadDirectory(callerRoot, transfer.id))).toBe(false)

    const next = await completedCopy(store, callerRoot, CALLER, 5, 16)
    expect(next.receipt.sha256).toBe(digest(next.bytes))
    await expect(store.readManagedFile(next.receipt.path, CALLER)).resolves.toEqual(next.bytes)
  })

  it('F4b: a temporary meta.json that cannot be removed after a failed publish is logged, not swallowed', async () => {
    const { transfer, bytes } = await startTransfer(store, callerRoot, CALLER, 3, 16)
    renameBoundary.mockImplementationOnce(async () => {
      throw Object.assign(new Error('injected EIO'), { code: 'EIO' })
    })
    rmBoundary.mockImplementation(async (target: string, options: unknown) => {
      if (path.basename(target).startsWith('meta.json.tmp-'))
        throw Object.assign(new Error('injected EACCES'), { code: 'EACCES' })
      return nativeFs.rm(target, options as Parameters<typeof nativeFs.rm>[1])
    })
    const warn = vi.spyOn(logger, 'warn')

    await expect(store.publish(transfer.id, CALLER, digest(bytes))).rejects.toMatchObject({
      code: 'storage_write_failed',
    })

    // Witness: the cleanup attempted the temporary file and failed.
    const directory = downloadDirectory(callerRoot, transfer.id)
    const leftover = (await nativeFs.readdir(directory)).filter(name =>
      name.startsWith('meta.json.tmp-')
    )
    expect(leftover).toHaveLength(1)
    expect(rmBoundary).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`/input-${transfer.id}/${leftover[0]!}$`)),
      { force: true }
    )
    // The log line carries the errno code only, never the path.
    expect(warn).toHaveBeenCalledWith(
      { component: 'GfsDownloadStore', code: 'EACCES' },
      expect.stringContaining('could not remove a temporary meta.json')
    )
    rmBoundary.mockImplementation(nativeFs.rm)
    await store.fail(transfer.id, CALLER)
    expect(await exists(directory)).toBe(false)
  })
})

describe('GFS download store: reuse', () => {
  it('F5: reuse returns the same id when the content hash matches', async () => {
    const { receipt } = await completedCopy(store, callerRoot, CALLER, 6, 40)
    const reused = await store.reusableReceipt(CALLER, sourceFor(6), 40)
    expect(reused).toMatchObject({ id: receipt.id, sha256: receipt.sha256, path: receipt.path })
  })

  it('F6: reuse deletes a directory whose content no longer matches and returns undefined', async () => {
    const { receipt } = await completedCopy(store, callerRoot, CALLER, 7, 40)
    const directory = downloadDirectory(callerRoot, receipt.id)
    await nativeFs.writeFile(path.join(directory, 'source'), Buffer.alloc(40, 0xee))
    hashBoundary.mockClear()

    await expect(store.reusableReceipt(CALLER, sourceFor(7), 40)).resolves.toBeUndefined()

    // Witness: the content was hashed exactly once before the verdict.
    expect(hashBoundary).toHaveBeenCalledTimes(1)
    expect(await exists(directory)).toBe(false)
  })

  it('F7: reuse does not match another caller, another version or an expired entry', async () => {
    const { receipt } = await completedCopy(store, callerRoot, CALLER, 8, 12)
    await expect(store.reusableReceipt('caller-b', sourceFor(8), 12)).resolves.toBeUndefined()
    await expect(store.reusableReceipt(CALLER, sourceFor(8, 2), 12)).resolves.toBeUndefined()
    // Witness: the same parameters with the right caller do match.
    await expect(store.reusableReceipt(CALLER, sourceFor(8), 12)).resolves.toMatchObject({
      id: receipt.id,
    })
    vi.setSystemTime(Date.now() + 2 * 60 * 60_000)
    await expect(store.reusableReceipt(CALLER, sourceFor(8), 12)).resolves.toBeUndefined()
  })

  it("F7b: another caller's reuse lookup never hashes or removes a copy it does not own", async () => {
    const { receipt } = await completedCopy(store, callerRoot, CALLER, 9, 24)
    const directory = downloadDirectory(callerRoot, receipt.id)
    // Same size, different content: only a hash can tell the copy is corrupt.
    await nativeFs.writeFile(path.join(directory, 'source'), Buffer.alloc(24, 0xee))
    const removedBefore = await expiryCount('incomplete_removed')
    hashBoundary.mockClear()

    await expect(store.reusableReceipt('caller-b', sourceFor(9), 24)).resolves.toBeUndefined()

    expect(hashBoundary).not.toHaveBeenCalled()
    expect(await exists(path.join(directory, 'source'))).toBe(true)
    expect(await expiryCount('incomplete_removed')).toBe(removedBefore)

    // Witness: the owner's identical lookup reaches the copy, hashes it and
    // removes it, so the lookup above was answered by the caller filter.
    await expect(store.reusableReceipt(CALLER, sourceFor(9), 24)).resolves.toBeUndefined()
    expect(hashBoundary).toHaveBeenCalledTimes(1)
    expect(await exists(directory)).toBe(false)
    expect(await expiryCount('incomplete_removed')).toBe(removedBefore + 1)
  })
})

/** A 10-byte file limit and the whole (mocked) volume as the retained budget. */
const SMALL_FILES_FULL_VOLUME = {
  MCP_HOST_GFS_MAX_FILE_BYTES: '10',
  MCP_HOST_GFS_DOWNLOAD_STORAGE_PERCENT: '100',
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

describe('GFS download store: quotas and eviction', () => {
  it("F9: a host over quota may evict any caller's oldest completed download", async () => {
    volumeOf(30)
    const { limited } = await limitedStore(SMALL_FILES_FULL_VOLUME)
    const otherRoot = await callerDirectory(hostRoot, 'caller-b')
    const thirdRoot = await callerDirectory(hostRoot, 'caller-c')
    const other = await completedCopy(limited, otherRoot, 'caller-b', 20, 10)
    tick()
    const third = await completedCopy(limited, thirdRoot, 'caller-c', 21, 10)
    tick()
    const own = await completedCopy(limited, callerRoot, CALLER, 22, 10)
    tick()

    // caller-a stays within 15; the Host would reach 35 of 30.
    await startTransfer(limited, callerRoot, CALLER, 23, 5)

    expect(await exists(downloadDirectory(otherRoot, other.receipt.id))).toBe(false)
    // Witnesses: only the oldest copy went, whoever owned the newer ones.
    expect(await exists(downloadDirectory(thirdRoot, third.receipt.id))).toBe(true)
    expect(await exists(downloadDirectory(callerRoot, own.receipt.id))).toBe(true)
  })

  it('F10: when eviction cannot make room nothing is deleted', async () => {
    volumeOf(16)
    const { limited } = await limitedStore(SMALL_FILES_FULL_VOLUME)
    await completedCopy(limited, callerRoot, CALLER, 30, 8, { owner: 'task-1' })
    tick()
    await completedCopy(limited, callerRoot, CALLER, 31, 8, { owner: 'task-1' })
    const downloads = path.join(callerRoot, '.gfs-downloads')
    const before = (await nativeFs.readdir(downloads)).sort()
    const denied = await quotaCount('host', 'storage_bytes')
    lstatBoundary.mockClear()

    await expect(startTransfer(limited, callerRoot, CALLER, 32, 8)).rejects.toMatchObject({
      code: 'host_quota_exceeded',
    })

    // Witness: the admission read the inventory before refusing.
    expect(lstatBoundary.mock.calls.length).toBeGreaterThan(0)
    expect((await nativeFs.readdir(downloads)).sort()).toEqual(before)
    expect(before).toHaveLength(2)
    expect(await quotaCount('host', 'storage_bytes')).toBe(denied + 1)
  })

  it("F10b: a quota denial carries only its code, never another caller's id, path, name or usage", async () => {
    volumeOf(30)
    const { limited } = await limitedStore(SMALL_FILES_FULL_VOLUME)
    const otherRoot = await callerDirectory(hostRoot, 'caller-b')
    const thirdRoot = await callerDirectory(hostRoot, 'caller-c')
    const other = await completedCopy(limited, otherRoot, 'caller-b', 24, 10, { owner: 'task-b' })
    const third = await completedCopy(limited, thirdRoot, 'caller-c', 25, 10, { owner: 'task-c' })
    await completedCopy(limited, callerRoot, CALLER, 28, 5, { owner: 'task-a' })

    // Within maxFileBytes (10); the Host would reach 35 of 30 and every copy
    // is pinned, so only the Host quota decision can refuse it.
    const error = await startTransfer(limited, callerRoot, CALLER, 26, 10).then(
      () => undefined,
      (rejection: unknown) => rejection
    )

    // The re-imported module registers its metrics elsewhere; the fitting
    // admission at the end is the witness that this was the quota decision.
    expect(error).toMatchObject({ code: 'host_quota_exceeded' })
    const visible = error as Error & Record<string, unknown>
    expect(Object.keys(visible).sort()).toEqual(['code', 'name'])
    expect(visible.message).toBe('GFS download store failed (host_quota_exceeded)')
    const serialized = JSON.stringify({ ...visible, message: visible.message })
    for (const secret of [
      'caller-b',
      'caller-c',
      otherRoot,
      thirdRoot,
      other.receipt.id,
      third.receipt.id,
      'fixture-24',
      'fixture-25',
      'task-b',
      'task-c',
    ])
      expect(serialized).not.toContain(secret)
    expect(await exists(downloadDirectory(otherRoot, other.receipt.id))).toBe(true)
    // Neither size nor free space was the cause: 5 bytes fit the Host's 30 exactly.
    await expect(startTransfer(limited, callerRoot, CALLER, 27, 5)).resolves.toBeDefined()
  })

  it('F11: pinned and active downloads are never evicted', async () => {
    volumeOf(30)
    const { limited } = await limitedStore(SMALL_FILES_FULL_VOLUME)
    const otherRoot = await callerDirectory(hostRoot, 'caller-b')
    const thirdRoot = await callerDirectory(hostRoot, 'caller-c')
    const pinned = await completedCopy(limited, callerRoot, CALLER, 40, 10, { owner: 'task-40' })
    tick()
    const active = await startTransfer(limited, otherRoot, 'caller-b', 41, 10)
    tick()
    const unpinned = await completedCopy(limited, thirdRoot, 'caller-c', 42, 10)
    tick()

    // The Host would reach 40 of 30; one eviction makes room.
    await startTransfer(limited, await callerDirectory(hostRoot, 'caller-d'), 'caller-d', 43, 10)

    // Witness: the only eligible copy, although the newest, was evicted.
    expect(await exists(downloadDirectory(thirdRoot, unpinned.receipt.id))).toBe(false)
    expect(await exists(downloadDirectory(callerRoot, pinned.receipt.id))).toBe(true)
    expect(await exists(downloadDirectory(otherRoot, active.transfer.id))).toBe(true)
  })

  it('F12: free space is checked with active reservations and the 16 MiB reserve', async () => {
    const otherRoot = await callerDirectory(hostRoot, 'caller-b')
    await startTransfer(store, otherRoot, 'caller-b', 50, 4096 * 10)
    const observed = await nativeFs.statfs(hostRoot, { bigint: true })
    const reserveBlocks = (16n * 1024n * 1024n) / 4096n
    // Room for the request and the reserve, but not for the active reservation.
    statfsBoundary.mockResolvedValue({ ...observed, bsize: 4096n, bavail: reserveBlocks + 2n })
    const denied = await quotaCount('host', 'free_space')

    await expect(startTransfer(store, callerRoot, CALLER, 51, 4096)).rejects.toMatchObject({
      code: 'host_quota_exceeded',
    })
    expect(statfsBoundary).toHaveBeenCalled()
    expect(await quotaCount('host', 'free_space')).toBe(denied + 1)

    // Control: with room for the active reservation too, the same request is admitted.
    statfsBoundary.mockResolvedValue({ ...observed, bsize: 4096n, bavail: reserveBlocks + 11n })
    await expect(startTransfer(store, callerRoot, CALLER, 51, 4096)).resolves.toBeDefined()
  })

  it('F13: eviction candidates are not hashed', async () => {
    volumeOf(15)
    const { limited } = await limitedStore(SMALL_FILES_FULL_VOLUME)
    const first = await completedCopy(limited, callerRoot, CALLER, 60, 3)
    tick()
    const second = await completedCopy(limited, callerRoot, CALLER, 61, 3)
    tick()
    const third = await completedCopy(limited, callerRoot, CALLER, 62, 9)
    tick()
    hashBoundary.mockClear()

    // 15 retained + 6 requested against a budget of 15: the plan takes the two 3-byte copies.
    await startTransfer(limited, callerRoot, CALLER, 64, 6)

    // Witness: two candidates were evicted.
    expect(await exists(downloadDirectory(callerRoot, first.receipt.id))).toBe(false)
    expect(await exists(downloadDirectory(callerRoot, second.receipt.id))).toBe(false)
    expect(hashBoundary).not.toHaveBeenCalled()
    expect(await exists(downloadDirectory(callerRoot, third.receipt.id))).toBe(true)
  })

  it('F14: size above maxFileBytes is refused before any filesystem work', async () => {
    const { limited } = await limitedStore({ MCP_HOST_GFS_MAX_FILE_BYTES: '10' })
    statfsBoundary.mockClear()
    lstatBoundary.mockClear()
    await expect(startTransfer(limited, callerRoot, CALLER, 70, 11)).rejects.toMatchObject({
      code: 'host_quota_exceeded',
    })
    expect(statfsBoundary).not.toHaveBeenCalled()
    expect(lstatBoundary).not.toHaveBeenCalled()
    // Witness: the boundaries are live for an admissible size.
    await startTransfer(limited, callerRoot, CALLER, 71, 10)
    expect(statfsBoundary).toHaveBeenCalled()
    expect(lstatBoundary).toHaveBeenCalled()
  })

  it('F15: concurrency limits per caller and per host return download_busy', async () => {
    const callerBusy = await quotaCount('caller', 'active_downloads')
    const hostBusy = await quotaCount('host', 'active_downloads')
    await startTransfer(store, callerRoot, CALLER, 80, 4)
    await expect(startTransfer(store, callerRoot, CALLER, 81, 4)).rejects.toMatchObject({
      code: 'download_busy',
    })
    expect(await quotaCount('caller', 'active_downloads')).toBe(callerBusy + 1)

    await startTransfer(store, await callerDirectory(hostRoot, 'caller-b'), 'caller-b', 82, 4)
    await expect(
      startTransfer(store, await callerDirectory(hostRoot, 'caller-c'), 'caller-c', 83, 4)
    ).rejects.toMatchObject({ code: 'download_busy' })
    expect(await quotaCount('host', 'active_downloads')).toBe(hostBusy + 1)
  })
})

describe('GFS download store: sweep', () => {
  it('F16: the sweep removes incomplete directories of every shape and keeps complete ones', async () => {
    const kept = await completedCopy(store, callerRoot, CALLER, 90, 20)
    const bytes = Buffer.alloc(20, 3)
    const shapes: string[] = []

    const orphanPartial = await handMadeDirectory(callerRoot)
    await nativeFs.writeFile(path.join(orphanPartial.directory, 'source.partial'), bytes)
    const metaWithoutSource = await handMadeDirectory(callerRoot)
    await writeMeta(metaWithoutSource.directory, metaFor(metaWithoutSource.id, bytes))
    const sourceWithoutMeta = await handMadeDirectory(callerRoot)
    await nativeFs.writeFile(path.join(sourceWithoutMeta.directory, 'source'), bytes)
    const invalidMeta = await handMadeDirectory(callerRoot)
    await writeMeta(invalidMeta.directory, metaFor(invalidMeta.id, bytes, { sha256: 'nope' }))
    await nativeFs.writeFile(path.join(invalidMeta.directory, 'source'), bytes)
    const wrongSize = await handMadeDirectory(callerRoot)
    await writeMeta(wrongSize.directory, metaFor(wrongSize.id, bytes))
    await nativeFs.writeFile(path.join(wrongSize.directory, 'source'), Buffer.alloc(21, 3))
    // A crash while meta.json was being written leaves its temporary name.
    const temporaryMeta = await handMadeDirectory(callerRoot)
    await nativeFs.writeFile(path.join(temporaryMeta.directory, 'source.partial'), bytes)
    await nativeFs.writeFile(
      path.join(temporaryMeta.directory, `meta.json.tmp-${nativeCrypto.randomUUID()}`),
      JSON.stringify(metaFor(temporaryMeta.id, bytes)),
      { mode: 0o600 }
    )
    for (const shape of [
      orphanPartial,
      metaWithoutSource,
      sourceWithoutMeta,
      invalidMeta,
      wrongSize,
      temporaryMeta,
    ])
      shapes.push(shape.directory)
    const removed = await expiryCount('incomplete_removed')

    await expect(store.cleanupExpired()).resolves.toEqual({
      removedExpired: 0,
      removedIncomplete: 6,
      removeFailed: 0,
    })

    for (const directory of shapes) expect(await exists(directory)).toBe(false)
    expect(await expiryCount('incomplete_removed')).toBe(removed + 6)
    // Witness: the complete download stays on disk and readable through the index.
    await expect(store.readManagedFile(kept.receipt.path, CALLER)).resolves.toEqual(kept.bytes)
  })

  it('F17: the sweep removes expired complete downloads unless pinned', async () => {
    const pinned = await completedCopy(store, callerRoot, CALLER, 100, 8, { owner: 'task-100' })
    const loose = await completedCopy(store, callerRoot, CALLER, 101, 8)
    const later = Date.now() + 2 * 60 * 60_000

    await expect(store.cleanupExpired(later)).resolves.toEqual({
      removedExpired: 1,
      removedIncomplete: 0,
      removeFailed: 0,
    })
    expect(await exists(downloadDirectory(callerRoot, loose.receipt.id))).toBe(false)
    expect(await exists(downloadDirectory(callerRoot, pinned.receipt.id))).toBe(true)

    await store.releaseReceiptOwner('task-100', CALLER)
    await expect(store.cleanupExpired(later)).resolves.toMatchObject({ removedExpired: 1 })
    expect(await exists(downloadDirectory(callerRoot, pinned.receipt.id))).toBe(false)
  })

  it('F18: the sweep ignores entries that are not input-<uuid>', async () => {
    const downloads = path.join(callerRoot, '.gfs-downloads')
    await nativeFs.mkdir(downloads, { mode: 0o700 })
    const foreign = [
      path.join(downloads, 'input-not-a-uuid'),
      path.join(downloads, `input-${nativeCrypto.randomUUID().toUpperCase()}`),
      path.join(downloads, 'notes'),
    ]
    for (const directory of foreign) await nativeFs.mkdir(directory, { mode: 0o700 })
    await nativeFs.writeFile(path.join(downloads, 'readme.txt'), 'kept')
    const incomplete = await handMadeDirectory(callerRoot)

    await expect(store.cleanupExpired()).resolves.toMatchObject({ removedIncomplete: 1 })

    // Witness: the incomplete store directory next to them was removed.
    expect(await exists(incomplete.directory)).toBe(false)
    for (const directory of foreign) expect(await exists(directory)).toBe(true)
    expect(await exists(path.join(downloads, 'readme.txt'))).toBe(true)
  })

  it('F19: a symlinked .gfs-downloads is removed without following it', async () => {
    const outside = await nativeFs.mkdtemp(path.join(tmpdir(), 'gfs-store-outside-'))
    try {
      const victim = path.join(outside, `input-${nativeCrypto.randomUUID()}`)
      await nativeFs.mkdir(victim, { mode: 0o700 })
      await nativeFs.writeFile(path.join(victim, 'source.partial'), 'outside')
      const link = path.join(callerRoot, '.gfs-downloads')
      await nativeFs.symlink(outside, link)

      await expect(store.cleanupExpired()).resolves.toMatchObject({ removedIncomplete: 1 })

      expect(await exists(link)).toBe(false)
      await expect(nativeFs.readFile(path.join(victim, 'source.partial'), 'utf8')).resolves.toBe(
        'outside'
      )
    } finally {
      await nativeFs.rm(outside, { recursive: true, force: true })
    }
  })

  it('F20: a failed removal is logged and counted, does not block admission and is retried', async () => {
    const stuck = await handMadeDirectory(callerRoot)
    rmBoundary.mockImplementation(async (target: string, options: unknown) => {
      // The store renames the directory to a private `.trash-<uuid>` name, then removes that.
      if (path.basename(target).startsWith('.trash-'))
        throw Object.assign(new Error('injected EACCES'), { code: 'EACCES' })
      return nativeFs.rm(target, options as Parameters<typeof nativeFs.rm>[1])
    })
    const warn = vi.spyOn(logger, 'warn')
    const failed = await expiryCount('remove_failed')

    await expect(store.cleanupExpired()).resolves.toMatchObject({ removeFailed: 1 })

    expect(warn).toHaveBeenCalledWith(
      { component: 'GfsDownloadStore', code: 'EACCES' },
      expect.stringContaining('could not remove')
    )
    expect(await expiryCount('remove_failed')).toBe(failed + 1)
    const downloads = path.dirname(stuck.directory)
    const leftover = (await nativeFs.readdir(downloads)).filter(name => name.startsWith('.trash-'))
    expect(leftover).toHaveLength(1)
    expect(await exists(stuck.directory)).toBe(false)
    const next = await completedCopy(store, callerRoot, CALLER, 110, 8)
    await expect(store.readManagedFile(next.receipt.path, CALLER)).resolves.toEqual(next.bytes)

    // Once removal works again, the next sweep removes the renamed leftover.
    rmBoundary.mockImplementation(nativeFs.rm)
    await expect(store.cleanupExpired()).resolves.toMatchObject({ removedIncomplete: 1 })
    expect(await exists(path.join(downloads, leftover[0]!))).toBe(false)
  })

  it("F20b: a caller's unreadable download directory is counted and logged, and the store stays available", async () => {
    const downloads = path.join(callerRoot, '.gfs-downloads')
    await nativeFs.mkdir(downloads, { mode: 0o700 })
    const warn = vi.spyOn(logger, 'warn')
    const failed = await expiryCount('sweep_failed')
    await nativeFs.chmod(downloads, 0o000)
    try {
      await expect(store.cleanupExpired()).resolves.toMatchObject({ removeFailed: 0 })

      expect(await expiryCount('sweep_failed')).toBe(failed + 1)
      expect(warn).toHaveBeenCalledWith(
        { component: 'GfsDownloadStore', code: 'EACCES' },
        expect.stringContaining('could not list a download directory')
      )
      expect(store.isAvailable()).toBe(true)
      // Witness: another caller still gets a download admitted and published.
      const otherRoot = await callerDirectory(hostRoot, 'caller-b')
      const other = await completedCopy(store, otherRoot, 'caller-b', 112, 8)
      await expect(store.readManagedFile(other.receipt.path, 'caller-b')).resolves.toEqual(
        other.bytes
      )
    } finally {
      await nativeFs.chmod(downloads, 0o700)
    }
  })
})

describe('GFS download store: managed reads', () => {
  it('F21: readManagedFile returns the exact bytes and answers another caller like a missing copy', async () => {
    const { receipt, bytes } = await completedCopy(store, callerRoot, CALLER, 120, 33)
    await expect(store.readManagedFile(receipt.path, CALLER)).resolves.toEqual(bytes)
    await expect(store.readManagedFile(receipt.path, 'caller-b')).rejects.toMatchObject({
      code: 'download_missing',
    })
    await expect(
      store.readManagedFile(`.gfs-downloads/input-${nativeCrypto.randomUUID()}/source`, CALLER)
    ).rejects.toMatchObject({ code: 'download_missing' })
    await expect(store.readManagedFile('../escape/source', CALLER)).rejects.toMatchObject({
      code: 'download_missing',
    })
  })

  it('F22: readManagedFile deletes a tampered source and reports download_missing', async () => {
    const { receipt } = await completedCopy(store, callerRoot, CALLER, 122, 16)
    const directory = downloadDirectory(callerRoot, receipt.id)
    await nativeFs.writeFile(path.join(directory, 'source'), Buffer.alloc(16, 0xab))
    hashBoundary.mockClear()

    await expect(store.readManagedFile(receipt.path, CALLER)).rejects.toMatchObject({
      code: 'download_missing',
    })

    // Witness: the bytes were hashed once, then the directory was removed.
    expect(hashBoundary).toHaveBeenCalledTimes(1)
    expect(await exists(directory)).toBe(false)
  })

  it('F23: readManagedFilePrefix bounds and size check', async () => {
    const bytes = Buffer.from('0123456789abcdef0123')
    const transfer = await store.createTransfer({
      callerIdentity: CALLER,
      callerWorkspacePath: callerRoot,
      source: sourceFor(123),
      sizeBytes: bytes.byteLength,
      expiresAt: future(),
    })
    await nativeFs.writeFile(path.join(callerRoot, transfer.partialPath), bytes)
    const receipt = await store.publish(transfer.id, CALLER, digest(bytes))

    await expect(store.readManagedFilePrefix(receipt.path, CALLER, 4)).resolves.toEqual(
      Buffer.from('0123')
    )
    await expect(store.readManagedFilePrefix(receipt.path, CALLER)).resolves.toEqual(
      bytes.subarray(0, 16)
    )
    for (const invalid of [0, -1, 4097, 1.5])
      await expect(store.readManagedFilePrefix(receipt.path, CALLER, invalid)).rejects.toThrow(
        RangeError
      )
    await nativeFs.appendFile(path.join(downloadDirectory(callerRoot, receipt.id), 'source'), 'x')
    await expect(store.readManagedFilePrefix(receipt.path, CALLER, 4)).rejects.toMatchObject({
      code: 'download_missing',
    })
  })

  it('F23b: a kubelet fsGroup expansion is restored to the private modes after the content is re-hashed', async () => {
    const { receipt, bytes } = await completedCopy(store, callerRoot, CALLER, 124, 20)
    const directory = downloadDirectory(callerRoot, receipt.id)
    const source = path.join(directory, 'source')
    await nativeFs.chmod(source, 0o660)
    await nativeFs.chmod(directory, 0o2770)
    hashBoundary.mockClear()

    // The prefix read hashes nothing on its own, so a hash here is the
    // fsGroup branch verifying the content before it restores the mode.
    await expect(store.readManagedFilePrefix(receipt.path, CALLER, 8)).resolves.toEqual(
      bytes.subarray(0, 8)
    )

    expect(hashBoundary).toHaveBeenCalledTimes(1)
    expect((await nativeFs.stat(source)).mode & 0o7777).toBe(0o600)
    expect((await nativeFs.stat(directory)).mode & 0o7777).toBe(0o700)
    await expect(store.readManagedFile(receipt.path, CALLER)).resolves.toEqual(bytes)
  })

  it('F23c: an fsGroup-expanded source whose content changed is not restored or served', async () => {
    const { receipt } = await completedCopy(store, callerRoot, CALLER, 125, 20)
    const directory = downloadDirectory(callerRoot, receipt.id)
    const source = path.join(directory, 'source')
    await nativeFs.writeFile(source, Buffer.alloc(20, 0xcd))
    await nativeFs.chmod(source, 0o660)
    hashBoundary.mockClear()

    await expect(store.readManagedFilePrefix(receipt.path, CALLER, 8)).rejects.toMatchObject({
      code: 'download_missing',
    })

    // Witness: the content was hashed, and the mismatch kept the group mode.
    expect(hashBoundary).toHaveBeenCalledTimes(1)
    expect((await nativeFs.stat(source)).mode & 0o7777).toBe(0o660)

    // Reuse reaches the same check and removes the copy.
    const removed = await expiryCount('incomplete_removed')
    await expect(store.reusableReceipt(CALLER, sourceFor(125), 20)).resolves.toBeUndefined()
    expect(await exists(directory)).toBe(false)
    expect(await expiryCount('incomplete_removed')).toBe(removed + 1)
  })
})

describe('GFS download store: pins, lifecycle and errors', () => {
  it('F24: releaseReceiptOwner unpins only its own caller and a second store on the same root sees no pins', async () => {
    const pinned = await completedCopy(store, callerRoot, CALLER, 130, 8, { owner: 'task-130' })
    const rootB = await callerDirectory(hostRoot, 'caller-b')
    // The same owner id under another caller is another pin, not a refusal.
    const other = await completedCopy(store, rootB, 'caller-b', 131, 8, { owner: 'task-130' })
    const later = Date.now() + 2 * 60 * 60_000
    await expect(store.releaseReceiptOwner('unknown-owner', CALLER)).resolves.toBeUndefined()
    await expect(store.releaseReceiptOwner('task-130', 'caller-b')).resolves.toBeUndefined()
    // Witness: caller-b's release freed only caller-b's copy; CALLER's pin holds.
    await expect(store.cleanupExpired(later)).resolves.toMatchObject({ removedExpired: 1 })
    expect(await exists(downloadDirectory(rootB, other.receipt.id))).toBe(false)
    expect(await exists(downloadDirectory(callerRoot, pinned.receipt.id))).toBe(true)

    await store.close()
    const second = await openStore(hostRoot)
    await expect(second.cleanupExpired(later)).resolves.toMatchObject({ removedExpired: 1 })
    expect(await exists(downloadDirectory(callerRoot, pinned.receipt.id))).toBe(false)
  })

  it('F25: close drains active transfers and refuses new admissions', async () => {
    const { transfer, bytes } = await startTransfer(store, callerRoot, CALLER, 140, 8)
    let closed = false
    const closing = store.close().then(() => {
      closed = true
    })
    await expect(
      startTransfer(store, await callerDirectory(hostRoot, 'caller-b'), 'caller-b', 141, 8)
    ).rejects.toMatchObject({ code: 'download_busy' })
    expect(store.isAvailable()).toBe(false)
    expect(closed).toBe(false)

    const receipt = await store.publish(transfer.id, CALLER, digest(bytes))
    await closing
    expect(closed).toBe(true)
    expect(receipt.id).toBe(transfer.id)
    await expect(store.initialize()).rejects.toMatchObject({ code: 'download_busy' })
  })

  it('F25b: close with an active transfer that never finishes resolves within the deadline', async () => {
    const { transfer, bytes } = await startTransfer(store, callerRoot, CALLER, 150, 8)
    const warn = vi.spyOn(logger, 'warn')
    const started = performance.now()

    await store.close(50)

    expect(performance.now() - started).toBeLessThan(2_000)
    // Witness: the store reports the transfer it left behind.
    expect(warn).toHaveBeenCalledWith(
      { component: 'GfsDownloadStore', active: 1 },
      expect.stringContaining('closed with active transfers')
    )
    await expect(store.publish(transfer.id, CALLER, digest(bytes))).rejects.toMatchObject({
      code: 'download_busy',
    })
    await expect(store.fail(transfer.id, CALLER)).rejects.toMatchObject({ code: 'download_busy' })
    await expect(store.close()).resolves.toBeUndefined()
  })

  it('F26: error codes for an uninitialized, a closed and an unknown transfer', async () => {
    const uninitialized = new GfsDownloadStore(hostRoot)
    const probe = `.gfs-downloads/input-${nativeCrypto.randomUUID()}/source`
    await expect(uninitialized.readManagedFile(probe, CALLER)).rejects.toMatchObject({
      code: 'workspace_unavailable',
    })
    await expect(
      uninitialized.createTransfer({
        callerIdentity: CALLER,
        callerWorkspacePath: callerRoot,
        source: sourceFor(160),
        sizeBytes: 1,
        expiresAt: future(),
      })
    ).rejects.toMatchObject({ code: 'workspace_unavailable' })
    await expect(uninitialized.close()).resolves.toBeUndefined()
    await expect(uninitialized.initialize()).rejects.toMatchObject({ code: 'download_busy' })

    const { transfer } = await startTransfer(store, callerRoot, CALLER, 161, 4)
    // Another caller's transfer is answered exactly like an unknown id.
    await expect(store.fail(transfer.id, 'caller-b')).rejects.toMatchObject({
      code: 'download_busy',
    })
    await expect(store.fail(nativeCrypto.randomUUID(), CALLER)).rejects.toMatchObject({
      code: 'download_busy',
    })
    await expect(
      store.publish(nativeCrypto.randomUUID(), CALLER, 'a'.repeat(64))
    ).rejects.toMatchObject({ code: 'download_missing' })
    await expect(store.publish(transfer.id, CALLER, 'not-a-digest')).rejects.toThrow(RangeError)
    // Witness: the transfer is live and the caller's fail() removes it.
    await store.fail(transfer.id, CALLER)
    expect(await exists(downloadDirectory(callerRoot, transfer.id))).toBe(false)

    await store.close()
    await expect(store.readManagedFile(probe, CALLER)).rejects.toMatchObject({
      code: 'download_busy',
    })
    await expect(store.close()).resolves.toBeUndefined()
  })

  it('F27: a Host root that is a symlink makes initialize reject with workspace_unavailable', async () => {
    const real = path.join(hostRoot, 'real-store')
    await nativeFs.mkdir(real, { mode: 0o700 })
    const link = path.join(hostRoot, 'store-link')
    await nativeFs.symlink(real, link)
    const linked = new GfsDownloadStore(link)
    extraStores.push(linked)

    await expect(linked.initialize()).rejects.toBeInstanceOf(GfsDownloadStoreError)
    await expect(linked.initialize()).rejects.toMatchObject({ code: 'workspace_unavailable' })
    expect(linked.isAvailable()).toBe(false)
    // Witness: the same directory through its real path initializes.
    await expect(openStore(real)).resolves.toBeInstanceOf(GfsDownloadStore)
  })
})

// Kill tests for mutations the adversarial review of PR #1028 found surviving
// (S08, S10, S11, S12, S13, S22, S24), adapted from its verified repros.
describe('GFS download store: adversarial review kill tests', () => {
  it('ADV-S08: an infeasible eviction plan deletes nothing even when some copies are evictable', async () => {
    volumeOf(15)
    const { limited } = await limitedStore(SMALL_FILES_FULL_VOLUME)
    const loose = await completedCopy(limited, callerRoot, CALLER, 70, 5)
    tick()
    await completedCopy(limited, callerRoot, CALLER, 71, 8, { owner: 'task-1' })
    const denied = await quotaCount('host', 'storage_bytes')
    await expect(startTransfer(limited, callerRoot, CALLER, 72, 10)).rejects.toMatchObject({
      code: 'host_quota_exceeded',
    })
    // Witness: the admission reached the quota decision.
    expect(await quotaCount('host', 'storage_bytes')).toBe(denied + 1)
    // The unpinned copy could not make room on its own, so it must survive.
    expect(await exists(downloadDirectory(callerRoot, loose.receipt.id))).toBe(true)
    // Witness: once the pin is released the same admission evicts and succeeds.
    await limited.releaseReceiptOwner('task-1', CALLER)
    await expect(startTransfer(limited, callerRoot, CALLER, 72, 10)).resolves.toBeDefined()
  })

  it('ADV-S11: publish refuses a digest that does not match the partial bytes', async () => {
    const { transfer } = await startTransfer(store, callerRoot, CALLER, 73, 8)
    hashBoundary.mockClear()
    await expect(
      store.publish(transfer.id, CALLER, digest(Buffer.alloc(8, 0xee)))
    ).rejects.toMatchObject({ code: 'storage_write_failed' })
    // Witness: publication hashed the partial file.
    expect(hashBoundary).toHaveBeenCalled()
    const directory = downloadDirectory(callerRoot, transfer.id)
    expect(await exists(path.join(directory, 'source'))).toBe(false)
    expect(await exists(path.join(directory, 'meta.json'))).toBe(false)
    await store.fail(transfer.id, CALLER)
    expect(await exists(directory)).toBe(false)
  })

  it('ADV-S13: publish refuses a partial file larger than the admitted size', async () => {
    const transfer = await store.createTransfer({
      callerIdentity: CALLER,
      callerWorkspacePath: callerRoot,
      source: sourceFor(74),
      sizeBytes: 5,
      expiresAt: future(),
    })
    const bigger = Buffer.alloc(9, 4)
    await nativeFs.writeFile(path.join(callerRoot, transfer.partialPath), bigger)
    await expect(store.publish(transfer.id, CALLER, digest(bigger))).rejects.toMatchObject({
      code: 'download_missing',
    })
    // Witness: the oversized partial is the one that was offered.
    expect((await nativeFs.stat(path.join(callerRoot, transfer.partialPath))).size).toBe(9)
    expect(await exists(path.join(downloadDirectory(callerRoot, transfer.id), 'source'))).toBe(
      false
    )
  })

  it('ADV-S24: publish refuses a transfer whose expiry passed during the download', async () => {
    const bytes = Buffer.alloc(6, 7)
    const transfer = await store.createTransfer({
      callerIdentity: CALLER,
      callerWorkspacePath: callerRoot,
      source: sourceFor(75),
      sizeBytes: 6,
      expiresAt: future(1_000),
    })
    await nativeFs.writeFile(path.join(callerRoot, transfer.partialPath), bytes)
    vi.setSystemTime(Date.now() + 1_000)
    await expect(store.publish(transfer.id, CALLER, digest(bytes))).rejects.toMatchObject({
      code: 'download_expired',
    })
    // Witness: the transfer is still active, so fail() is accepted and cleans it up.
    await expect(store.fail(transfer.id, CALLER)).resolves.toBeUndefined()
    expect(await exists(downloadDirectory(callerRoot, transfer.id))).toBe(false)
  })

  it('ADV-S22: a caller root that is an alias of another caller directory is refused', async () => {
    const otherRoot = await callerDirectory(hostRoot, 'caller-b')
    const alias = path.join(hostRoot, 'users', 'alias')
    await nativeFs.symlink(otherRoot, alias)
    await expect(
      store.createTransfer({
        callerIdentity: 'alias',
        callerWorkspacePath: alias,
        source: sourceFor(76),
        sizeBytes: 3,
        expiresAt: future(),
      })
    ).rejects.toMatchObject({ code: 'workspace_unavailable' })
    expect(await exists(path.join(otherRoot, '.gfs-downloads'))).toBe(false)
    // Witness: the real directory is accepted.
    await expect(
      store.createTransfer({
        callerIdentity: 'caller-b',
        callerWorkspacePath: otherRoot,
        source: sourceFor(76),
        sizeBytes: 3,
        expiresAt: future(),
      })
    ).resolves.toMatchObject({ sizeBytes: 3 })
  })

  it('ADV-S10: a source.partial swapped after meta.json is renamed is not published', async () => {
    const { transfer, bytes } = await startTransfer(store, callerRoot, CALLER, 77, 8)
    const partial = path.join(callerRoot, transfer.partialPath)
    let swapped = false
    renameBoundary.mockImplementation(async (from: string, to: string) => {
      await nativeFs.rename(from, to)
      if (to.endsWith(path.sep + 'meta.json') && !swapped) {
        swapped = true
        await nativeFs.writeFile(partial + '.swap', Buffer.alloc(8, 0x55), { mode: 0o600 })
        await nativeFs.rename(partial + '.swap', partial)
      }
    })
    await expect(store.publish(transfer.id, CALLER, digest(bytes))).rejects.toMatchObject({
      code: 'storage_write_failed',
    })
    // Witness: the swap happened inside the publication.
    expect(swapped).toBe(true)
    await expect(store.readManagedFile(transfer.path, CALLER)).rejects.toMatchObject({
      code: 'download_missing',
    })
  })

  it('ADV-S12: a source.partial swapped after hashing is refused before meta.json is written', async () => {
    const { transfer, bytes } = await startTransfer(store, callerRoot, CALLER, 78, 8)
    let swapped = false
    lstatBoundary.mockImplementation(async (target: string, options?: unknown) => {
      // The store addresses the partial through the real path of the Host root.
      const partial = target
      if (target.endsWith(path.sep + 'source.partial') && options === undefined && !swapped) {
        swapped = true
        await nativeFs.writeFile(partial + '.swap', Buffer.alloc(8, 0x66), { mode: 0o600 })
        await nativeFs.rename(partial + '.swap', partial)
      }
      return nativeFs.lstat(target, options as never)
    })
    await expect(store.publish(transfer.id, CALLER, digest(bytes))).rejects.toMatchObject({
      code: 'download_missing',
    })
    expect(swapped).toBe(true)
    expect(await exists(path.join(downloadDirectory(callerRoot, transfer.id), 'meta.json'))).toBe(
      false
    )
  })
})
