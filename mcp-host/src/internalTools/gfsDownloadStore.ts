import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { logger } from '../logger'
import type { GfsImageSource } from '../visualInput/policy'
import { RETIRED_GFS_DOWNLOAD_STORE_PREFIX } from '../workspace/protectedPaths'
import { recordGfsDownloadExpiry, recordGfsDownloadQuota } from './gfsDownloadMetrics'
import {
  GFS_FILE_LIMITS,
  GFS_HOST_ACTIVE_DOWNLOADS,
  GFS_HOST_RETAINED_FILES,
} from './gfsFilePolicy'
import { openPrivateStoreObject, verifyPrivateStoreDirectory } from './gfsStorePrivateFiles'

const GFS_DOWNLOAD_STORE_LOG_COMPONENT = 'GfsDownloadStore'

/** Caller-root directory that holds every download of that caller. */
const DOWNLOADS_DIRECTORY = '.gfs-downloads'
const META_FILE = 'meta.json'
const SOURCE_FILE = 'source'
const PARTIAL_FILE = 'source.partial'
const META_MAX_BYTES = 64 * 1024
const FREE_SPACE_RESERVE_BYTES = 16n * 1024n * 1024n
/** Host-root directory of the ledger store written before #1028; never read. */
const LEGACY_STORE_DIRECTORY = '.gfs-download-store'

const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
/** The only directory names under `.gfs-downloads` that belong to the store. */
export const GFS_INPUT_DIRECTORY_RE = new RegExp(`^input-(${UUID_PATTERN})$`)
/** A directory renamed out of the way before removal; swept if a removal stops. */
const TRASH_PREFIX = '.trash-'
const TRASH_DIRECTORY_RE = new RegExp(`^\\.trash-${UUID_PATTERN}$`)
/** Host-root names the retirement of the pre-#1028 store gives the old tree. */
const RETIRED_DIRECTORY_RE = new RegExp(
  `^${RETIRED_GFS_DOWNLOAD_STORE_PREFIX.replaceAll('.', '\\.')}${UUID_PATTERN}$`
)
/** Caller-relative receipt path; the same contract gfsFilePreparation enforces. */
const RECEIPT_PATH_RE = new RegExp(`^\\.gfs-downloads/input-(${UUID_PATTERN})/source$`)
const SHA256_RE = /^[0-9a-f]{64}$/

export type GfsDownloadStoreErrorCode =
  | 'caller_mismatch'
  | 'caller_quota_exceeded'
  | 'download_busy'
  | 'download_expired'
  | 'download_missing'
  | 'host_quota_exceeded'
  | 'publication_cancelled'
  | 'storage_write_failed'
  | 'workspace_unavailable'

export class GfsDownloadStoreError extends Error {
  constructor(readonly code: GfsDownloadStoreErrorCode) {
    super(`GFS download store failed (${code})`)
    this.name = 'GfsDownloadStoreError'
  }
}

export interface GfsDownloadTransfer {
  id: string
  path: string
  partialPath: string
  sizeBytes: number
  expiresAt: string
}

export interface GfsDownloadReceipt {
  id: string
  source: GfsImageSource
  path: string
  sizeBytes: number
  sha256: string
  expiresAt: string
}

/** Serialized receipt written to `meta.json`; the store writes nothing else. */
interface StoredMeta {
  schemaVersion: 1
  id: string
  callerIdentity: string
  source: GfsImageSource
  sizeBytes: number
  sha256: string
  createdAt: string
  expiresAt: string
}

/**
 * A complete download: `meta.json` parses and `source` has the recorded size.
 * Provenance lives only in memory. A `published` entry was written by this
 * process, so its caller identity and sha256 are trusted. An `adopted` entry
 * was found on disk (left by an earlier process or planted by a shell command
 * running with the Host UID): it counts against the quota of the directory
 * that contains it and is swept, but it is never reused, read or pinned.
 */
/** dev/ino of an inode, compared against an open descriptor or a later lstat. */
interface InodeIdentity {
  dev: bigint
  ino: bigint
}

function sameInode(left: InodeIdentity, right: InodeIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

interface Entry extends StoredMeta {
  /** Absolute `<callerRoot>/.gfs-downloads/input-<id>` directory. */
  directory: string
  /**
   * The `source` inode this process published. Reads and reuse serve only a
   * descriptor whose inode is this one; adopted entries have none and are
   * never served.
   */
  sourceIdentity?: InodeIdentity
  /** `<hostRoot>/users/<key>` containing the entry: the owner for quota and inventory. */
  callerRoot: string
  provenance: 'published' | 'adopted'
  /** Last publish, reuse or managed read in this process; adopted entries use createdAt. */
  lastUsedMs: number
}

/** A reservation held in memory between createTransfer and publish/fail. */
interface ActiveTransfer {
  id: string
  callerIdentity: string
  callerRoot: string
  source: GfsImageSource
  directory: string
  /** The input directory created at admission; publication writes only into it. */
  directoryIdentity?: InodeIdentity
  sizeBytes: number
  createdAt: string
  expiresAt: string
}

export interface GfsDownloadSweepResult {
  removedExpired: number
  removedIncomplete: number
  removeFailed: number
}

interface SweepTotals extends GfsDownloadSweepResult {
  retainedCompleted: number
  retainedBytes: number
  /** Retained entries this process did not publish. */
  adopted: number
  /** This sweep renamed the pre-#1028 store out of the way. */
  retiredLegacyStore: boolean
}

export interface GfsDownloadInventory {
  bytes: number
  files: number
  /** Keyed by the caller directory name (`users/<key>`), never by a recorded identity. */
  byCaller: Map<string, { bytes: number; files: number }>
}

type DirectoryState =
  | { state: 'absent' }
  | { state: 'incomplete' }
  | { state: 'complete'; entry: Entry }

function isValidSource(value: unknown): value is GfsImageSource {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const source = value as Record<string, unknown>
  return (
    source.kind === 'gfs' &&
    typeof source.drive === 'string' &&
    typeof source.resourceId === 'string' &&
    typeof source.gfsUri === 'string' &&
    typeof source.name === 'string' &&
    Number.isSafeInteger(source.version) &&
    (source.version as number) >= 0 &&
    (source.attachmentId === undefined || typeof source.attachmentId === 'string') &&
    (source.toolCallId === undefined || typeof source.toolCallId === 'string')
  )
}

/** A recorded createdAt may lead this clock by at most this much (clock skew between Pods). */
const CREATED_AT_MAX_LEAD_MS = 60_000

/**
 * Returns undefined for anything that is not a schema-1 receipt for
 * `expectedId`. The time bounds keep a planted meta.json from outliving the
 * retention window: no complete entry can expire later than
 * `now + CREATED_AT_MAX_LEAD_MS + retentionMs`.
 */
function parseMeta(raw: string, expectedId: string, now: number): StoredMeta | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const meta = parsed as Record<string, unknown>
  const createdAt = typeof meta.createdAt === 'string' ? Date.parse(meta.createdAt) : NaN
  const expiresAt = typeof meta.expiresAt === 'string' ? Date.parse(meta.expiresAt) : NaN
  if (
    meta.schemaVersion !== 1 ||
    meta.id !== expectedId ||
    typeof meta.callerIdentity !== 'string' ||
    meta.callerIdentity.length === 0 ||
    !isValidSource(meta.source) ||
    !Number.isSafeInteger(meta.sizeBytes) ||
    (meta.sizeBytes as number) < 0 ||
    (meta.sizeBytes as number) > GFS_FILE_LIMITS.maxFileBytes ||
    typeof meta.sha256 !== 'string' ||
    !SHA256_RE.test(meta.sha256) ||
    !Number.isFinite(createdAt) ||
    !Number.isFinite(expiresAt) ||
    expiresAt < createdAt ||
    expiresAt > createdAt + GFS_FILE_LIMITS.retentionMs ||
    createdAt > now + CREATED_AT_MAX_LEAD_MS
  )
    return undefined
  return meta as unknown as StoredMeta
}

