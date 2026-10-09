import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { logger } from '../logger'
import type { GfsImageSource } from '../visualInput/policy'
import {
  GFS_DOWNLOADS_TRASH_PREFIX,
  RETIRED_GFS_DOWNLOAD_STORE_PREFIX,
} from '../workspace/protectedPaths'
import { recordGfsDownloadExpiry, recordGfsDownloadQuota } from './gfsDownloadMetrics'
import {
  GFS_FILE_LIMITS,
  GFS_HOST_ACTIVE_DOWNLOADS,
  REMOVED_GFS_STORAGE_VARIABLES,
} from './gfsFilePolicy'
import {
  PrivateStoreUntrustedError,
  openPrivateStoreObject,
  verifyPrivateStoreDirectory,
} from './gfsStorePrivateFiles'

const GFS_DOWNLOAD_STORE_LOG_COMPONENT = 'GfsDownloadStore'

/** Caller-root directory that holds every download of that caller. */
const DOWNLOADS_DIRECTORY = '.gfs-downloads'
const USERS_DIRECTORY = 'users'
const META_FILE = 'meta.json'
const SOURCE_FILE = 'source'
const PARTIAL_FILE = 'source.partial'
const META_MAX_BYTES = 64 * 1024
/**
 * Share of the volume admission keeps free and the startup and periodic
 * sweeps restore. The
 * volume is shared: on a stateless Host `state/` (state.db) is a subPath of
 * the same PVC, and shell commands and file writes land on it too.
 */
const FREE_SPACE_FLOOR_PERCENT = 15n
/** The floor on a volume too small for its percentage to reach this. */
const FREE_SPACE_FLOOR_MIN_BYTES = 16n * 1024n * 1024n
/**
 * Share of the volume, above the floor, that a restore frees once the volume
 * fell below the floor. Admission still requires only the floor.
 */
const FREE_SPACE_RESTORE_HEADROOM_PERCENT = 5n
/** A copy reused with less time left could expire while a shell command reads it. */
const REUSE_MIN_REMAINING_MS = 60 * 60 * 1000
/** Host-root directory of the ledger store written before #1028; never read. */
const LEGACY_STORE_DIRECTORY = '.gfs-download-store'

const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
/** The only directory names under `.gfs-downloads` that belong to the store. */
export const GFS_INPUT_DIRECTORY_RE = new RegExp(`^input-(${UUID_PATTERN})$`)
/** A directory renamed out of the way before removal; swept if a removal stops. */
const TRASH_PREFIX = '.trash-'
const TRASH_DIRECTORY_RE = new RegExp(`^\\.trash-${UUID_PATTERN}$`)
/** A replaced `.gfs-downloads`, renamed inside its caller root before removal. */
const DOWNLOADS_TRASH_DIRECTORY_RE = new RegExp(
  `^${GFS_DOWNLOADS_TRASH_PREFIX.replaceAll('.', '\\.')}${UUID_PATTERN}$`
)
/** Host-root names the retirement of the pre-#1028 store gives the old tree. */
const RETIRED_DIRECTORY_RE = new RegExp(
  `^${RETIRED_GFS_DOWNLOAD_STORE_PREFIX.replaceAll('.', '\\.')}${UUID_PATTERN}$`
)
/** Caller-relative receipt path; the same contract gfsFilePreparation enforces. */
const RECEIPT_PATH_RE = new RegExp(`^\\.gfs-downloads/input-(${UUID_PATTERN})/source$`)
const SHA256_RE = /^[0-9a-f]{64}$/

export type GfsDownloadStoreErrorCode =
  | 'caller_mismatch'
  /** The Host volume's free space cannot hold the reservation plus the free-space floor. */
  | 'disk_full'
  | 'download_busy'
  | 'download_expired'
  | 'download_missing'
  /** The retained-download budget or one caller's protected share of it is full. */
  | 'host_quota_exceeded'
  /** The declared size is not a safe non-negative integer up to the file limit. */
  | 'limit_exceeded'
  | 'publication_cancelled'
  | 'storage_write_failed'
  /**
   * statfs gave an invalid reading (a non-positive block size or block count,
   * or a negative available-block count) twice in a row, so the volume cannot
   * be sized: neither the disk nor the cache is known to be full.
   */
  | 'volume_unmeasurable'
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
 * running with the Host UID): it counts against the Host budget and is swept,
 * but it is never reused, read or pinned.
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
  /** `<hostRoot>/users/<key>` containing the entry: the owner for inventory. */
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

/** A duplicate directory the last sweep could not remove; it stays charged. */
interface HeldCopy {
  sizeBytes: number
}

/** The statfs fields admission uses, validated: bsize and blocks positive. */
interface VolumeSpace {
  bsize: bigint
  blocks: bigint
  bavail: bigint
}

/**
 * The retained-storage budget, `floor(volumeTotalBytes * percent / 100)`,
 * computed in bigint so no volume size loses precision.
 */
function retainedBudget(volume: VolumeSpace): bigint {
  return (volume.blocks * volume.bsize * BigInt(GFS_FILE_LIMITS.storagePercent)) / 100n
}

/**
 * Free bytes the volume must keep after every admission:
 * `max(floor(volumeTotalBytes * 15 / 100), 16 MiB)`, in bigint.
 */
export function freeSpaceFloor(volume: { bsize: bigint; blocks: bigint }): bigint {
  const share = (volume.blocks * volume.bsize * FREE_SPACE_FLOOR_PERCENT) / 100n
  return share > FREE_SPACE_FLOOR_MIN_BYTES ? share : FREE_SPACE_FLOOR_MIN_BYTES
}

/**
 * Free bytes a restore aims for once the volume is below the floor:
 * `freeSpaceFloor + floor(volumeTotalBytes * 5 / 100)`, in bigint.
 */
export function freeSpaceRestoreTarget(volume: { bsize: bigint; blocks: bigint }): bigint {
  return (
    freeSpaceFloor(volume) +
    (volume.blocks * volume.bsize * FREE_SPACE_RESTORE_HEADROOM_PERCENT) / 100n
  )
}

/** `bytes` rounded up to whole blocks of the volume. */
function blockBytes(volume: VolumeSpace, bytes: number): bigint {
  return ((BigInt(bytes) + volume.bsize - 1n) / volume.bsize) * volume.bsize
}

/**
 * One eviction plan for an admission, decided before anything is deleted.
 * `ids` is the shortest prefix of the eviction order that covers both the
 * budget and the free-space deficit, or every candidate when one of them
 * cannot be covered; the flags say which are covered by `ids`.
 */
