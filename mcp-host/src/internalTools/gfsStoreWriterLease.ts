import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { isPrivateStoreStatTrusted, openPrivateStoreObject } from './gfsStorePrivateFiles'

const OWNERSHIP = 'sqlite-exclusive-v1'

/**
 * Closed set naming the branch that refused writer ownership. It carries no
 * path, inode or device value, so it is safe to log as a structured field.
 */
export type WriterFenceDetail =
  | 'local_owner_active'
  | 'local_owner_ambiguous'
  | 'fence_unreadable'
  | 'fence_snapshot_changed'
  | 'legacy_fence'
  | 'missing_fence_with_ledger'
  | 'missing_fence_without_ledger'
  | 'database_missing'
  | 'database_identity_changed'
  | 'sqlite_busy_verified'
  | 'sqlite_busy_unverified'
  | 'ownership_lost'
  | 'path_identity_changed'
  | 'root_path_changed'
  | 'fence_changed'

export class GfsStoreWriterOwnershipError extends Error {
  constructor(
    message: string,
    readonly detail: WriterFenceDetail,
    readonly reason:
      | 'writer_locked'
      | 'unsupported_store_schema'
      | 'corrupt_store_ledger' = 'writer_locked',
    readonly transientWriterContention = false
  ) {
    super(message)
  }
}

/**
 * The fence a successful acquisition verified. A v2 fence also recorded the
 * database device, which changes when a persistent disk is reattached under
 * another device node; only its inode is compared.
 */
export interface GfsStoreWriterFenceAcceptance {
  fenceSchema: 2 | 3
  storedDevice?: string
  currentDevice: string
}

interface KnownWriterFence {
  schemaVersion: 2 | 3
  databaseInode: string
  databaseDevice?: string
}

/**
 * v2 fences ({schemaVersion:2, ownership, databaseDevice, databaseInode}) stay
 * on disk unchanged on Hosts that wrote them; v3 omits the device. Both are
 * accepted by ownership and inode. Anything else is legacy or foreign.
 */
function parseKnownFence(marker: string): KnownWriterFence | undefined {
  try {
    const parsed = JSON.parse(marker) as {
      schemaVersion?: unknown
      ownership?: unknown
      databaseInode?: unknown
      databaseDevice?: unknown
    }
    if (
      (parsed.schemaVersion !== 2 && parsed.schemaVersion !== 3) ||
      parsed.ownership !== OWNERSHIP ||
      typeof parsed.databaseInode !== 'string'
    )
      return undefined
    return {
      schemaVersion: parsed.schemaVersion,
      databaseInode: parsed.databaseInode,
      databaseDevice:
        parsed.schemaVersion === 2 && typeof parsed.databaseDevice === 'string'
          ? parsed.databaseDevice
          : undefined,
    }
  } catch {
    /* An operator can repair the exact hashed interrupted fence. */
    return undefined
  }
}

interface OperatorOwnershipTransition {
  expectedWriterFenceSha256: string | 'absent'
  assertPhysicalFenceHeld(): Promise<void>
}

/**
 * Kernel ownership is released on process death. Database and sentinel inodes
 * stay in place; old O_EXCL binaries remain fenced even during operator repair.
 */
export class GfsStoreWriterLease {
  private static readonly localOwners = new Map<string, GfsStoreWriterLease>()
  private database?: Database.Database
  private databaseHandle?: fs.FileHandle
  private markerHandle?: fs.FileHandle
  private rootHandle?: fs.FileHandle
  private localOwner = false
  // True while this lease is acquiring or releasing. Either ends on its own,
  // and the next attempt judges the store from scratch.
  private inTransition = false
  private verifiedMarker?: string
  private acceptance?: GfsStoreWriterFenceAcceptance
  private readonly databasePath: string
  private readonly markerPath: string

  constructor(
    private readonly root: string,
    private readonly allowBootstrap: boolean
  ) {
    this.databasePath = path.join(root, 'writer-v2.sqlite')
    this.markerPath = path.join(root, 'writer.lock')
  }

  acquire(): Promise<void> {
    return this.acquireInternal()
  }

  /** Internal operator helper only; never exposed through Host tools or RPC. */
  acquireForRecovery(transition: OperatorOwnershipTransition): Promise<void> {
    return this.acquireInternal(transition)
  }

  /** The fence verified by the last successful acquisition of this lease. */
  get lastAcquire(): GfsStoreWriterFenceAcceptance | undefined {
    return this.acceptance
  }