function validReceiptOwnerId(ownerId: string): boolean {
  return (
    typeof ownerId === 'string' &&
    ownerId.length > 0 &&
    ownerId.length <= 256 &&
    !/[\u0000-\u001f\u007f]/.test(ownerId) &&
    !['__proto__', 'constructor', 'prototype'].includes(ownerId)
  )
}

function isWithinDirectory(child: string, parent: string): boolean {
  const relative = path.relative(parent, child)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code
  return typeof code === 'string' ? code : 'unknown'
}

/** A removal is proven by ENOENT, not by `fs.rm` returning. */
async function assertAbsent(target: string): Promise<void> {
  try {
    await fs.lstat(target)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return
    throw error
  }
  throw new GfsDownloadStoreError('storage_write_failed')
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function sha256FileHandle(handle: fs.FileHandle, assertActive?: () => void): Promise<string> {
  const digest = createHash('sha256')
  const chunk = Buffer.alloc(64 * 1024)
  let position = 0
  for (;;) {
    assertActive?.()
    const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, position)
    if (bytesRead === 0) break
    digest.update(chunk.subarray(0, bytesRead))
    position += bytesRead
  }
  assertActive?.()
  return digest.digest('hex')
}

/**
 * Regular files and their bytes under a directory, for the retirement log
 * only. Nothing is opened and no symlink is followed: entries are classified
 * by their own lstat type.
 */
async function treeUsage(root: string): Promise<{ files: number; bytes: number }> {
  const usage = { files: 0, bytes: 0 }
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.pop()!
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name)
      if (entry.isDirectory()) pending.push(child)
      else if (entry.isFile()) {
        usage.files += 1
        usage.bytes += (await fs.lstat(child)).size
      }
    }
  }
  return usage
}

function receiptPath(id: string): string {
  return path.join(DOWNLOADS_DIRECTORY, `input-${id}`, SOURCE_FILE)
}

/** `<callerRoot>/.gfs-downloads/input-<id>` → `<callerRoot>`. */
/** Owner ids are scoped to their caller; the encoding is unambiguous for any strings. */
function pinKey(callerIdentity: string, ownerId: string): string {
  return JSON.stringify([callerIdentity, ownerId])
}

function callerRootOf(directory: string): string {
  return path.dirname(path.dirname(directory))
}

/** Adopted copies go first (oldest recorded first), then published ones least recently used. */
function evictionOrder(left: Entry, right: Entry): number {
  if (left.provenance !== right.provenance) return left.provenance === 'adopted' ? -1 : 1
  return left.lastUsedMs - right.lastUsedMs || left.id.localeCompare(right.id)
}

/**
 * GFS download store whose only state is the directory tree under
 * `users/<caller>/.gfs-downloads`. The filesystem is the truth for existence,
 * quota and cleanup: the in-memory index is rebuilt from disk at startup and
 * re-checked on admission and by every sweep. It is never the truth for who
 * downloaded a copy or for its hash: reuse and managed reads serve only copies
 * this process published. Active transfers and retention pins live in memory.
 */
export class GfsDownloadStore {
  private hostRoot: string
  private readonly requestedHostRoot: string
  private readonly entries = new Map<string, Entry>()
  private readonly active = new Map<string, ActiveTransfer>()
  private readonly activeByCaller = new Map<string, number>()
  /** Keyed by `pinKey(callerIdentity, ownerId)`: callers never share or see a pin. */
  private readonly pins = new Map<string, Set<string>>()
  private mutationTail: Promise<void> = Promise.resolve()
  private drainWaiters: Array<() => void> = []
  private initializing?: Promise<void>
  private initialized = false
  private closing = false
  private closed = false

  constructor(hostRoot: string) {
    this.hostRoot = path.resolve(hostRoot)
    this.requestedHostRoot = this.hostRoot
  }

  isAvailable(): boolean {
    return this.initialized && !this.closing && !this.closed
  }

  /**
   * Rejects only when the Host root itself is unusable (workspace_unavailable)
   * or the store was closed (download_busy). Leftover download directories
   * are removed or adopted; none of them can make initialize fail.
   */
  async initialize(): Promise<void> {
    if (this.closed || this.closing) throw new GfsDownloadStoreError('download_busy')
    if (this.initialized) return
    this.initializing ??= this.runInitialize().finally(() => {
      this.initializing = undefined
    })
    return this.initializing
  }

  private async runInitialize(): Promise<void> {
    try {
      await fs.mkdir(this.requestedHostRoot, { recursive: true, mode: 0o700 })
      const requested = await fs.lstat(this.requestedHostRoot)
      if (!requested.isDirectory() || requested.isSymbolicLink())
        throw new GfsDownloadStoreError('workspace_unavailable')
      this.hostRoot = await fs.realpath(this.requestedHostRoot)
      const resolved = await fs.lstat(this.hostRoot)
      if (!resolved.isDirectory() || resolved.isSymbolicLink())
        throw new GfsDownloadStoreError('workspace_unavailable')
    } catch (error) {
      if (error instanceof GfsDownloadStoreError) throw error
      throw new GfsDownloadStoreError('workspace_unavailable')
    }
    const totals = await this.serialize(() => this.sweep(Date.now()))
    if (this.closed || this.closing) throw new GfsDownloadStoreError('download_busy')
    this.initialized = true
    logger.info(
      {
        component: GFS_DOWNLOAD_STORE_LOG_COMPONENT,
        removedIncomplete: totals.removedIncomplete,
        removedExpired: totals.removedExpired,
        retainedCompleted: totals.retainedCompleted,
        retainedBytes: totals.retainedBytes,
        adopted: totals.adopted,
        retiredLegacyStore: totals.retiredLegacyStore,
      },
      'GFS download store initialized'
    )
  }

