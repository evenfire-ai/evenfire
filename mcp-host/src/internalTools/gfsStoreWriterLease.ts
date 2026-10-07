import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { isPrivateStoreStatTrusted, openPrivateStoreObject } from './gfsStorePrivateFiles'

const OWNERSHIP = 'sqlite-exclusive-v1'

export class GfsStoreWriterOwnershipError extends Error {
  constructor(
    message: string,
    readonly reason:
      | 'writer_locked'
      | 'unsupported_store_schema'
      | 'corrupt_store_ledger' = 'writer_locked',
    readonly transientWriterContention = false
  ) {
    super(message)
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
      throw new GfsStoreWriterOwnershipError('Writer already active', 'writer_locked', transient)
    }
    GfsStoreWriterLease.localOwners.set(this.root, this)
    this.localOwner = true
    this.inTransition = true
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
          throw new GfsStoreWriterOwnershipError('Legacy or ambiguous writer fence')
      }
      if (transition) {
        const actual =
          marker === undefined ? 'absent' : createHash('sha256').update(marker).digest('hex')
        if (actual !== transition.expectedWriterFenceSha256)
          throw new GfsStoreWriterOwnershipError('Writer fence changed')
      }
      let knownV2 = false
      if (marker !== undefined) {
        try {
          const parsed = JSON.parse(marker) as { schemaVersion?: unknown; ownership?: unknown }
          knownV2 = parsed.schemaVersion === 2 && parsed.ownership === OWNERSHIP
        } catch {
          /* An operator can repair the exact hashed interrupted fence. */
        }
        if (!knownV2 && !transition)
          throw new GfsStoreWriterOwnershipError('Legacy or ambiguous writer fence')
      }
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
          ledgerExists ? 'unsupported_store_schema' : 'corrupt_store_ledger'
        )
      }
      if (!knownV2) {
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
      // A missing/replaced database behind an existing v2 fence is never recreated.
      this.databaseHandle = await openPrivateStoreObject(
        this.databasePath,
        'file',
        constants.O_RDWR,
        false
      )
      const info = await this.databaseHandle.stat({ bigint: true })
      const expectedMarker = JSON.stringify({
        schemaVersion: 2,
        ownership: OWNERSHIP,
        databaseDevice: String(info.dev),
        databaseInode: String(info.ino),
      })
      if (knownV2 && marker !== expectedMarker)
        throw new GfsStoreWriterOwnershipError('Writer database inode changed')
      if (knownV2 && !transition) contentionMarker = expectedMarker
      await transition?.assertPhysicalFenceHeld()
      await this.databaseHandle.chmod(0o600)
      this.database = new Database(this.databasePath, { timeout: 0, fileMustExist: true })
      this.database.pragma('journal_mode = DELETE')
      this.database.exec('BEGIN EXCLUSIVE')
      if (marker !== expectedMarker) {
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
        const bytes = Buffer.from(expectedMarker)
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
      this.verifiedMarker = expectedMarker
      await this.verifyHeld()
      await transition?.assertPhysicalFenceHeld()
      await this.rootHandle.sync()
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
        throw new GfsStoreWriterOwnershipError('Writer already active', 'writer_locked', transient)
      throw error
    }
  }

  assertHeld(): void {
    if (!this.localOwner || !this.database?.open || !this.database.inTransaction)
      throw new GfsStoreWriterOwnershipError('Writer ownership lost')
  }

  async verifyHeld(): Promise<void> {
    this.assertHeld()
    if (!this.verifiedMarker) throw new GfsStoreWriterOwnershipError('Writer ownership lost')
    await this.verifyOwnershipPaths(this.verifiedMarker)
    this.assertHeld()
  }

  private async verifyOwnershipPaths(expectedMarker: string): Promise<void> {
    for (const [filename, handle, kind] of [
      [this.root, this.rootHandle, 'directory'],
      [this.markerPath, this.markerHandle, 'file'],
      [this.databasePath, this.databaseHandle, 'file'],
    ] as const) {
      if (!handle) throw new GfsStoreWriterOwnershipError('Writer ownership lost')
      const metadata = await handle.stat()
      const opened = await handle.stat({ bigint: true })
      const named = await fs.lstat(filename, { bigint: true })
      if (
        !isPrivateStoreStatTrusted(metadata, kind) ||
        named.isSymbolicLink() ||
        named.dev !== opened.dev ||
        named.ino !== opened.ino
      )
        throw new GfsStoreWriterOwnershipError('Writer inode changed')
    }
    if ((await fs.realpath(this.root)) !== this.root)
      throw new GfsStoreWriterOwnershipError('Writer path changed')
    const marker = await openPrivateStoreObject(this.markerPath, 'file', constants.O_RDONLY, false)
    try {
      if ((await marker.readFile('utf8')) !== expectedMarker)
        throw new GfsStoreWriterOwnershipError('Writer fence changed')
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