interface EvictionPlan {
  ids: Set<string>
  budgetCovered: boolean
  physicalCovered: boolean
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

/**
 * `failed`: the directory was not moved and still holds its bytes under its
 * own name. `trashed`: it was renamed to its trash name but not removed, so
 * its bytes are on disk under that name; the retained-byte charge it carried
 * moved there with it (see removeDirectory).
 */
type RemovalResult = 'removed' | 'absent' | 'failed' | 'trashed'

/**
 * A removal that renamed `directory` to `trash` and then could not remove
 * `trash` (or could not prove it gone). `code` is the underlying errno or
 * store code, so logs and errorCode() see the real cause. `refusal` is set
 * when the parent check refused `trash` and the rename back failed: the
 * bytes are under `trash`, the refusal is what callers report, and `trash`
 * is not measured because its parent did not pass the check.
 */
class TrashLeftError extends Error {
  readonly code: string

  constructor(
    readonly trash: string,
    cause: unknown,
    readonly refusal?: unknown
  ) {
    super('GFS download store left a renamed directory on disk')
    this.name = 'TrashLeftError'
    this.code = errorCode(cause)
  }
}

/**
 * A removal whose rename failed after the parent check passed: the directory
 * and its bytes are still under their own name.
 */
class KeptInPlaceError extends Error {
  readonly code: string

  constructor(cause: unknown) {
    super('GFS download store could not rename a directory it is removing')
    this.name = 'KeptInPlaceError'
    this.code = errorCode(cause)
  }
}

/**
 * `unknown`: the disk did not answer (EMFILE, EIO, ...). Nothing is decided
 * about the directory; it is kept as it is and inspected again later.
 */
type DirectoryState =
  | { state: 'absent' }
  | { state: 'incomplete' }
  | { state: 'unknown'; code: string }
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

/**
 * Errnos that are an answer about the object itself rather than about the
 * process or the volume at this instant: it is gone, it is a symlink or sits
 * under a non-directory, or its mode refuses the owner.
 */
const DEFINITIVE_ERRNO = new Set(['ENOENT', 'ELOOP', 'ENOTDIR', 'EACCES'])

/**
 * True only when a failure proves that a copy or directory is not what the
 * store wrote: a size, inode or digest mismatch (raised as a store error), an
 * untrusted owner, mode or type, or a definitive errno. Anything else (EMFILE,
 * EIO, ENOMEM, ...) is transient: the object is kept and checked again later,
 * never removed on its account.
 */
function isDefinitiveMismatch(error: unknown): boolean {
  if (error instanceof GfsDownloadStoreError) return error.code !== 'publication_cancelled'
  if (error instanceof PrivateStoreUntrustedError) return true
  return DEFINITIVE_ERRNO.has(errorCode(error))
}

/** Errno, or the error class name for the store's own refusals; never a path. */
function diagnosticCode(error: unknown): string {
  const code = errorCode(error)
  return code === 'unknown' && error instanceof Error ? error.name : code
}

function stateFor(error: unknown): DirectoryState {
  return isDefinitiveMismatch(error)
    ? { state: 'incomplete' }
    : { state: 'unknown', code: errorCode(error) }
}

/**
 * Only a regular file can be a receipt. Opening a socket fails with an errno
 * that is not definitive by itself (ENXIO on Linux; on macOS an EOPNOTSUPP that
 * Node reports as an unknown system error), which would keep the directory as
 * unknown forever; after such a failure the type of the name is the answer.
 * The type is read only after the open failed, so nothing is opened on the
 * strength of a check that may be stale.
 */
async function metaOpenFailureState(metaPath: string, error: unknown): Promise<DirectoryState> {
  if (isDefinitiveMismatch(error)) return { state: 'incomplete' }
  try {
    if (!(await fs.lstat(metaPath)).isFile()) return { state: 'incomplete' }
  } catch (lstatError) {
    return stateFor(lstatError)
  }
  return stateFor(error)
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
  // A name swapped for a FIFO must fail, never block: O_DIRECTORY refuses it.
  const handle = await fs.open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  )
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
 * Regular files and their bytes under a directory, for the retirement log and
 * for charging a directory the store removes with no charge in hand. Nothing
 * is opened and no symlink is followed, the root included: a path that is not
 * a real directory when its turn comes, including one replaced by a symlink
 * after it was listed, holds no bytes of its own, and files are classified by
 * their own lstat type.
 */
async function treeUsage(root: string): Promise<{ files: number; bytes: number }> {
  const usage = { files: 0, bytes: 0 }
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.pop()!
    if (!(await fs.lstat(directory)).isDirectory()) continue
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

/**
 * Gives the owner rwx on one directory, keeping its other mode bits. The name
 * is opened with O_DIRECTORY | O_NOFOLLOW and the mode is changed through
 * that descriptor, after its fstat confirms a directory: a symlink in the
 * name's place is refused by the open and never followed, and the mode that
 * is set is computed from, and applied to, the inode that was opened,
 * whatever the name leads to afterwards. A symlink or a non-directory
 * changes nothing and returns false. The open needs the owner's read bit, so
 * a directory whose mode denies its owner read access (`chmod 0300`, `0000`)
 * cannot be repaired here: that EACCES propagates, like any other failure.
 */
async function restoreDirectoryOwnerAccess(directory: string): Promise<boolean> {
  let handle: fs.FileHandle
  try {
    handle = await fs.open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    )
  } catch (error) {
    const code = errorCode(error)
    if (code === 'ELOOP' || code === 'ENOTDIR') return false
    throw error
  }
  try {
    const info = await handle.stat()
    if (!info.isDirectory()) return false
    await handle.chmod((info.mode & 0o7777) | 0o700)
    return true
  } finally {
    await handle.close()
  }
}

/**
 * Gives the owner rwx on every real directory under `root`, root included,
 * through restoreDirectoryOwnerAccess. Children are listed and reached by
 * path, because Node has no openat: the final component of each path is
 * never followed, but a directory swapped for a symlink after it was changed
 * is resolved as a parent component when its children are listed and opened.
 */
async function restoreOwnerAccess(root: string): Promise<void> {
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.pop()!
    if (!(await restoreDirectoryOwnerAccess(directory))) continue
    for (const entry of await fs.readdir(directory, { withFileTypes: true }))
      if (entry.isDirectory()) pending.push(path.join(directory, entry.name))
  }
}

/**
 * Removes a store-private trash tree. A shell running with the Host UID can
 * take the write bit off a directory in it (`chmod 0500`), and then every
 * removal of its children fails with EACCES or EPERM and the bytes stay
 * charged forever. Those two codes restore the owner's access over the whole
 * tree and retry once; any other failure, or a second one, propagates.
 */