  async createTransfer(input: {
    callerIdentity: string
    callerWorkspacePath: string
    source: GfsImageSource
    sizeBytes: number
    expiresAt: string
    /** Task lifetime protection; release only after every physical consumer has settled. */
    retentionOwnerId?: string
  }): Promise<GfsDownloadTransfer> {
    this.assertAdmitting()
    if (
      !Number.isSafeInteger(input.sizeBytes) ||
      input.sizeBytes < 0 ||
      input.sizeBytes > GFS_FILE_LIMITS.maxFileBytes
    )
      throw new GfsDownloadStoreError('host_quota_exceeded')
    if (typeof input.callerIdentity !== 'string' || input.callerIdentity.length === 0)
      throw new GfsDownloadStoreError('caller_mismatch')
    if (!isValidSource(input.source)) throw new RangeError('GFS download source is malformed')
    const createdAtMs = Date.now()
    const expiresAtMs = Date.parse(input.expiresAt)
    if (!Number.isFinite(expiresAtMs) || expiresAtMs < createdAtMs)
      throw new RangeError('GFS download expiry must be a future ISO timestamp')
    // The same bound parseMeta applies, so a published copy stays valid on disk.
    if (expiresAtMs > createdAtMs + GFS_FILE_LIMITS.retentionMs)
      throw new RangeError('GFS download expiry must be within the retention window')
    if (input.retentionOwnerId !== undefined) this.assertReceiptOwner(input.retentionOwnerId)
    const callerRoot = await this.validateCallerRoot(input.callerWorkspacePath)
    const id = randomUUID()
    const downloadsRoot = path.join(callerRoot, DOWNLOADS_DIRECTORY)
    const directory = path.join(downloadsRoot, `input-${id}`)
    const transfer: ActiveTransfer = {
      id,
      callerIdentity: input.callerIdentity,
      callerRoot,
      source: input.source,
      directory,
      sizeBytes: input.sizeBytes,
      createdAt: new Date(createdAtMs).toISOString(),
      expiresAt: input.expiresAt,
    }

    await this.serialize(async () => {
      this.assertAdmitting()
      if (this.active.size >= GFS_HOST_ACTIVE_DOWNLOADS) {
        recordGfsDownloadQuota('host', 'active_downloads')
        throw new GfsDownloadStoreError('download_busy')
      }
      if (
        (this.activeByCaller.get(input.callerIdentity) ?? 0) >=
        GFS_FILE_LIMITS.callerActiveDownloads
      ) {
        recordGfsDownloadQuota('caller', 'active_downloads')
        throw new GfsDownloadStoreError('download_busy')
      }
      if (input.retentionOwnerId !== undefined) this.assertReceiptOwner(input.retentionOwnerId)
      // Verified free capacity first: no eviction happens for an admission the
      // volume cannot hold anyway. Measured again after eviction below.
      await this.assertPhysicalCapacity(input.sizeBytes)
      await this.sweep(Date.now())
      await this.reclaimForAdmission(callerRoot, input.sizeBytes)
      const denial = this.quotaDenial(callerRoot, input.sizeBytes)
      if (denial) {
        recordGfsDownloadQuota(denial.scope, denial.reason)
        throw new GfsDownloadStoreError(
          denial.scope === 'host' ? 'host_quota_exceeded' : 'caller_quota_exceeded'
        )
      }
      await this.assertPhysicalCapacity(input.sizeBytes)

      this.addActive(transfer)
      try {
        await this.ensureDownloadsRoot(downloadsRoot)
        await fs.mkdir(directory, { mode: 0o700 })
        await this.verifyEntryDirectory(directory)
        transfer.directoryIdentity = await fs.lstat(directory, { bigint: true })
        const partial = await fs.open(
          path.join(directory, PARTIAL_FILE),
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600
        )
        await partial.close()
      } catch (error) {
        this.releaseActive(id)
        await this.removeDirectory(directory, 'incomplete_removed')
        if (error instanceof GfsDownloadStoreError) throw error
        throw new GfsDownloadStoreError('storage_write_failed')
      }
      if (input.retentionOwnerId !== undefined)
        this.pin(input.retentionOwnerId, input.callerIdentity, id)
    })

    const callerPath = receiptPath(id)
    return {
      id,
      path: callerPath,
      partialPath: `${callerPath}.partial`,
      sizeBytes: input.sizeBytes,
      expiresAt: input.expiresAt,
    }
  }

  /**
   * Publication order: sync source.partial, write meta.json (tmp + rename),
   * rename source.partial to source, sync the directory. A crash between the
   * renames leaves meta.json without source, which the sweep removes. Any
   * failure leaves the id active so the caller's fail() removes the directory.
   */
  async publish(
    id: string,
    callerIdentity: string,
    sha256: string,
    publication?: { signal?: AbortSignal; deadlineMs?: number }
  ): Promise<GfsDownloadReceipt> {
    this.assertInitialized()
    if (!SHA256_RE.test(sha256)) throw new RangeError('GFS download digest is malformed')
    const transfer = this.active.get(id)
    // Another caller's transfer or copy is answered exactly like an unknown id.
    if (!transfer || transfer.callerIdentity !== callerIdentity)
      throw new GfsDownloadStoreError('download_missing')
    const entry = await this.serialize(async () => {
      // close() may have timed out while this waited: the reservation is gone.
      if (this.closed) throw new GfsDownloadStoreError('download_busy')
      if (this.active.get(id) !== transfer) throw new GfsDownloadStoreError('download_missing')
      if (Date.parse(transfer.expiresAt) <= Date.now())
        throw new GfsDownloadStoreError('download_expired')
      this.assertPublicationOpen(publication)
      let published: Entry
      try {
        published = await this.writePublication(transfer, sha256, publication)
      } catch (error) {
        if (error instanceof GfsDownloadStoreError) throw error
        throw new GfsDownloadStoreError('storage_write_failed')
      }
      // Indexed and released in the same critical section, so no sweep can
      // observe the directory as neither active nor indexed.
      this.entries.set(id, published)
      this.releaseActive(id)
      return published
    })
    return this.receiptFor(entry, entry.source)
  }