  private async acquireInternal(transition?: OperatorOwnershipTransition): Promise<void> {
    const priorOwner = GfsStoreWriterLease.localOwners.get(this.root)
    if (priorOwner) {
      let transient = priorOwner.inTransition
      try {
        if (!transient && priorOwner.verifiedMarker) {
          await priorOwner.verifyHeld()
          await priorOwner.verifyOwnershipPaths(priorOwner.verifiedMarker)
          transient = true
        }
      } catch {
        // Ambiguous or changed ownership is never a retry signal, unless the
        // owner started releasing while it was being checked.
        transient = priorOwner.inTransition
      }
      throw new GfsStoreWriterOwnershipError(
        'Writer already active',
        transient ? 'local_owner_active' : 'local_owner_ambiguous',
        'writer_locked',
        transient
      )
    }
    GfsStoreWriterLease.localOwners.set(this.root, this)
    this.localOwner = true
    this.inTransition = true
    this.acceptance = undefined
    let contentionMarker: string | undefined
    try {
      await transition?.assertPhysicalFenceHeld()
      this.rootHandle = await openPrivateStoreObject(
        this.root,
        'directory',
        constants.O_RDONLY,
        true,
        transition?.assertPhysicalFenceHeld
      )
      let marker: string | undefined
      try {
        this.markerHandle = await openPrivateStoreObject(
          this.markerPath,
          'file',
          transition ? constants.O_RDWR : constants.O_RDONLY,
          false
        )
        marker = await this.markerHandle.readFile('utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          throw new GfsStoreWriterOwnershipError(
            'Legacy or ambiguous writer fence',
            'fence_unreadable'
          )
      }
      if (transition) {
        const actual =
          marker === undefined ? 'absent' : createHash('sha256').update(marker).digest('hex')
        if (actual !== transition.expectedWriterFenceSha256)
          throw new GfsStoreWriterOwnershipError('Writer fence changed', 'fence_snapshot_changed')
      }
      const knownFence = marker === undefined ? undefined : parseKnownFence(marker)
      if (marker !== undefined && !knownFence && !transition)
        throw new GfsStoreWriterOwnershipError('Legacy or ambiguous writer fence', 'legacy_fence')
      if (marker === undefined && !this.allowBootstrap && !transition) {
        let ledgerExists = true
        try {
          await fs.lstat(path.join(this.root, 'ledger-v1.json'))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          ledgerExists = false
        }
        // Legacy empty execution leases were not durable. Absence of a lock
        // cannot prove their executor stopped; only a physical fence can.
        throw new GfsStoreWriterOwnershipError(
          'Operator transition required',
          ledgerExists ? 'missing_fence_with_ledger' : 'missing_fence_without_ledger',
          ledgerExists ? 'unsupported_store_schema' : 'corrupt_store_ledger'
        )
      }
      if (!knownFence) {
        await transition?.assertPhysicalFenceHeld()
        try {
          const created = await fs.open(
            this.databasePath,
            constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600
          )
          try {
            await transition?.assertPhysicalFenceHeld()
            await created.sync()
          } finally {
            await created.close()
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
      }
      // A missing/replaced database behind an existing fence is never recreated.
      try {
        this.databaseHandle = await openPrivateStoreObject(
          this.databasePath,
          'file',
          constants.O_RDWR,
          false
        )
      } catch (error) {
        if (knownFence && (error as NodeJS.ErrnoException).code === 'ENOENT')
          throw new GfsStoreWriterOwnershipError('Writer database missing', 'database_missing')
        throw error
      }
      const info = await this.databaseHandle.stat({ bigint: true })
      const databaseInode = String(info.ino)
      // The device is deliberately not compared: a persistent disk reattached
      // under another device node keeps its inodes. Live writers stay excluded
      // by BEGIN EXCLUSIVE and the descriptor/name identity checks below.
      if (knownFence && knownFence.databaseInode !== databaseInode)
        throw new GfsStoreWriterOwnershipError(
          'Writer database inode changed',
          'database_identity_changed'
        )
      if (knownFence && !transition) contentionMarker = marker
      await transition?.assertPhysicalFenceHeld()
      await this.databaseHandle.chmod(0o600)
      this.database = new Database(this.databasePath, { timeout: 0, fileMustExist: true })
      this.database.pragma('journal_mode = DELETE')
      this.database.exec('BEGIN EXCLUSIVE')
      // An accepted v2 or v3 fence is never rewritten; the normal-path marker
      // descriptor is read-only. Only a missing fence (bootstrap) or an operator
      // transition over a hashed legacy fence writes the v3 fence.
      const fence =
        knownFence && marker !== undefined
          ? marker
          : JSON.stringify({ schemaVersion: 3, ownership: OWNERSHIP, databaseInode })
      if (!knownFence) {
        await transition?.assertPhysicalFenceHeld()
        if (!this.markerHandle) {
          this.markerHandle = await fs.open(
            this.markerPath,
            constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600
          )
        }
        // Rewrite through the verified descriptor without unlinking the legacy
        // fence. A crash leaves its inode present, still excluding old binaries.
        const bytes = Buffer.from(fence)
        await transition?.assertPhysicalFenceHeld()
        await this.markerHandle.truncate(0)
        let offset = 0
        while (offset < bytes.length) {
          await transition?.assertPhysicalFenceHeld()
          const written = await this.markerHandle.write(
            bytes,
            offset,
            bytes.length - offset,
            offset
          )
          if (written.bytesWritten === 0) throw new Error('Writer fence write did not progress')
          offset += written.bytesWritten
        }
        await transition?.assertPhysicalFenceHeld()
        await this.markerHandle.truncate(bytes.length)
        await transition?.assertPhysicalFenceHeld()
        await this.markerHandle.sync()
      }
      await transition?.assertPhysicalFenceHeld()
      await this.markerHandle!.chmod(0o600)
      this.verifiedMarker = fence
      await this.verifyHeld()
      await transition?.assertPhysicalFenceHeld()
      await this.rootHandle.sync()
      this.acceptance = {
        fenceSchema: knownFence?.schemaVersion ?? 3,
        storedDevice: knownFence?.databaseDevice,
        currentDevice: String(info.dev),
      }
      this.inTransition = false
    } catch (error) {
      let transient = false
      if ((error as { code?: string }).code === 'SQLITE_BUSY' && contentionMarker) {
        try {
          await this.verifyOwnershipPaths(contentionMarker)
          transient = true
        } catch {
          /* A changed fence is permanent recovery state. */
        }
      }
      await this.release()
      if ((error as { code?: string }).code === 'SQLITE_BUSY')
        throw new GfsStoreWriterOwnershipError(
          'Writer already active',
          transient ? 'sqlite_busy_verified' : 'sqlite_busy_unverified',
          'writer_locked',
          transient
        )
      throw error
    }
  }

  assertHeld(): void {
    if (!this.localOwner || !this.database?.open || !this.database.inTransaction)
      throw new GfsStoreWriterOwnershipError('Writer ownership lost', 'ownership_lost')
  }

  async verifyHeld(): Promise<void> {
    this.assertHeld()
    if (!this.verifiedMarker)
      throw new GfsStoreWriterOwnershipError('Writer ownership lost', 'ownership_lost')
    await this.verifyOwnershipPaths(this.verifiedMarker)
    this.assertHeld()
  }

  private async verifyOwnershipPaths(expectedMarker: string): Promise<void> {
    for (const [filename, handle, kind] of [
      [this.root, this.rootHandle, 'directory'],
      [this.markerPath, this.markerHandle, 'file'],
      [this.databasePath, this.databaseHandle, 'file'],
    ] as const) {
      if (!handle) throw new GfsStoreWriterOwnershipError('Writer ownership lost', 'ownership_lost')
      const metadata = await handle.stat()
      const opened = await handle.stat({ bigint: true })
      const named = await fs.lstat(filename, { bigint: true })
      if (
        !isPrivateStoreStatTrusted(metadata, kind) ||
        named.isSymbolicLink() ||
        named.dev !== opened.dev ||
        named.ino !== opened.ino
      )
        throw new GfsStoreWriterOwnershipError('Writer inode changed', 'path_identity_changed')
    }
    if ((await fs.realpath(this.root)) !== this.root)
      throw new GfsStoreWriterOwnershipError('Writer path changed', 'root_path_changed')
    const marker = await openPrivateStoreObject(this.markerPath, 'file', constants.O_RDONLY, false)
    try {
      if ((await marker.readFile('utf8')) !== expectedMarker)
        throw new GfsStoreWriterOwnershipError('Writer fence changed', 'fence_changed')
    } finally {
      await marker.close()
    }
  }

  async release(): Promise<void> {
    // Closing the connection rolls back its lock-only transaction and releases
    // kernel ownership. No on-disk ownership inode is removed.
    this.inTransition = true
    this.database?.close()
    this.database = undefined
    this.verifiedMarker = undefined
    const outcomes = await Promise.allSettled([
      this.databaseHandle?.close(),
      this.markerHandle?.close(),
      this.rootHandle?.close(),
    ])
    this.databaseHandle = undefined
    this.markerHandle = undefined
    this.rootHandle = undefined
    if (this.localOwner && GfsStoreWriterLease.localOwners.get(this.root) === this)
      GfsStoreWriterLease.localOwners.delete(this.root)
    this.localOwner = false
    const failure = outcomes.find(outcome => outcome.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  }
}