async function removeTree(trash: string): Promise<void> {
  try {
    await fs.rm(trash, { recursive: true, force: true })
    return
  } catch (error) {
    const code = errorCode(error)
    if (code !== 'EACCES' && code !== 'EPERM') throw error
  }
  await restoreOwnerAccess(trash)
  await fs.rm(trash, { recursive: true, force: true })
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
  /** Duplicates the last sweep could not remove, by directory; see sweep(). */
  private held = new Map<string, HeldCopy>()
  private readonly activeByCaller = new Map<string, number>()
  /** Keyed by `pinKey(callerIdentity, ownerId)`: callers never share or see a pin. */
  private readonly pins = new Map<string, Set<string>>()
  private mutationTail: Promise<void> = Promise.resolve()
  private drainWaiters: Array<() => void> = []
  private initializing?: Promise<void>
  private initialized = false
  private removedVariablesWarned = false
  private closing = false
  private closed = false
  /** The one close() in progress or done; every later call returns it. */
  private closeDone?: Promise<void>

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
    // Named, never echoed: a stale value could be anything an operator typed.
    // Once per store, not per attempt: the runtime retries a failed
    // initialize() every cycle on the same store.
    if (!this.removedVariablesWarned) {
      this.removedVariablesWarned = true
      for (const variable of REMOVED_GFS_STORAGE_VARIABLES)
        if (process.env[variable] !== undefined)
          logger.warn(
            { component: GFS_DOWNLOAD_STORE_LOG_COMPONENT, variable },
            'GFS download store ignores a removed retained-storage variable; the budget is MCP_HOST_GFS_DOWNLOAD_STORAGE_PERCENT of the workspace volume'
          )
    }
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
    // The floor is restored at startup too: a Host restarting on a full volume
    // frees unpinned copies before the rest of the process needs to write.
    const totals = await this.serialize(async () => {
      const now = Date.now()
      const swept = await this.sweep(now)
      await this.restoreFreeSpaceFloor(now)
      return swept
    })
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
      throw new GfsDownloadStoreError('limit_exceeded')
    if (typeof input.callerIdentity !== 'string' || input.callerIdentity.length === 0)
      throw new GfsDownloadStoreError('caller_mismatch')
    if (!isValidSource(input.source)) throw new RangeError('GFS download source is malformed')
    const createdAtMs = Date.now()
    const expiresAtMs = Date.parse(input.expiresAt)
    // A copy that expires at its own creation could never be read or reused.
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= createdAtMs)
      throw new RangeError('GFS download expiry must be a future ISO timestamp')
    // The same bound parseMeta applies, so a published copy stays valid on disk.
    if (expiresAtMs > createdAtMs + GFS_FILE_LIMITS.retentionMs)
      throw new RangeError('GFS download expiry must be within the retention window')
    if (input.retentionOwnerId !== undefined) this.assertReceiptOwner(input.retentionOwnerId)
    const callerRoot = await this.validateCallerRoot(input.callerWorkspacePath)
    // The identity is the caller root's own key, so every later identity check
    // (reuse, managed reads, pins, active counts) is bound to this root. A raw
    // sender is not unique across channels and is refused here.
    if (path.basename(callerRoot) !== input.callerIdentity)
      throw new GfsDownloadStoreError('caller_mismatch')
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
      // The sweep runs first: it removes only expired copies (pinned ones
      // included) and incomplete directories, so bytes the store must delete
      // anyway never refuse an admission as disk_full. One statfs then sizes
      // both the budget and the free-space deficit, so a resized volume counts
      // at once, and one eviction plan covers both before anything is
      // deleted. A deficit the evictable copies cannot cover refuses as
      // disk_full with nothing evicted: no live cached copy is evicted for an
      // admission the volume cannot hold anyway. Measured again after
      // eviction below.
      await this.sweep(Date.now())
      const volume = await this.measureVolume()
      const budget = retainedBudget(volume)
      const plan = this.planEviction(volume, input.sizeBytes)
      if (!plan.physicalCovered) {
        recordGfsDownloadQuota('host', 'free_space')
        throw new GfsDownloadStoreError('disk_full')
      }
      // The reservation itself is protected until it settles, pinned or not.
      this.assertProtectedRoom(input.callerIdentity, budget, { sizeBytes: input.sizeBytes })
      if (plan.budgetCovered) await this.evict(plan.ids)
      if (this.overBudget(input.sizeBytes, budget)) {
        // The code alone: whose copies fill the budget is never part of it.
        recordGfsDownloadQuota('host', 'storage_bytes')
        throw new GfsDownloadStoreError('host_quota_exceeded')
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
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW |
            constants.O_NONBLOCK,
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
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
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
      // A miss is final; the caller downloads the file again. A copy with less
      // than REUSE_MIN_REMAINING_MS left is a miss too, so a fresh download
      // with the full retention replaces it instead of being hashed for nothing.
      const entry = [...this.entries.values()].find(
        candidate =>
          candidate.provenance === 'published' &&
          candidate.callerIdentity === callerIdentity &&
          Date.parse(candidate.expiresAt) - REUSE_MIN_REMAINING_MS > Date.now() &&
          candidate.sizeBytes === sizeBytes &&
          candidate.source.drive === source.drive &&
          candidate.source.resourceId === source.resourceId &&
          candidate.source.version === source.version
      )
      if (!entry) return undefined
      // Pinning a copy this caller does not protect yet adds it to the
      // caller's protected bytes (capped at half the budget) and to the Host
      // total (capped at three quarters); checked before hashing, so a refusal costs
      // no read. A copy the caller already protects adds nothing, so that is
      // decided first and re-pinning it never depends on statfs.
      if (
        bounds?.retentionOwnerId !== undefined &&
        !this.protectedIds(callerIdentity).has(entry.id)
      )
        this.assertProtectedRoom(callerIdentity, retainedBudget(await this.measureVolume()), {
          id: entry.id,
          sizeBytes: entry.sizeBytes,
        })
      let verified = false
      let transient: string | undefined
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
        if (!isDefinitiveMismatch(error)) transient = errorCode(error)
        verified = false
      }
      if (transient !== undefined) {
        // The disk did not answer: this is not evidence against the copy,
        // which another task may still hold. It stays; this caller downloads.
        logger.warn(
          { component: GFS_DOWNLOAD_STORE_LOG_COMPONENT, code: transient },
          'GFS download store could not verify a published copy for reuse; it is kept and checked again later'
        )
        return undefined
      }
      if (!verified) {
        await this.removeEntry(entry, 'incomplete_removed')
        return undefined
      }
      this.assertPublicationOpen(bounds)
      // The reuse margin may have been crossed while the copy was hashed: a
      // copy that expires within REUSE_MIN_REMAINING_MS is a cache miss, never
      // pinned or returned. The caller downloads the file again and the sweep
      // removes this copy once it expires.
      if (Date.parse(entry.expiresAt) - REUSE_MIN_REMAINING_MS <= Date.now()) return undefined
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
      // The reservation becomes the charge of whatever the removal leaves on disk.
      const result = await this.removeDirectory(
        transfer.directory,
        'incomplete_removed',
        transfer.sizeBytes
      )
      if (result === 'failed' || result === 'trashed')
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
    } catch (error) {
      this.reportManagedReadFailure(error)
      throw new GfsDownloadStoreError('download_missing')
    }
    if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
      // A copy whose bytes no longer match its receipt is not a cache entry.
      // Once the store is closed nothing is removed: the next start's sweep
      // judges the copy again.
      await this.serialize(async () => {
        if (!this.closed) await this.removeEntry(entry, 'incomplete_removed')
      })
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
    } catch (error) {
      this.reportManagedReadFailure(error)
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

  /**
   * Removes expired and incomplete downloads, then restores the free-space
   * floor in the same critical section. Startup runs the same sweep and
   * restore; an admission runs only the sweep and plans its own eviction
   * against the floor.
   */
  async cleanupExpired(now = Date.now()): Promise<GfsDownloadSweepResult> {
    this.assertReadable()
    try {
      const totals = await this.serialize(async () => {
        const swept = await this.sweep(now)
        await this.restoreFreeSpaceFloor(now)
        return swept
      })
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
   * Stops admitting, waits for active transfers and then for the mutation
   * queue to be empty (including work accepted during the wait) until the
   * deadline, and then closes regardless. Transfers still active afterwards get download_busy
   * from publish/fail; their directories are removed by the next start. An
   * initialize() in progress is waited for first, under the same deadline;
   * it then fails with download_busy. Every call returns the first call's
   * promise, so none resolves before the store is closed.
   */
  close(drainTimeoutMs = 5_000): Promise<void> {
    this.closeDone ??= this.runClose(drainTimeoutMs)
    return this.closeDone
  }

  private async runClose(drainTimeoutMs: number): Promise<void> {
    const initializing = this.initializing
    if (!this.initialized && initializing === undefined) {
      this.closed = true
      return
    }
    this.closing = true
    let timer: NodeJS.Timeout | undefined
    let deadlineReached = false
    const deadline = new Promise<void>(resolve => {
      timer = setTimeout(() => {
        deadlineReached = true
        resolve()
      }, drainTimeoutMs)
    })
    // Its rejection belongs to the initialize() caller; here it only ends the wait.
    if (initializing !== undefined)
      await Promise.race([initializing.catch(() => undefined), deadline])
    const drained = new Promise<void>(resolve => {
      if (this.active.size === 0) resolve()
      else this.drainWaiters.push(resolve)
    })
    // Active transfers first, then the mutation queue until it is stable: a
    // mutation accepted while close() waits replaces the tail, so wait again.
    // Both phases are bounded by the same deadline.
    await Promise.race([drained, deadline])
    while (!deadlineReached) {
      const tail = this.mutationTail
      await Promise.race([tail, deadline])
      if (tail === this.mutationTail) break
    }
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
   * directories and expired complete ones are removed; complete ones are
   * (re)indexed, new ones as adopted. Expiry is absolute: a retention pin
   * protects a copy from eviction, never past its `expiresAt`, so a pinned
   * copy is removed at expiry like any other and a task that still needs the
   * file downloads it again. Active transfers of this process are
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
    /**
     * A removal that leaves the directory under its trash name is not 'failed'
     * for the index: the old name is gone and the charge, when `charge` or a
     * held charge gives one, moved to the trash name (removeDirectory).
     */
    const removeIncomplete = async (directory: string, charge?: number): Promise<RemovalResult> => {
      const result = await this.removeDirectory(directory, 'incomplete_removed', charge)
      if (result === 'removed') totals.removedIncomplete += 1
      else if (result === 'failed' || result === 'trashed') totals.removeFailed += 1
      return result
    }
    // A duplicate this sweep could not remove is still on disk, so it stays
    // charged: a failed cleanup never turns into free capacity. Its charge is
    // released only by a removal that succeeds or an lstat that proves the
    // directory gone: ENOENT, ENOTDIR (a parent is no longer a directory) or
    // a path that is no longer a directory. An inspection or listing that
    // fails, or any other lstat answer, carries the previous sweep's charge
    // over instead of reading as zero. A charge that a removal moved to a
    // trash name is held under that name by the same rule. `previousHeld` is
    // the live `this.held`, so a charge removeDirectory moves during this
    // sweep is carried by the loop below.
    const previousHeld = this.held
    const held = new Map<string, HeldCopy>()
    const settled = new Set<string>()
    const removeDuplicate = async (id: string, directory: string): Promise<void> => {
      settled.add(directory)
      // Sized before the removal when no earlier sweep charged it, so a copy
      // left under a trash name stays charged.
      let charge = previousHeld.get(directory)?.sizeBytes
      if (charge === undefined) {
        const before = await this.inspectDirectory(directory, id, now)
        if (before.state === 'complete') charge = before.entry.sizeBytes
      }
      if ((await removeIncomplete(directory, charge)) !== 'failed') return
      const state = await this.inspectDirectory(directory, id, now)
      if (state.state === 'complete') held.set(directory, { sizeBytes: state.entry.sizeBytes })
      else if (state.state === 'unknown' || state.state === 'incomplete') {
        const previous = previousHeld.get(directory)
        if (previous) held.set(directory, previous)
      }
    }

    for (const [id, directories] of candidates) {
      const indexed = this.entries.get(id)
      const owned =
        this.active.get(id)?.directory ??
        (indexed?.provenance === 'published' ? indexed.directory : undefined)
      if (owned === undefined && directories.length > 1) {
        // The indexed directory is forgotten only once its name is gone; a
        // failed removal leaves it indexed and charged, like any other entry,
        // and one left under a trash name is charged there instead.
        for (const duplicate of directories) {
          if (duplicate !== indexed?.directory) await removeDuplicate(id, duplicate)
          else if ((await removeIncomplete(duplicate, indexed.sizeBytes)) !== 'failed')
            this.forget(id)
        }
        continue
      }
      if (owned !== undefined)
        for (const duplicate of directories)
          if (duplicate !== owned) await removeDuplicate(id, duplicate)
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
      if (state.state === 'unknown') {
        // Kept as it is, indexed or not; the next sweep inspects it again.
        recordGfsDownloadExpiry('sweep_failed')
        logger.warn(
          { component: GFS_DOWNLOAD_STORE_LOG_COMPONENT, code: state.code },
          'GFS download store could not inspect a download directory; it is kept and the next sweep retries it'
        )
        continue
      }
      // An entry is forgotten only once its directory name is gone: a failed
      // removal leaves it indexed, charged and with its provenance; a removal
      // that left it under a trash name moved its charge there.
      if (state.state === 'incomplete') {
        const charge = indexed?.directory === directory ? indexed.sizeBytes : undefined
        if ((await removeIncomplete(directory, charge)) !== 'failed') this.forget(id)
        continue
      }
      const entry = state.entry
      if (Date.parse(entry.expiresAt) <= now) {
        const result = await this.removeDirectory(directory, 'expired_removed', entry.sizeBytes)
        if (result === 'removed') totals.removedExpired += 1
        if (result === 'failed' || result === 'trashed') totals.removeFailed += 1
        if (result !== 'failed') this.forget(id)
        continue
      }
      this.entries.set(id, entry)
      totals.retainedCompleted += 1
      totals.retainedBytes += entry.sizeBytes
      if (entry.provenance === 'adopted') totals.adopted += 1
    }
    // A held directory this sweep never reached (its listing failed, or it is
    // no longer a duplicate) keeps its charge until lstat proves it gone:
    // ENOENT, ENOTDIR (a parent is no longer a directory) or a path that is
    // no longer a directory. Any other answer keeps the charge.
    for (const [directory, copy] of previousHeld) {
      if (settled.has(directory)) continue
      try {
        if (!(await fs.lstat(directory)).isDirectory()) continue
      } catch (error) {
        const code = errorCode(error)
        if (code === 'ENOENT' || code === 'ENOTDIR') continue
      }
      held.set(directory, copy)
    }
    // Never charged twice: a directory now indexed or being transferred is
    // already counted through its entry or its reservation.
    const counted = new Set<string>()
    for (const entry of this.entries.values()) counted.add(entry.directory)
    for (const transfer of this.active.values()) counted.add(transfer.directory)
    for (const directory of held.keys()) if (counted.has(directory)) held.delete(directory)
    this.held = held
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
        await this.removeVerified(path.join(this.hostRoot, name))
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
    const usersRoot = path.join(this.hostRoot, USERS_DIRECTORY)
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
    // A trash directory a held charge names keeps that charge through the
    // removal: removeDirectory keeps it, moves it to the next trash name, or
    // releases it, and measures one with no held charge (left before this
    // process started) when its removal fails.
    const removeStray = async (directory: string, sweep: SweepTotals) => {
      const result = await this.removeDirectory(directory, 'incomplete_removed')
      if (result === 'removed') sweep.removedIncomplete += 1
      else if (result === 'failed' || result === 'trashed') sweep.removeFailed += 1
    }
    for (const user of users) {
      if (!user.isDirectory()) continue
      const callerRoot = path.join(usersRoot, user.name)
      if (totals)
        await this.sweepDownloadsTrash(callerRoot, directory => removeStray(directory, totals))
      const downloadsRoot = path.join(callerRoot, DOWNLOADS_DIRECTORY)
      let children: import('node:fs').Dirent[]
      try {
        const info = await fs.lstat(downloadsRoot)
        if (!info.isDirectory()) {
          if (totals) await removeStray(downloadsRoot, totals)
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
        else if (totals && TRASH_DIRECTORY_RE.test(child.name))
          // Left by a removal that stopped between its rename and its rm.
          await removeStray(path.join(downloadsRoot, child.name), totals)
      }
    }
    return found
  }

  /**
   * Bytes of regular files under a directory the store is removing and holds
   * no charge for, without following symlinks. A tree that cannot be
   * measured is logged with its code and left uncharged.
   */
  private async sizeStray(directory: string): Promise<number | undefined> {
    try {
      return (await treeUsage(directory)).bytes
    } catch (error) {
      logger.warn(
        { component: GFS_DOWNLOAD_STORE_LOG_COMPONENT, code: errorCode(error) },
        'GFS download store could not measure a directory it is removing; it is not charged until a sweep measures it'
      )
      return undefined
    }
  }

  /**
   * Measures a directory a failed removal left under its own name. Its parent
   * is checked again first: one still refused is not read, and the directory
   * stays uncharged until a later removal finds the parent safe. The refusal
   * was already logged by the removal.
   */
  private async sizeInPlace(directory: string): Promise<number | undefined> {
    try {
      await this.assertRemovable(directory)
    } catch {
      return undefined
    }
    return this.sizeStray(directory)
  }

  /**
   * A replaced `.gfs-downloads` is renamed to `.gfs-downloads.trash-<uuid>`
   * in its caller root; one a stopped removal left there still holds copies
   * of user files, so the sweep removes it like any other trash.
   */
  private async sweepDownloadsTrash(
    callerRoot: string,
    remove: (directory: string) => Promise<void>
  ): Promise<void> {
    let names: string[]
    try {
      names = await fs.readdir(callerRoot)
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') this.reportSweepFailure(error)
      return
    }
    for (const name of names)
      if (DOWNLOADS_TRASH_DIRECTORY_RE.test(name)) await remove(path.join(callerRoot, name))
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
      return stateFor(error)
    }
    if (!info.isDirectory()) return { state: 'incomplete' }
    const metaPath = path.join(directory, META_FILE)
    let raw: string
    try {
      // Anything in the tree may have been replaced from a shell. A FIFO with
      // no writer would block a plain open, and with it the sweep, startup and
      // every admission behind them; O_NONBLOCK opens it at once and the
      // descriptor's type decides.
      const handle = await fs.open(
        metaPath,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      )
      try {
        const metaInfo = await handle.stat()
        if (!metaInfo.isFile() || metaInfo.size > META_MAX_BYTES) return { state: 'incomplete' }
        raw = await handle.readFile('utf8')
      } finally {
        await handle.close()
      }
    } catch (error) {
      return metaOpenFailureState(metaPath, error)
    }
    const meta = parseMeta(raw, id, now)
    if (!meta) return { state: 'incomplete' }
    try {
      const source = await fs.lstat(path.join(directory, SOURCE_FILE))
      if (!source.isFile() || source.size !== meta.sizeBytes) return { state: 'incomplete' }
    } catch (error) {
      return stateFor(error)
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

  /**
   * An indexed entry is re-checked with one lstat; meta.json is not re-read.
   * Only a definitive answer makes it incomplete; a transient errno keeps it.
   */
  private async recheckIndexed(entry: Entry): Promise<DirectoryState> {
    try {
      const source = await fs.lstat(path.join(entry.directory, SOURCE_FILE))
      if (source.isFile() && source.size === entry.sizeBytes) return { state: 'complete', entry }
      return { state: 'incomplete' }
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') return stateFor(error)
    }
    try {
      await fs.lstat(entry.directory)
    } catch (directoryError) {
      if (errorCode(directoryError) === 'ENOENT') return { state: 'absent' }
      return stateFor(directoryError)
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
   * A `.gfs-downloads` proven not to be the store's (a symlink, not a
   * directory, gone, unreadable to its owner, or not owned by this process
   * with a private mode) is removed without following it and recreated, so a
   * shell command can cost a caller its cached copies but never block its
   * downloads. Any other failure to verify it (EMFILE, EIO, ...) proves
   * nothing: it is rethrown, the admission fails and the directory and its
   * copies stay.
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
    } catch (error) {
      if (!isDefinitiveMismatch(error)) throw error
    }
    const replaced = this.idsUnder(downloadsRoot)
    try {
      await this.removeVerified(downloadsRoot)
    } catch (error) {
      // Renamed but not removed: every copy charged under the old name is
      // now on disk under the trash name, so the charge moves there.
      if (error instanceof TrashLeftError) {
        this.moveChargesToTrash(downloadsRoot, replaced, error.trash)
        if (error.refusal !== undefined) throw error.refusal
      }
      throw error
    }
    for (const id of replaced) this.forget(id)
    await fs.mkdir(downloadsRoot, { mode: 0o700 })
    await verifyPrivateStoreDirectory(downloadsRoot)
  }

  private isIndexedDirectory(directory: string): boolean {
    for (const entry of this.entries.values()) if (entry.directory === directory) return true
    return false
  }

  private idsUnder(downloadsRoot: string): string[] {
    return [...this.entries.values()]
      .filter(entry => path.dirname(entry.directory) === downloadsRoot)
      .map(entry => entry.id)
  }

  /**
   * `root` was renamed to `trash` and not removed: the indexed copies `ids`
   * and every held charge below `root` are charged once, as one held charge
   * on `trash`, and the copies are forgotten (their names are gone).
   */
  private moveChargesToTrash(root: string, ids: string[], trash: string): void {
    let bytes = 0
    for (const id of ids) {
      const entry = this.entries.get(id)
      if (entry) bytes += entry.sizeBytes
      this.forget(id)
    }
    for (const [directory, copy] of this.held)
      if (directory === root || isWithinDirectory(directory, root)) {
        bytes += copy.sizeBytes
        this.held.delete(directory)
      }
    if (bytes > 0) this.held.set(trash, { sizeBytes: bytes })
  }

  /**
   * A statfs reading whose block size or block count is not positive, or
   * whose available-block count is negative, cannot size anything. The volume
   * is measured once more at once; a second invalid reading records
   * `free_space` and refuses with `volume_unmeasurable`, never `disk_full` or
   * `host_quota_exceeded`: an unmeasurable volume is proof of neither a full
   * disk nor a full cache, and each of those codes tells the model something
   * about space. A statfs that rejects is not a reading and propagates as is.
   */
  private async measureVolume(): Promise<VolumeSpace> {
    const volume = await this.readVolume()
    if (volume !== undefined) return volume
    recordGfsDownloadQuota('host', 'free_space')
    throw new GfsDownloadStoreError('volume_unmeasurable')
  }

  /** Up to two statfs readings; undefined when both are invalid (see measureVolume). */
  private async readVolume(): Promise<VolumeSpace | undefined> {
    for (let reading = 0; reading < 2; reading += 1) {
      const space = await fs.statfs(this.hostRoot, { bigint: true })
      if (space.bsize > 0n && space.blocks > 0n && space.bavail >= 0n)
        return { bsize: space.bsize, blocks: space.blocks, bavail: space.bavail }
    }
    return undefined
  }

  /**
   * Bytes the volume is short of for this admission: the request and every
   * active reservation, each rounded up to whole blocks, plus the free-space
   * floor, minus the available bytes; 0n when it fits.
   */
  private physicalDeficit(space: VolumeSpace, sizeBytes: number): bigint {
    let required = blockBytes(space, sizeBytes) + freeSpaceFloor(space)
    // Use the full outstanding reservation of every active transfer rather
    // than crediting sparse, shared or concurrently written allocation.
    for (const transfer of this.active.values()) required += blockBytes(space, transfer.sizeBytes)
    const available = space.bavail * space.bsize
    return required > available ? required - available : 0n
  }

  private async assertPhysicalCapacity(sizeBytes: number): Promise<void> {
    if (this.physicalDeficit(await this.measureVolume(), sizeBytes) > 0n) {
      recordGfsDownloadQuota('host', 'free_space')
      throw new GfsDownloadStoreError('disk_full')
    }
  }

  /**
   * Ids held out of eviction: active reservations and the unexpired copies
   * retention owners pin, each id once; those of one caller, or of every
   * caller when `callerIdentity` is omitted. An expired pinned copy protects
   * nothing: the sweep and eviction both remove it.
   */
  private protectedIds(callerIdentity?: string): Set<string> {
    const ids = new Set<string>()
    const now = Date.now()
    for (const transfer of this.active.values())
      if (callerIdentity === undefined || transfer.callerIdentity === callerIdentity)
        ids.add(transfer.id)
    for (const [key, pinned] of this.pins)
      if (
        callerIdentity === undefined ||
        (JSON.parse(key) as [string, string])[0] === callerIdentity
      )
        for (const id of pinned) {
          const entry = this.entries.get(id)
          if (entry !== undefined && Date.parse(entry.expiresAt) <= now) continue
          ids.add(id)
        }
    return ids
  }

  /** Bytes of the protected `ids`: a reservation's size, or an indexed copy's. */
  private protectedBytes(ids: ReadonlySet<string>): bigint {
    let bytes = 0n
    for (const id of ids)
      bytes += BigInt(this.active.get(id)?.sizeBytes ?? this.entries.get(id)?.sizeBytes ?? 0)
    return bytes
  }

  /**
   * Eviction never reclaims an unexpired pinned copy or a reservation, so
   * without a bound open tasks could hold the whole budget, refuse every
   * other admission and leave the free-space restore nothing to evict. Two
   * bounds apply: the bytes one caller protects may reach `floor(budget / 2)`,
   * and the bytes every caller protects together may reach
   * `floor(budget * 3 / 4)`, so at least a quarter of the budget always stays
   * evictable. One caller at its bound leaves a quarter of the budget for the
   * other callers' protected copies; filling the Host bound takes at least two
   * callers. A refusal waits until protection is released or the pinned copies
   * expire. Expiry is absolute, so one pinned copy cannot outlive its
   * retention window, but re-pinning fresh copies (new downloads or reuse of
   * unexpired ones) can keep that state beyond one TTL. Both refusals are the
   * fixed code; the metric scope says which bound refused.
   */
  private assertProtectedRoom(
    callerIdentity: string,
    budget: bigint,
    addition: { id?: string; sizeBytes: number }
  ): void {
    const ids = this.protectedIds(callerIdentity)
    if (addition.id !== undefined && ids.has(addition.id)) return
    const added = BigInt(addition.sizeBytes)
    if (this.protectedBytes(ids) + added > budget / 2n) {
      recordGfsDownloadQuota('caller', 'protected_bytes')
      throw new GfsDownloadStoreError('host_quota_exceeded')
    }
    if (this.protectedBytes(this.protectedIds()) + added > (budget * 3n) / 4n) {
      recordGfsDownloadQuota('host', 'protected_bytes')
      throw new GfsDownloadStoreError('host_quota_exceeded')
    }
  }

  /** Retained bytes: indexed copies, active reservations and held duplicates. */
  private usageBytes(excluded: ReadonlySet<string> = new Set()): bigint {
    let bytes = 0n
    for (const entry of this.entries.values())
      if (!excluded.has(entry.id)) bytes += BigInt(entry.sizeBytes)
    for (const transfer of this.active.values()) bytes += BigInt(transfer.sizeBytes)
    for (const copy of this.held.values()) bytes += BigInt(copy.sizeBytes)
    return bytes
  }

  /** The only retained-storage limit: Host bytes against the volume budget. */
  private overBudget(sizeBytes: number, budget: bigint, excluded?: ReadonlySet<string>): boolean {
    return this.usageBytes(excluded) + BigInt(sizeBytes) > budget
  }

  /**
   * Completed, unpinned copies are a cache, whoever downloaded them: one
   * caller's admission may evict another caller's copy, which costs that
   * caller a re-download and reveals nothing. A pinned copy past its expiry
   * is evictable too; the admission sweep normally removes it first, so this
   * matters when that sweep could not inspect it. The whole eviction plan is
   * computed before anything is deleted: adopted copies first, so files
   * planted in one directory can never cost another caller a copy this
   * process published, then published copies least recently used first.
   * The same plan covers the free-space deficit: with the budget at a share
   * of the volume, the cache plus everything else on it can leave less free
   * space than a request and the floor while the cache is under budget, and
   * the copies it holds are what can be freed. A copy is credited with its
   * size in whole blocks; the volume is measured again after the removals,
   * so a copy that freed less (a hard link, say) refuses then, not here.
   * With no plan that covers both, nothing is deleted and the admission
   * fails with the code of what is not covered (disk_full first); nothing is
   * retained, so the next admission plans again. Candidates are not hashed:
   * a corrupt copy is as good an eviction candidate as a sound one.
   */
  private planEviction(volume: VolumeSpace, sizeBytes: number): EvictionPlan {
    const budget = retainedBudget(volume)
    const deficit = this.physicalDeficit(volume, sizeBytes)
    const ids = new Set<string>()
    let freed = 0n
    const covered = () => ({
      budgetCovered: !this.overBudget(sizeBytes, budget, ids),
      physicalCovered: freed >= deficit,
    })
    for (const candidate of this.evictionCandidates(Date.now())) {
      const state = covered()
      if (state.budgetCovered && state.physicalCovered) break
      ids.add(candidate.id)
      freed += blockBytes(volume, candidate.sizeBytes)
    }
    return { ids, ...covered() }
  }

  /**
   * Indexed copies eviction may take, in evictionOrder: every copy that is
   * not pinned, or whose pin protects nothing because it expired by `now`.
   * Reservations are never indexed, so no active transfer is a candidate.
   */
  private evictionCandidates(now: number): Entry[] {
    return [...this.entries.values()]
      .filter(entry => !this.isPinned(entry.id) || Date.parse(entry.expiresAt) <= now)
      .sort(evictionOrder)
  }

  /** Removes a planned eviction; each removed copy counts as expired_removed. */
  private async evict(ids: ReadonlySet<string>): Promise<void> {
    for (const id of ids) {
      const entry = this.entries.get(id)
      if (entry) await this.removeEntry(entry, 'expired_removed')
    }
  }

  /**
   * The periodic and startup half of the free-space floor. Admission keeps
   * the floor for its own request, but nothing else on the volume asks
   * first: state.db, shell output and file writes can take the free space
   * below the floor after the cache filled. When the volume is below the
   * floor, unpinned copies are evicted in evictionOrder (adopted first, then
   * published least recently used; an expired pinned copy counts as
   * unpinned, as in planEviction) until the copies actually removed, each
   * credited with its size in whole blocks, bring the free space to the
   * floor plus FREE_SPACE_RESTORE_HEADROOM_PERCENT of the volume, or no
   * candidate is left. The headroom keeps the next small write from putting
   * the volume below the floor again right away. Unlike
   * an admission, a partial restore is kept: any space freed helps every
   * other writer on the volume. Each removal goes through removeEntry, so
   * charges follow its rules: a copy whose removal failed stays indexed and
   * charged, and one left under a trash name frees nothing and is not
   * credited. An unmeasurable volume (statfs rejects, or two invalid
   * readings) is logged and counted as sweep_failed, and the restore is
   * skipped: the sweep that already ran keeps its result, and the next cycle
   * measures again.
   */
  private async restoreFreeSpaceFloor(now: number): Promise<void> {
    let volume: VolumeSpace | undefined
    try {
      volume = await this.readVolume()
    } catch (error) {
      this.reportFloorUnmeasured(errorCode(error))
      return
    }
    if (volume === undefined) {
      this.reportFloorUnmeasured('volume_unmeasurable')
      return
    }
    const free = volume.bavail * volume.bsize
    if (free >= freeSpaceFloor(volume)) return
    const deficit = freeSpaceRestoreTarget(volume) - free
    let freed = 0n
    let evicted = 0
    let removeFailed = 0
    for (const candidate of this.evictionCandidates(now)) {
      if (freed >= deficit) break
      const result = await this.removeEntry(candidate, 'expired_removed')
      if (result === 'removed') {
        evicted += 1
        freed += blockBytes(volume, candidate.sizeBytes)
      } else if (result === 'failed' || result === 'trashed') removeFailed += 1
    }
    logger.warn(
      {
        component: GFS_DOWNLOAD_STORE_LOG_COMPONENT,
        evicted,
        removeFailed,
        restored: freed >= deficit,
      },
      'GFS download store found the volume below its free-space floor and evicted unpinned copies'
    )
  }

  private reportFloorUnmeasured(code: string): void {
    recordGfsDownloadExpiry('sweep_failed')
    logger.warn(
      { component: GFS_DOWNLOAD_STORE_LOG_COMPONENT, code },
      'GFS download store could not measure the volume to restore its free-space floor; the next sweep retries it'
    )
  }

  /**
   * Removes an indexed entry's directory, then forgets it. A failed removal
   * keeps the entry indexed: still charged to its caller, and a published
   * copy stays published instead of coming back as adopted. A removal that
   * left the directory under its trash name forgets the entry, whose name is
   * gone, and its charge stays held on the trash name.
   */
  private async removeEntry(
    entry: Entry,
    outcome: 'incomplete_removed' | 'expired_removed'
  ): Promise<RemovalResult> {
    const result = await this.removeDirectory(entry.directory, outcome, entry.sizeBytes)
    if (result !== 'failed') this.forget(entry.id)
    return result
  }

  /**
   * `fs.rm` does not follow the final component, but it resolves every parent
   * component, so a caller directory or `.gfs-downloads` replaced by a symlink
   * after indexing would point the removal outside the Host root. The parent
   * must therefore be its own real path inside the Host root, and the
   * directory must be gone afterwards. A refusal or a failure is logged with
   * its code and counted; the next sweep retries what is still listed.
   *
   * Retained bytes stay charged while they are on disk. The charge is
   * `charge` when the caller gives one (an indexed entry's size, a failed
   * transfer's reservation), otherwise a held charge already on `directory`
   * (a held duplicate or a trash directory an earlier removal left), otherwise
   * the measured size of the directory or its trash. A directory left under
   * its own name and not indexed is held with that charge. When
   * the rename to the trash name succeeds but
   * the trash is not removed, the charge moves to the trash name as a held
   * charge, so the old name's absence never releases it; it is released only
   * when a later removal of that trash succeeds or lstat proves it gone
   * (sweep), and a failed retry moves it again to the next trash name.
   */
  private async removeDirectory(
    directory: string,
    outcome: 'incomplete_removed' | 'expired_removed' | undefined,
    charge?: number
  ): Promise<RemovalResult> {
    const carried = charge ?? this.held.get(directory)?.sizeBytes
    let result: RemovalResult
    try {
      result = await this.removeVerified(directory)
    } catch (error) {
      recordGfsDownloadExpiry('remove_failed')
      logger.warn(
        { component: GFS_DOWNLOAD_STORE_LOG_COMPONENT, code: errorCode(error) },
        'GFS download store could not remove a download directory; the next sweep retries it'
      )
      if (!(error instanceof TrashLeftError)) {
        // Still under its own name: the rename failed, the parent check
        // refused before it, or a refusal after it was undone. An indexed
        // entry keeps its own charge. Otherwise a charge in hand (a failed
        // transfer's reservation, a held charge) stays on the directory; with
        // none, the directory is measured if its parent passes the check now.
        if (!this.isIndexedDirectory(directory)) {
          const kept = carried ?? (await this.sizeInPlace(directory))
          if (kept !== undefined) this.held.set(directory, { sizeBytes: kept })
        }
        return 'failed'
      }
      this.held.delete(directory)
      // No charge in hand: the bytes the rename moved are measured on the
      // trash name when it passed the parent check. One the check refused is
      // not read; only a charge in hand follows it there.
      const moved =
        carried ?? (error.refusal === undefined ? await this.sizeStray(error.trash) : undefined)
      if (moved !== undefined) this.held.set(error.trash, { sizeBytes: moved })
      return 'trashed'
    }
    this.held.delete(directory)
    // A directory that never existed is not a removal.
    if (result === 'removed' && outcome) recordGfsDownloadExpiry(outcome)
    return result
  }

  /**
   * Node has no unlinkat/renameat, so the window between a path check and a
   * path-based removal cannot be closed, only narrowed. The entry is first
   * renamed to a store-private name inside its verified parent; the parent is
   * then verified again, and only that private name is removed. When the
   * parent moved in between, the rename is undone and the removal refused,
   * so whatever the swapped path led to keeps its name and content. A
   * failure after the rename throws TrashLeftError naming the trash path,
   * because the bytes are then on disk under that name.
   *
   * A shell running with the Host UID can take the write bit off the parent
   * (`chmod 0500 .gfs-downloads`); every rename out of it then fails with
   * EACCES or EPERM and the entry would stay charged forever. Those two
   * codes, on a parent that passed the check, restore the owner's rwx on that
   * parent only (restoreDirectoryOwnerAccess: opened without following a
   * symlink, other mode bits kept) and retry the rename once. Any other code,
   * a parent that is no longer a real directory, or a second failure leaves
   * the directory in place (KeptInPlaceError).
   */
  private async removeVerified(directory: string): Promise<'removed' | 'absent'> {
    await this.assertRemovable(directory)
    const trash = path.join(
      path.dirname(directory),
      `${this.trashPrefixFor(directory)}${randomUUID()}`
    )
    try {
      await fs.rename(directory, trash)
    } catch (error) {
      const code = errorCode(error)
      if (code === 'ENOENT') {
        await assertAbsent(directory)
        return 'absent'
      }
      if (code !== 'EACCES' && code !== 'EPERM') throw new KeptInPlaceError(error)
      try {
        if (!(await restoreDirectoryOwnerAccess(path.dirname(directory))))
          throw new KeptInPlaceError(error)
        await fs.rename(directory, trash)
      } catch (retryError) {
        if (retryError instanceof KeptInPlaceError) throw retryError
        throw new KeptInPlaceError(retryError)
      }
    }
    try {
      await this.assertRemovable(trash)
    } catch (error) {
      try {
        await fs.rename(trash, directory)
      } catch (undoError) {
        // The refusal is what the caller must see; the bytes are left under
        // the trash name, which the sweep collects, so the charge moves there.
        logger.warn(
          { component: GFS_DOWNLOAD_STORE_LOG_COMPONENT, code: errorCode(undoError) },
          'GFS download store could not restore a directory after refusing to remove it'
        )
        throw new TrashLeftError(trash, error, error)
      }
      throw error
    }
    try {
      await removeTree(trash)
      await assertAbsent(trash)
    } catch (error) {
      // The bytes are on disk under the trash name now, not under `directory`.
      throw new TrashLeftError(trash, error)
    }
    return 'removed'
  }

  /**
   * The trash name is one the sweep lists in that parent: `.trash-<uuid>`
   * inside `.gfs-downloads`, `.gfs-downloads.trash-<uuid>` in a caller root,
   * `.gfs-download-store.retired-<uuid>` in the Host root.
   */
  private trashPrefixFor(directory: string): string {
    const parent = path.dirname(directory)
    if (parent === this.hostRoot) return RETIRED_GFS_DOWNLOAD_STORE_PREFIX
    if (path.basename(parent) === DOWNLOADS_DIRECTORY) return TRASH_PREFIX
    return GFS_DOWNLOADS_TRASH_PREFIX
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

  /**
   * The caller always gets download_missing, so a read failure reveals
   * nothing about the copy. The owner's own published copy failing for any
   * reason but its absence is worth an operator's attention; code only.
   */
  private reportManagedReadFailure(error: unknown): void {
    if (errorCode(error) === 'ENOENT') return
    if (error instanceof GfsDownloadStoreError && error.code === 'download_missing') return
    logger.warn(
      { component: GFS_DOWNLOAD_STORE_LOG_COMPONENT, code: diagnosticCode(error) },
      'GFS download store could not read a published copy for its caller'
    )
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
    // Exactly `<host>/users/<key>`: never the Host root, `users/` itself, or a
    // directory nested inside a caller root.
    if (
      real !== expected ||
      path.dirname(real) !== path.join(await fs.realpath(this.hostRoot), USERS_DIRECTORY)
    )
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