  private async writePublication(
    transfer: ActiveTransfer,
    sha256: string,
    publication?: { signal?: AbortSignal; deadlineMs?: number }
  ): Promise<Entry> {
    const partialPath = path.join(transfer.directory, PARTIAL_FILE)
    const sourcePath = path.join(transfer.directory, SOURCE_FILE)
    const metaPath = path.join(transfer.directory, META_FILE)
    // The caller directory may have been replaced by a symlink since admission.
    await this.verifyEntryDirectory(transfer.directory)
    const partial = await openPrivateStoreObject(
      partialPath,
      'file',
      constants.O_RDONLY,
      false
    ).catch(() => {
      throw new GfsDownloadStoreError('download_missing')
    })
    let sourceIdentity: InodeIdentity
    try {
      // A path swapped after the check above resolves to another directory:
      // the input directory must still be the one created at admission.
      await this.assertTransferDirectory(transfer)
      sourceIdentity = await partial.stat({ bigint: true })
      const info = await partial.stat()
      if (!info.isFile() || info.size !== transfer.sizeBytes)
        throw new GfsDownloadStoreError('download_missing')
      const digest = await sha256FileHandle(partial, () => this.assertPublicationOpen(publication))
      if (digest !== sha256) throw new GfsDownloadStoreError('storage_write_failed')
      const named = await fs.lstat(partialPath)
      if (named.isSymbolicLink() || named.dev !== info.dev || named.ino !== info.ino)
        throw new GfsDownloadStoreError('download_missing')
      await partial.chmod(0o600)
      await partial.sync()
    } finally {
      await partial.close()
    }

    const meta: StoredMeta = {
      schemaVersion: 1,
      id: transfer.id,
      callerIdentity: transfer.callerIdentity,
      source: transfer.source,
      sizeBytes: transfer.sizeBytes,
      sha256,
      createdAt: transfer.createdAt,
      expiresAt: transfer.expiresAt,
    }
    const temporary = path.join(transfer.directory, `${META_FILE}.tmp-${randomUUID()}`)
    let temporaryExists = false
    try {
      const handle = await fs.open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      )
      temporaryExists = true
      try {
        await handle.writeFile(JSON.stringify(meta), 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      this.assertPublicationOpen(publication)
      await this.assertTransferDirectory(transfer)
      await fs.rename(temporary, metaPath)
      temporaryExists = false
    } finally {
      // Runs only while a publication error is propagating; that error is the
      // one the caller sees. A leftover temporary file goes with the directory
      // when the caller's fail() or the sweep removes it.
      if (temporaryExists)
        await fs.rm(temporary, { force: true }).catch((error: unknown) => {
          logger.warn(
            { component: GFS_DOWNLOAD_STORE_LOG_COMPONENT, code: errorCode(error) },
            'GFS download store could not remove a temporary meta.json after a failed publish; the directory removal clears it'
          )
        })
    }
    // The last cancellation point: once source exists the download is complete.
    this.assertPublicationOpen(publication)
    await this.assertTransferDirectory(transfer)
    await fs.rename(partialPath, sourcePath)
    await syncDirectory(transfer.directory)
    // Only the inode that was hashed is published, wherever the name now leads.
    if (!sameInode(await fs.lstat(sourcePath, { bigint: true }), sourceIdentity))
      throw new GfsDownloadStoreError('storage_write_failed')
    return {
      ...meta,
      directory: transfer.directory,
      sourceIdentity: { dev: sourceIdentity.dev, ino: sourceIdentity.ino },
      callerRoot: transfer.callerRoot,
      provenance: 'published',
      lastUsedMs: Date.now(),
    }
  }

  /** The transfer's input directory is still the inode created at admission. */
  private async assertTransferDirectory(transfer: ActiveTransfer): Promise<void> {
    const current = await fs.lstat(transfer.directory, { bigint: true })
    if (
      !transfer.directoryIdentity ||
      !current.isDirectory() ||
      !sameInode(current, transfer.directoryIdentity)
    )
      throw new GfsDownloadStoreError('workspace_unavailable')
  }

  /** Reuse only after the caller has freshly authorized this exact source version. */
  async reusableReceipt(
    callerIdentity: string,
    source: GfsImageSource,
    sizeBytes: number,
    bounds?: { signal?: AbortSignal; deadlineMs?: number; retentionOwnerId?: string }
  ): Promise<GfsDownloadReceipt | undefined> {
    this.assertAdmitting()
    return this.serialize(async () => {
      this.assertAdmitting()
      this.assertPublicationOpen(bounds)
      if (bounds?.retentionOwnerId !== undefined) this.assertReceiptOwner(bounds.retentionOwnerId)
      // Only copies this process published: an adopted meta.json carries an
      // identity and a digest that anyone with the Host UID could have written.
      // A miss is final; the caller downloads the file again.
      const entry = [...this.entries.values()].find(
        candidate =>
          candidate.provenance === 'published' &&
          candidate.callerIdentity === callerIdentity &&
          Date.parse(candidate.expiresAt) > Date.now() &&
          candidate.sizeBytes === sizeBytes &&
          candidate.source.drive === source.drive &&
          candidate.source.resourceId === source.resourceId &&
          candidate.source.version === source.version
      )
      if (!entry) return undefined
      let verified = false
      try {
        const handle = await this.openEntryContent(entry)
        try {
          const info = await handle.stat()
          verified =
            info.isFile() &&
            info.size === sizeBytes &&
            (info.mode & 0o777) === 0o600 &&
            (await sha256FileHandle(handle, () => this.assertPublicationOpen(bounds))) ===
              entry.sha256
        } finally {
          await handle.close()
        }
      } catch (error) {
        if (error instanceof GfsDownloadStoreError && error.code === 'publication_cancelled')
          throw error
        verified = false
      }
      if (!verified) {
        await this.removeEntry(entry, 'incomplete_removed')
        return undefined
      }
      this.assertPublicationOpen(bounds)
      entry.lastUsedMs = Date.now()
      if (bounds?.retentionOwnerId !== undefined)
        this.pin(bounds.retentionOwnerId, callerIdentity, entry.id)
      return this.receiptFor(entry, source)
    })
  }

  /**
   * Called by the producer after a transfer that was not published. The
   * directory is removed and the reservation released; a publish that failed
   * keeps its id active precisely so this call can clean it up.
   */
  async fail(id: string, callerIdentity: string): Promise<void> {
    const transfer = this.active.get(id)
    // Another caller's transfer or copy is answered exactly like an unknown id.
    if (!transfer || transfer.callerIdentity !== callerIdentity)
      throw new GfsDownloadStoreError('download_busy')
    await this.serialize(async () => {
      if (this.closed) throw new GfsDownloadStoreError('download_busy')
      // Publication may have settled while this waited.
      if (this.active.get(id) !== transfer) throw new GfsDownloadStoreError('download_busy')
      this.releaseActive(id)
      this.unpinId(id)
      if (!(await this.removeDirectory(transfer.directory, 'incomplete_removed')))
        throw new GfsDownloadStoreError('storage_write_failed')
    })
  }

  async readManagedFile(callerRelativePath: string, callerIdentity: string): Promise<Buffer> {
    const entry = this.managedEntry(callerRelativePath, callerIdentity)
    let bytes: Buffer
    try {
      const handle = await this.openEntryContent(entry)
      try {
        const info = await handle.stat()
        if (!info.isFile() || info.size !== entry.sizeBytes || (info.mode & 0o777) !== 0o600)
          throw new GfsDownloadStoreError('download_missing')
        bytes = Buffer.alloc(entry.sizeBytes)
        let offset = 0
        while (offset < entry.sizeBytes) {
          const { bytesRead } = await handle.read(bytes, offset, entry.sizeBytes - offset, offset)
          if (bytesRead <= 0) throw new GfsDownloadStoreError('download_missing')
          offset += bytesRead
        }
        const probe = Buffer.alloc(1)
        const extra = await handle.read(probe, 0, 1, entry.sizeBytes)
        if (extra.bytesRead !== 0) throw new GfsDownloadStoreError('download_missing')
      } finally {
        await handle.close()
      }
    } catch {
      throw new GfsDownloadStoreError('download_missing')
    }
    if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
      // A copy whose bytes no longer match its receipt is not a cache entry.
      await this.serialize(() => this.removeEntry(entry, 'incomplete_removed'))
      throw new GfsDownloadStoreError('download_missing')
    }
    return bytes
  }

  async readManagedFilePrefix(
    callerRelativePath: string,
    callerIdentity: string,
    prefixBytes = 16
  ): Promise<Buffer> {
    this.assertReadable()
    if (!Number.isSafeInteger(prefixBytes) || prefixBytes <= 0 || prefixBytes > 4096)
      throw new RangeError('GFS managed-file prefix must be between 1 and 4096 bytes')
    const entry = this.managedEntry(callerRelativePath, callerIdentity)
    try {
      const handle = await this.openEntryContent(entry)
      try {
        const info = await handle.stat()
        if (!info.isFile() || info.size !== entry.sizeBytes || (info.mode & 0o777) !== 0o600)
          throw new GfsDownloadStoreError('download_missing')
        const prefix = Buffer.alloc(prefixBytes)
        const { bytesRead } = await handle.read(prefix, 0, prefix.byteLength, 0)
        return prefix.subarray(0, bytesRead)
      } finally {
        await handle.close()
      }
    } catch {
      throw new GfsDownloadStoreError('download_missing')
    }
  }

  /**
   * Caller/task lifecycle must prove consumer settlement before invoking this.
   * Releases only the caller's own pin; an owner id another caller uses is a
   * different pin, so the call is the same no-op as for an unknown owner.
   */
  async releaseReceiptOwner(ownerId: string, callerIdentity: string): Promise<void> {
    this.assertReadable()
    await this.serialize(async () => {
      this.pins.delete(pinKey(callerIdentity, ownerId))
    })
  }

  /** Removes expired and incomplete downloads; startup runs the same sweep. */
  async cleanupExpired(now = Date.now()): Promise<GfsDownloadSweepResult> {
    this.assertReadable()
    try {
      const totals = await this.serialize(() => this.sweep(now))
      return {
        removedExpired: totals.removedExpired,
        removedIncomplete: totals.removedIncomplete,
        removeFailed: totals.removeFailed,
      }
    } catch (error) {
      recordGfsDownloadExpiry('sweep_failed')
      throw error
    }
  }

  /**
   * Stops admitting, waits for active transfers until the deadline and then
   * closes regardless. Transfers still active afterwards get download_busy
   * from publish/fail; their directories are removed by the next start.
   */
  async close(drainTimeoutMs = 5_000): Promise<void> {
    if (this.closed || this.closing) return
    if (!this.initialized) {
      this.closed = true
      return
    }
    this.closing = true
    let timer: NodeJS.Timeout | undefined
    const deadline = new Promise<void>(resolve => {
      timer = setTimeout(resolve, drainTimeoutMs)
    })
    const drained = new Promise<void>(resolve => {
      if (this.active.size === 0) resolve()
      else this.drainWaiters.push(resolve)
    })
    // Active transfers first, then whatever mutation is still in flight; both
    // bounded by the same deadline.
    await Promise.race([drained.then(() => this.mutationTail), deadline])
    clearTimeout(timer)
    if (this.active.size > 0)
      logger.warn(
        { component: GFS_DOWNLOAD_STORE_LOG_COMPONENT, active: this.active.size },
        'GFS download store closed with active transfers; their directories are removed at the next start'
      )
    this.closed = true
    this.closing = false
  }

  /** Test-only: complete downloads on disk plus in-memory reservations. Read-only. */
  async debugInventory(): Promise<GfsDownloadInventory> {
    const inventory: GfsDownloadInventory = { bytes: 0, files: 0, byCaller: new Map() }
    const add = (callerRoot: string, sizeBytes: number) => {
      const key = path.basename(callerRoot)
      inventory.bytes += sizeBytes
      inventory.files += 1
      const caller = inventory.byCaller.get(key) ?? { bytes: 0, files: 0 }
      caller.bytes += sizeBytes
      caller.files += 1
      inventory.byCaller.set(key, caller)
    }
    const now = Date.now()
    for (const { id, directory } of await this.listInputDirectories()) {
      if (this.active.get(id)?.directory === directory) continue
      const state = await this.inspectDirectory(directory, id, now)
      if (state.state === 'complete') add(state.entry.callerRoot, state.entry.sizeBytes)
    }
    for (const transfer of this.active.values()) add(transfer.callerRoot, transfer.sizeBytes)
    return inventory
  }

  /**
   * Walks `users/*\/.gfs-downloads/*` plus every indexed directory. Incomplete
   * directories and expired, unpinned complete ones are removed; complete ones
   * are (re)indexed, new ones as adopted. Active transfers of this process are
   * never touched, and a published entry is never replaced: another directory
   * carrying the id of a reservation or of a published copy is removed, and an
   * id found in several directories with neither is removed everywhere (a
   * random uuid does not repeat by chance). Every sweep first retires the
   * pre-#1028 store if one is present.
   */
  private async sweep(now: number): Promise<SweepTotals> {
    const totals: SweepTotals = {
      removedExpired: 0,
      removedIncomplete: 0,
      removeFailed: 0,
      retainedCompleted: 0,
      retainedBytes: 0,
      adopted: 0,
      retiredLegacyStore: false,
    }
    await this.retireLegacyStore(totals)
    const candidates = new Map<string, string[]>()
    const addCandidate = (id: string, directory: string) => {
      const directories = candidates.get(id) ?? []
      if (!directories.includes(directory)) directories.push(directory)
      candidates.set(id, directories)
    }
    for (const { id, directory } of await this.listInputDirectories(totals))
      addCandidate(id, directory)
    for (const entry of this.entries.values()) addCandidate(entry.id, entry.directory)
    const removeIncomplete = async (directory: string) => {
      if (await this.removeDirectory(directory, 'incomplete_removed')) totals.removedIncomplete += 1
      else totals.removeFailed += 1
    }

    for (const [id, directories] of candidates) {
      const indexed = this.entries.get(id)
      const owned =
        this.active.get(id)?.directory ??
        (indexed?.provenance === 'published' ? indexed.directory : undefined)
      if (owned === undefined && directories.length > 1) {
        this.forget(id)
        for (const duplicate of directories) await removeIncomplete(duplicate)
        continue
      }
      if (owned !== undefined)
        for (const duplicate of directories)
          if (duplicate !== owned) await removeIncomplete(duplicate)
      if (this.active.has(id)) continue
      const directory = owned ?? directories[0]!
      const state =
        indexed && indexed.directory === directory
          ? await this.recheckIndexed(indexed)
          : await this.inspectDirectory(directory, id, now)
      if (state.state === 'absent') {
        this.forget(id)
        continue
      }
      if (state.state === 'incomplete') {
        this.forget(id)
        await removeIncomplete(directory)
        continue
      }
      const entry = state.entry
      if (Date.parse(entry.expiresAt) <= now && !this.isPinned(id)) {
        this.forget(id)
        if (await this.removeDirectory(directory, 'expired_removed')) totals.removedExpired += 1
        else totals.removeFailed += 1
        continue
      }
      this.entries.set(id, entry)
      totals.retainedCompleted += 1
      totals.retainedBytes += entry.sizeBytes
      if (entry.provenance === 'adopted') totals.adopted += 1
    }
    return totals
  }

  /**
   * Retires the ledger store of the pre-#1028 image, at startup and in every
   * sweep: `.gfs-download-store` is renamed to
   * `.gfs-download-store.retired-<uuid>` inside the Host root, then every
   * retired tree is removed the way any store directory is (renamed to a new
   * private name, the parent checked again, removed). Nothing inside is read;
   * the warning carries only file and byte counts. A failed step is logged
   * with its code and step and counted, and never fails the sweep: leftover
   * state can cost disk space, never availability. A retired tree a failed
   * removal left is protected from workspace tools and retried by the next
   * sweep.
   */
  private async retireLegacyStore(totals: SweepTotals): Promise<void> {
    const failed = (step: 'inspect' | 'rename' | 'list' | 'remove', error: unknown) => {
      totals.removeFailed += 1
      recordGfsDownloadExpiry('remove_failed')
      logger.warn(
        { component: GFS_DOWNLOAD_STORE_LOG_COMPONENT, code: errorCode(error), step },
        'GFS download store could not retire the pre-#1028 store; the next sweep retries it'
      )
    }
    const legacy = path.join(this.hostRoot, LEGACY_STORE_DIRECTORY)
    let info: import('node:fs').Stats | undefined
    try {
      info = await fs.lstat(legacy)
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') failed('inspect', error)
    }
    if (info) {
      let usage: { files: number; bytes: number } | undefined
      try {
        usage = info.isDirectory()
          ? await treeUsage(legacy)
          : { files: info.isFile() ? 1 : 0, bytes: info.isFile() ? info.size : 0 }
      } catch (error) {
        // The counts only feed the log line; the retirement goes ahead without them.
        logger.warn(
          { component: GFS_DOWNLOAD_STORE_LOG_COMPONENT, code: errorCode(error), step: 'measure' },
          'GFS download store could not measure the pre-#1028 store before retiring it'
        )
      }
      try {
        await this.assertRemovable(legacy)
        await fs.rename(
          legacy,
          path.join(this.hostRoot, `${RETIRED_GFS_DOWNLOAD_STORE_PREFIX}${randomUUID()}`)
        )
        totals.retiredLegacyStore = true
        recordGfsDownloadExpiry('retired_legacy_store')
        logger.warn(
          { component: GFS_DOWNLOAD_STORE_LOG_COMPONENT, ...usage },
          'Retired the pre-#1028 GFS download store'
        )
      } catch (error) {
        failed('rename', error)
      }
    }
    let names: string[]
    try {
      names = await fs.readdir(this.hostRoot)
    } catch (error) {
      failed('list', error)
      return
    }
    for (const name of names) {
      if (!RETIRED_DIRECTORY_RE.test(name)) continue
      try {
        await this.removeVerified(path.join(this.hostRoot, name), RETIRED_GFS_DOWNLOAD_STORE_PREFIX)
      } catch (error) {
        failed('remove', error)
      }
    }
  }

  /**
   * Lists store-owned directories. A `.gfs-downloads` that is a symlink or not
   * a directory is removed without following it; names that do not match
   * `input-<uuid>` are left alone because they are not the store's.
   */
  private async listInputDirectories(
    totals?: SweepTotals
  ): Promise<Array<{ id: string; directory: string }>> {
    const found: Array<{ id: string; directory: string }> = []
    const usersRoot = path.join(this.hostRoot, 'users')
    let users: import('node:fs').Dirent[]
    try {
      const info = await fs.lstat(usersRoot)
      if (!info.isDirectory()) return found
      users = await fs.readdir(usersRoot, { withFileTypes: true })
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return found
      this.reportSweepFailure(error)
      return found
    }
    for (const user of users) {
      if (!user.isDirectory()) continue
      const downloadsRoot = path.join(usersRoot, user.name, DOWNLOADS_DIRECTORY)
      let children: import('node:fs').Dirent[]
      try {
        const info = await fs.lstat(downloadsRoot)
        if (!info.isDirectory()) {
          if (totals) {
            if (await this.removeDirectory(downloadsRoot, 'incomplete_removed'))
              totals.removedIncomplete += 1
            else totals.removeFailed += 1
          }
          continue
        }
        children = await fs.readdir(downloadsRoot, { withFileTypes: true })
      } catch (error) {
        if (errorCode(error) === 'ENOENT') continue
        this.reportSweepFailure(error)
        continue
      }
      for (const child of children) {
        const match = GFS_INPUT_DIRECTORY_RE.exec(child.name)
        if (match) found.push({ id: match[1]!, directory: path.join(downloadsRoot, child.name) })
        else if (totals && TRASH_DIRECTORY_RE.test(child.name)) {
          // Left by a removal that stopped between its rename and its rm.
          if (
            await this.removeDirectory(path.join(downloadsRoot, child.name), 'incomplete_removed')
          )
            totals.removedIncomplete += 1
          else totals.removeFailed += 1
        }
      }
    }
    return found
  }

  /** Reads one directory from disk; a complete result is always `adopted`. */
  private async inspectDirectory(
    directory: string,
    id: string,
    now: number
  ): Promise<DirectoryState> {
    let info: import('node:fs').Stats
    try {
      info = await fs.lstat(directory)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return { state: 'absent' }
      return { state: 'incomplete' }
    }
    if (!info.isDirectory()) return { state: 'incomplete' }
    let raw: string
    try {
      const handle = await fs.open(
        path.join(directory, META_FILE),
        constants.O_RDONLY | constants.O_NOFOLLOW
      )
      try {
        const metaInfo = await handle.stat()
        if (!metaInfo.isFile() || metaInfo.size > META_MAX_BYTES) return { state: 'incomplete' }
        raw = await handle.readFile('utf8')
      } finally {
        await handle.close()
      }
    } catch {
      return { state: 'incomplete' }
    }
    const meta = parseMeta(raw, id, now)
    if (!meta) return { state: 'incomplete' }
    try {
      const source = await fs.lstat(path.join(directory, SOURCE_FILE))
      if (!source.isFile() || source.size !== meta.sizeBytes) return { state: 'incomplete' }
    } catch {
      return { state: 'incomplete' }
    }
    return {
      state: 'complete',
      entry: {
        ...meta,
        directory,
        callerRoot: callerRootOf(directory),
        provenance: 'adopted',
        lastUsedMs: Date.parse(meta.createdAt),
      },
    }
  }

  /** An indexed entry is re-checked with one lstat; meta.json is not re-read. */
  private async recheckIndexed(entry: Entry): Promise<DirectoryState> {
    try {
      const source = await fs.lstat(path.join(entry.directory, SOURCE_FILE))
      if (source.isFile() && source.size === entry.sizeBytes) return { state: 'complete', entry }
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        try {
          await fs.lstat(entry.directory)
        } catch (directoryError) {
          if (errorCode(directoryError) === 'ENOENT') return { state: 'absent' }
        }
      }
    }
    return { state: 'incomplete' }
  }

  /**
   * Index lookup for a managed read. Only a copy this process published for
   * this caller is served. An adopted, unknown or another caller's id is the
   * same download_missing, decided from the index alone: the disk is not
   * probed, because nothing on disk can prove who downloaded a copy, and a
   * foreign copy must cost no more work than a missing one.
   */
  private managedEntry(callerRelativePath: string, callerIdentity: string): Entry {
    this.assertReadable()
    const match = RECEIPT_PATH_RE.exec(callerRelativePath)
    if (!match) throw new GfsDownloadStoreError('download_missing')
    const entry = this.entries.get(match[1]!)
    if (!entry || entry.provenance !== 'published' || entry.callerIdentity !== callerIdentity)
      throw new GfsDownloadStoreError('download_missing')
    if (Date.parse(entry.expiresAt) <= Date.now())
      throw new GfsDownloadStoreError('download_expired')
    entry.lastUsedMs = Date.now()
    return entry
  }

  private async openEntryContent(entry: Entry): Promise<fs.FileHandle> {
    await this.verifyEntryDirectory(entry.directory)
    const handle = await openPrivateStoreObject(
      path.join(entry.directory, SOURCE_FILE),
      'file',
      constants.O_RDONLY,
      false
    )
    try {
      // The descriptor, not the path, decides: a name swapped after the
      // directory check opens another inode and is refused.
      if (
        !entry.sourceIdentity ||
        !sameInode(await handle.stat({ bigint: true }), entry.sourceIdentity)
      )
        throw new GfsDownloadStoreError('download_missing')
      const info = await handle.stat()
      if (info.size !== entry.sizeBytes) throw new GfsDownloadStoreError('download_missing')
      if ((info.mode & 0o7777) !== 0o600) {
        // Restore the private mode only for content that still matches.
        if ((await sha256FileHandle(handle)) !== entry.sha256)
          throw new GfsDownloadStoreError('download_missing')
        await handle.chmod(0o600)
      }
      return handle
    } catch (error) {
      await handle.close()
      throw error
    }
  }

  private async verifyEntryDirectory(directory: string): Promise<void> {
    if (!isWithinDirectory(directory, this.hostRoot))
      throw new GfsDownloadStoreError('workspace_unavailable')
    const callerRoot = path.dirname(path.dirname(directory))
    if ((await fs.realpath(callerRoot)) !== callerRoot)
      throw new GfsDownloadStoreError('workspace_unavailable')
    await verifyPrivateStoreDirectory(path.dirname(directory))
    await verifyPrivateStoreDirectory(directory)
  }

  /**
   * A `.gfs-downloads` that is a symlink, not a directory, or not private to
   * this process is removed without following it and recreated, so a shell
   * command can cost a caller its cached copies but never block its downloads.
   */
  private async ensureDownloadsRoot(downloadsRoot: string): Promise<void> {
    try {
      await fs.mkdir(downloadsRoot, { mode: 0o700 })
      return
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error
    }
    try {
      await verifyPrivateStoreDirectory(downloadsRoot)
      return
    } catch {
      // Not a private directory: replaced below.
    }
    for (const id of this.idsUnder(downloadsRoot)) this.forget(id)
    await this.removeVerified(downloadsRoot)
    await fs.mkdir(downloadsRoot, { mode: 0o700 })
    await verifyPrivateStoreDirectory(downloadsRoot)
  }

  private idsUnder(downloadsRoot: string): string[] {
    return [...this.entries.values()]
      .filter(entry => path.dirname(entry.directory) === downloadsRoot)
      .map(entry => entry.id)
  }

  private async assertPhysicalCapacity(sizeBytes: number): Promise<void> {
    const space = await fs.statfs(this.hostRoot, { bigint: true })
    if (space.bsize <= 0n || space.bavail < 0n) {
      recordGfsDownloadQuota('host', 'free_space')
      throw new GfsDownloadStoreError('host_quota_exceeded')
    }
    const reserve = (bytes: number): bigint => {
      const amount = BigInt(bytes)
      return ((amount + space.bsize - 1n) / space.bsize) * space.bsize
    }
    let required = reserve(sizeBytes) + FREE_SPACE_RESERVE_BYTES
    // Use the full outstanding reservation of every active transfer rather
    // than crediting sparse, shared or concurrently written allocation.
    for (const transfer of this.active.values()) required += reserve(transfer.sizeBytes)
    if (space.bavail * space.bsize < required) {
      recordGfsDownloadQuota('host', 'free_space')
      throw new GfsDownloadStoreError('host_quota_exceeded')
    }
  }

  /** Caller usage is keyed by the caller directory that holds each copy, never by meta.json. */
  private usage(excluded: ReadonlySet<string> = new Set()) {
    const usage = {
      bytes: 0,
      files: 0,
      callerBytes: new Map<string, number>(),
      callerFiles: new Map<string, number>(),
    }
    const add = (callerRoot: string, sizeBytes: number) => {
      usage.bytes += sizeBytes
      usage.files += 1
      usage.callerBytes.set(callerRoot, (usage.callerBytes.get(callerRoot) ?? 0) + sizeBytes)
      usage.callerFiles.set(callerRoot, (usage.callerFiles.get(callerRoot) ?? 0) + 1)
    }
    for (const entry of this.entries.values())
      if (!excluded.has(entry.id)) add(entry.callerRoot, entry.sizeBytes)
    for (const transfer of this.active.values()) add(transfer.callerRoot, transfer.sizeBytes)
    return usage
  }

  private quotaDenial(
    callerRoot: string,
    sizeBytes: number,
    excluded?: ReadonlySet<string>
  ): { scope: 'host' | 'caller'; reason: 'storage_bytes' | 'retained_files' } | undefined {
    const usage = this.usage(excluded)
    // Prove caller admission before considering eviction of another caller.
    if ((usage.callerBytes.get(callerRoot) ?? 0) + sizeBytes > GFS_FILE_LIMITS.callerStorageBytes)
      return { scope: 'caller', reason: 'storage_bytes' }
    if ((usage.callerFiles.get(callerRoot) ?? 0) >= GFS_FILE_LIMITS.callerRetainedFiles)
      return { scope: 'caller', reason: 'retained_files' }
    if (usage.bytes + sizeBytes > GFS_FILE_LIMITS.storageBytes)
      return { scope: 'host', reason: 'storage_bytes' }
    if (usage.files >= GFS_HOST_RETAINED_FILES) return { scope: 'host', reason: 'retained_files' }
    return undefined
  }

  /**
   * Completed, unpinned copies are a cache. The whole eviction plan is computed
   * before anything is deleted: adopted copies first, so files planted in one
   * directory can never cost another caller a copy this process published,
   * then published copies least recently used first. A caller denial evicts
   * only copies in that caller's directory. With no feasible plan nothing is
   * deleted and the admission fails with the quota code; nothing is retained,
   * so the next admission plans again. Candidates are not hashed: a corrupt
   * copy is as good an eviction candidate as a sound one.
   */
  private async reclaimForAdmission(callerRoot: string, sizeBytes: number): Promise<void> {
    if (!this.quotaDenial(callerRoot, sizeBytes)) return
    const candidates = [...this.entries.values()]
      .filter(entry => !this.isPinned(entry.id))
      .sort(evictionOrder)
    const plan = new Set<string>()
    for (;;) {
      const denial = this.quotaDenial(callerRoot, sizeBytes, plan)
      if (!denial) break
      const next = candidates.find(
        entry => !plan.has(entry.id) && (denial.scope === 'host' || entry.callerRoot === callerRoot)
      )
      if (!next) return
      plan.add(next.id)
    }
    for (const id of plan) {
      const entry = this.entries.get(id)
      if (entry) await this.removeEntry(entry, 'expired_removed', false)
    }
  }

  /** Removes an indexed entry's directory and forgets it. */
  private async removeEntry(
    entry: Entry,
    outcome: 'incomplete_removed' | 'expired_removed',
    count = true
  ): Promise<void> {
    this.forget(entry.id)
    await this.removeDirectory(entry.directory, count ? outcome : undefined)
  }

  /**
   * `fs.rm` does not follow the final component, but it resolves every parent
   * component, so a caller directory or `.gfs-downloads` replaced by a symlink
   * after indexing would point the removal outside the Host root. The parent
   * must therefore be its own real path inside the Host root, and the
   * directory must be gone afterwards. A refusal or a failure is logged with
   * its code and counted; the next sweep retries what is still listed.
   */
  private async removeDirectory(
    directory: string,
    outcome: 'incomplete_removed' | 'expired_removed' | undefined
  ): Promise<boolean> {
    try {
      await this.removeVerified(directory)
    } catch (error) {
      recordGfsDownloadExpiry('remove_failed')
      logger.warn(
        { component: GFS_DOWNLOAD_STORE_LOG_COMPONENT, code: errorCode(error) },
        'GFS download store could not remove a download directory; the next sweep retries it'
      )
      return false
    }
    if (outcome) recordGfsDownloadExpiry(outcome)
    return true
  }

  /**
   * Node has no unlinkat/renameat, so the window between a path check and a
   * path-based removal cannot be closed, only narrowed. The entry is first
   * renamed to a store-private name inside its verified parent; the parent is
   * then verified again, and only that private name is removed. When the
   * parent moved in between, the rename is undone and the removal refused,
   * so whatever the swapped path led to keeps its name and content.
   */
  private async removeVerified(directory: string, trashPrefix = TRASH_PREFIX): Promise<void> {
    await this.assertRemovable(directory)
    const trash = path.join(path.dirname(directory), `${trashPrefix}${randomUUID()}`)
    try {
      await fs.rename(directory, trash)
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
      await assertAbsent(directory)
      return
    }
    try {
      await this.assertRemovable(trash)
    } catch (error) {
      await fs.rename(trash, directory)
      throw error
    }
    await fs.rm(trash, { recursive: true, force: true })
    await assertAbsent(trash)
  }

  /**
   * The parent of a directory about to be removed is real and is the Host
   * root (only for the retired pre-#1028 store) or inside it.
   */
  private async assertRemovable(directory: string): Promise<void> {
    const parent = path.dirname(directory)
    if (parent !== this.hostRoot && !isWithinDirectory(parent, this.hostRoot))
      throw new GfsDownloadStoreError('workspace_unavailable')
    let real: string
    try {
      real = await fs.realpath(parent)
    } catch (error) {
      // No parent, nothing to remove: `fs.rm` with `force` is a no-op.
      if (errorCode(error) === 'ENOENT') return
      throw error
    }
    if (real !== parent) throw new GfsDownloadStoreError('workspace_unavailable')
  }

  private reportSweepFailure(error: unknown): void {
    recordGfsDownloadExpiry('sweep_failed')
    logger.warn(
      { component: GFS_DOWNLOAD_STORE_LOG_COMPONENT, code: errorCode(error) },
      'GFS download store could not list a download directory; the next sweep retries it'
    )
  }

  private receiptFor(entry: Entry, source: GfsImageSource): GfsDownloadReceipt {
    return {
      id: entry.id,
      source,
      path: receiptPath(entry.id),
      sizeBytes: entry.sizeBytes,
      sha256: entry.sha256,
      expiresAt: entry.expiresAt,
    }
  }

  /** A malformed owner id is refused; pins are per caller, so no id is taken. */
  private assertReceiptOwner(ownerId: string): void {
    if (!validReceiptOwnerId(ownerId)) throw new GfsDownloadStoreError('caller_mismatch')
  }

  private pin(ownerId: string, callerIdentity: string, id: string): void {
    const key = pinKey(callerIdentity, ownerId)
    const ids = this.pins.get(key) ?? new Set<string>()
    ids.add(id)
    this.pins.set(key, ids)
  }

  private isPinned(id: string): boolean {
    for (const ids of this.pins.values()) if (ids.has(id)) return true
    return false
  }

  private unpinId(id: string): void {
    for (const [key, ids] of this.pins) {
      ids.delete(id)
      if (ids.size === 0) this.pins.delete(key)
    }
  }

  private forget(id: string): void {
    this.entries.delete(id)
    this.unpinId(id)
  }

  private addActive(transfer: ActiveTransfer): void {
    this.active.set(transfer.id, transfer)
    this.activeByCaller.set(
      transfer.callerIdentity,
      (this.activeByCaller.get(transfer.callerIdentity) ?? 0) + 1
    )
  }

  private releaseActive(id: string): void {
    const transfer = this.active.get(id)
    if (!transfer) return
    this.active.delete(id)
    const current = this.activeByCaller.get(transfer.callerIdentity) ?? 0
    if (current <= 1) this.activeByCaller.delete(transfer.callerIdentity)
    else this.activeByCaller.set(transfer.callerIdentity, current - 1)
    if (this.active.size === 0) {
      const waiters = this.drainWaiters
      this.drainWaiters = []
      for (const resolve of waiters) resolve()
    }
  }

  private async validateCallerRoot(callerRoot: string): Promise<string> {
    const lexical = path.resolve(callerRoot)
    const expected = isWithinDirectory(lexical, this.hostRoot)
      ? lexical
      : isWithinDirectory(lexical, this.requestedHostRoot)
        ? path.join(this.hostRoot, path.relative(this.requestedHostRoot, lexical))
        : undefined
    if (expected === undefined) throw new GfsDownloadStoreError('workspace_unavailable')
    const real = await fs.realpath(lexical).catch(() => {
      throw new GfsDownloadStoreError('workspace_unavailable')
    })
    if (real !== expected || !isWithinDirectory(real, await fs.realpath(this.hostRoot)))
      throw new GfsDownloadStoreError('workspace_unavailable')
    const info = await fs.lstat(real)
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new GfsDownloadStoreError('workspace_unavailable')
    return real
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail
    let unlock!: () => void
    this.mutationTail = new Promise<void>(resolve => {
      unlock = resolve
    })
    await previous
    try {
      return await operation()
    } finally {
      unlock()
    }
  }

  private assertPublicationOpen(publication?: { signal?: AbortSignal; deadlineMs?: number }): void {
    if (
      publication?.signal?.aborted ||
      (publication?.deadlineMs !== undefined && Date.now() >= publication.deadlineMs)
    )
      throw new GfsDownloadStoreError('publication_cancelled')
  }

  /** Not initialized: workspace_unavailable. Closed: download_busy. */
  private assertInitialized(): void {
    if (this.closed) throw new GfsDownloadStoreError('download_busy')
    if (!this.initialized) throw new GfsDownloadStoreError('workspace_unavailable')
  }

  private assertReadable(): void {
    this.assertInitialized()
  }

  /** Admission also stops while close() drains. */
  private assertAdmitting(): void {
    this.assertInitialized()
    if (this.closing) throw new GfsDownloadStoreError('download_busy')
  }
}
