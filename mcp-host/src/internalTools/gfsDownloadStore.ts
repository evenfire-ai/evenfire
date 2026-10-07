import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { logger } from '../logger'
import type { GfsImageSource } from '../visualInput/policy'
import {
  recordGfsDownloadExpiry,
  recordGfsDownloadQuota,
  recordGfsInheritedQuarantinedRecords,
  recordGfsLegacyProcessingLeasesDiscarded,
} from './gfsDownloadMetrics'
import {
  GFS_FILE_LIMITS,
  GFS_HOST_ACTIVE_DOWNLOADS,
  GFS_HOST_RETAINED_FILES,
} from './gfsFilePolicy'
import { openPrivateStoreObject, verifyPrivateStoreDirectory } from './gfsStorePrivateFiles'
import { GfsStoreWriterLease, GfsStoreWriterOwnershipError } from './gfsStoreWriterLease'

export type GfsDownloadStoreErrorCode =
  | 'caller_mismatch'
  | 'caller_quota_exceeded'
  | 'corrupt_store_ledger'
  | 'download_expired'
  | 'download_missing'
  | 'download_busy'
  | 'host_quota_exceeded'
  | 'publication_cancelled'
  | 'storage_write_failed'
  | 'unsupported_store_schema'
  | 'workspace_unavailable'
  | 'writer_locked'

export class GfsDownloadStoreError extends Error {
  constructor(
    readonly code: GfsDownloadStoreErrorCode,
    readonly transientWriterContention = false
  ) {
    super(`GFS download store failed (${code})`)
    this.name = 'GfsDownloadStoreError'
  }
}

export interface GfsDownloadRecord {
  id: string
  callerIdentity: string
  source: GfsImageSource
  directory: string
  /** Caller-workspace-relative path safe for a model-visible receipt. */
  path: string
  /** Host-workspace-relative path used only inside the store. */
  hostPath: string
  sizeBytes: number
  sha256?: string
  createdAt: string
  expiresAt: string
  state: 'transferring' | 'completed' | 'missing' | 'cleanup_failed' | 'quarantined'
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

export interface StoreLedger {
  schemaVersion: 1
  records: Record<string, GfsDownloadRecord>
  /**
   * Legacy shell processing leases written before #1019. Still validated when
   * a ledger carries them, discarded at initialize, and never written again.
   */
  processingLeases?: Record<string, LegacyProcessingLeaseRecord>
  retentionOwners?: Record<string, GfsReceiptOwnerRecord>
}

interface LegacyProcessingLeaseRecord {
  leaseId: string
  callerIdentity: string
  recordIds: string[]
  acquiredAt: string
  expiresAt: string
  writerSessionId?: string
}

interface GfsReceiptOwnerRecord {
  ownerId: string
  callerIdentity: string
  writerSessionId: string
  recordIds: string[]
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHA256_RE = /^[0-9a-f]{64}$/

export function parseLedger(raw: string): StoreLedger {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new GfsDownloadStoreError('corrupt_store_ledger')
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    typeof (parsed as { records?: unknown }).records !== 'object' ||
    (parsed as { records: unknown }).records === null ||
    Array.isArray((parsed as { records: unknown }).records)
  )
    throw new GfsDownloadStoreError('corrupt_store_ledger')

  const records = (parsed as { records: Record<string, unknown> }).records
  const result: StoreLedger = {
    schemaVersion: 1,
    records: {},
    retentionOwners: {},
  }
  for (const [id, value] of Object.entries(records)) {
    if (!UUID_RE.test(id) || typeof value !== 'object' || value === null)
      throw new GfsDownloadStoreError('corrupt_store_ledger')
    const record = value as GfsDownloadRecord
    const source = record.source
    if (
      !UUID_RE.test(record.id) ||
      record.id !== id ||
      typeof record.callerIdentity !== 'string' ||
      record.callerIdentity.length === 0 ||
      typeof source?.kind !== 'string' ||
      source.kind !== 'gfs' ||
      typeof source.drive !== 'string' ||
      typeof source.resourceId !== 'string' ||
      typeof source.gfsUri !== 'string' ||
      typeof source.name !== 'string' ||
      !Number.isSafeInteger(source.version) ||
      source.version < 0 ||
      typeof record.directory !== 'string' ||
      path.isAbsolute(record.directory) ||
      record.directory.includes('..') ||
      record.directory !==
        path.join(
          path.dirname(path.dirname(record.directory)),
          '.gfs-downloads',
          `input-${record.id}`
        ) ||
      typeof record.path !== 'string' ||
      record.path !== path.join('.gfs-downloads', `input-${record.id}`, 'source') ||
      typeof record.hostPath !== 'string' ||
      record.hostPath !== path.join(record.directory, 'source') ||
      !Number.isSafeInteger(record.sizeBytes) ||
      record.sizeBytes < 0 ||
      !['transferring', 'completed', 'missing', 'cleanup_failed', 'quarantined'].includes(
        record.state
      ) ||
      (record.sha256 !== undefined && !SHA256_RE.test(record.sha256)) ||
      (record.state === 'completed' && !SHA256_RE.test(record.sha256 ?? '')) ||
      !Number.isFinite(Date.parse(record.createdAt)) ||
      !Number.isFinite(Date.parse(record.expiresAt))
    )
      throw new GfsDownloadStoreError('corrupt_store_ledger')
    result.records[id] = record
  }
  const rawProcessingLeases = (parsed as { processingLeases?: unknown }).processingLeases
  if (rawProcessingLeases !== undefined) {
    if (
      typeof rawProcessingLeases !== 'object' ||
      rawProcessingLeases === null ||
      Array.isArray(rawProcessingLeases)
    )
      throw new GfsDownloadStoreError('corrupt_store_ledger')
    result.processingLeases = {}
    for (const [id, value] of Object.entries(rawProcessingLeases)) {
      const lease = value as LegacyProcessingLeaseRecord
      if (
        !UUID_RE.test(id) ||
        typeof value !== 'object' ||
        value === null ||
        lease.leaseId !== id ||
        typeof lease.callerIdentity !== 'string' ||
        lease.callerIdentity.length === 0 ||
        !Array.isArray(lease.recordIds) ||
        lease.recordIds.some(recordId => !UUID_RE.test(recordId)) ||
        new Set(lease.recordIds).size !== lease.recordIds.length ||
        lease.recordIds.some(
          recordId => result.records[recordId]?.callerIdentity !== lease.callerIdentity
        ) ||
        (lease.writerSessionId !== undefined && !UUID_RE.test(lease.writerSessionId)) ||
        !Number.isFinite(Date.parse(lease.acquiredAt)) ||
        !Number.isFinite(Date.parse(lease.expiresAt)) ||
        Date.parse(lease.expiresAt) <= Date.parse(lease.acquiredAt)
      )
        throw new GfsDownloadStoreError('corrupt_store_ledger')
      result.processingLeases[id] = lease
    }
  }
  const owners = (parsed as { retentionOwners?: unknown }).retentionOwners
  if (owners !== undefined) {
    if (typeof owners !== 'object' || owners === null || Array.isArray(owners))
      throw new GfsDownloadStoreError('corrupt_store_ledger')
    for (const [ownerId, value] of Object.entries(owners)) {
      if (typeof value !== 'object' || value === null)
        throw new GfsDownloadStoreError('corrupt_store_ledger')
      const owner = value as GfsReceiptOwnerRecord
      if (
        !validReceiptOwnerId(ownerId) ||
        owner.ownerId !== ownerId ||
        typeof owner.callerIdentity !== 'string' ||
        owner.callerIdentity.length === 0 ||
        !UUID_RE.test(owner.writerSessionId) ||
        !Array.isArray(owner.recordIds) ||
        new Set(owner.recordIds).size !== owner.recordIds.length ||
        owner.recordIds.some(
          id => !UUID_RE.test(id) || result.records[id]?.callerIdentity !== owner.callerIdentity
        )
      )
        throw new GfsDownloadStoreError('corrupt_store_ledger')
      result.retentionOwners![ownerId] = owner
    }
  }
  return result
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

interface Usage {
  bytes: number
  files: number
  callerBytes: Record<string, number>
  callerFiles: Record<string, number>
}

function isWithinDirectory(child: string, parent: string): boolean {
  const relative = path.relative(parent, child)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function usageFor(records: Iterable<GfsDownloadRecord>): Usage {
  const usage: Usage = {
    bytes: 0,
    files: 0,
    callerBytes: Object.create(null) as Record<string, number>,
    callerFiles: Object.create(null) as Record<string, number>,
  }
  for (const record of records) {
    usage.bytes += record.sizeBytes
    usage.files += 1
    usage.callerBytes[record.callerIdentity] =
      (usage.callerBytes[record.callerIdentity] ?? 0) + record.sizeBytes
    usage.callerFiles[record.callerIdentity] = (usage.callerFiles[record.callerIdentity] ?? 0) + 1
  }
  return usage
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

/** One Host/PVC-owned durable store; task registries receive bound handles. */
export class GfsDownloadStore {
  private hostRoot: string
  private readonly requestedHostRoot: string
  private storeRoot: string
  private ledgerPath: string
  private writerLease?: GfsStoreWriterLease
  private writerSessionId = randomUUID()
  private ledger: StoreLedger = {
    schemaVersion: 1,
    records: {},
    retentionOwners: {},
  }
  private readonly activeByCaller = new Map<string, number>()
  private readonly activeIds = new Set<string>()
  private active = 0
  private mutationTail = Promise.resolve()
  private initialized = false
  private closing = false
  private unsafe = false

  constructor(hostRoot: string) {
    this.hostRoot = path.resolve(hostRoot)
    this.requestedHostRoot = this.hostRoot
    this.storeRoot = path.join(this.hostRoot, '.gfs-download-store')
    this.ledgerPath = path.join(this.storeRoot, 'ledger-v1.json')
  }

  isAvailable(): boolean {
    if (!this.initialized || this.unsafe || !this.writerLease) return false
    try {
      this.writerLease.assertHeld()
      return true
    } catch {
      return false
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    await fs.mkdir(this.hostRoot, { recursive: true, mode: 0o700 })
    const requestedHostInfo = await fs.lstat(this.hostRoot)
    if (!requestedHostInfo.isDirectory() || requestedHostInfo.isSymbolicLink())
      throw new GfsDownloadStoreError('workspace_unavailable')
    this.hostRoot = await fs.realpath(this.hostRoot)
    this.storeRoot = path.join(this.hostRoot, '.gfs-download-store')
    this.ledgerPath = path.join(this.storeRoot, 'ledger-v1.json')
    const hostInfo = await fs.lstat(this.hostRoot)
    if (!hostInfo.isDirectory() || hostInfo.isSymbolicLink())
      throw new GfsDownloadStoreError('workspace_unavailable')
    // Exclusive, non-recursive creation distinguishes a genuinely new store
    // directory from one that already existed. The host root above is created
    // recursively, so only the store directory itself is probed here.
    let createdStoreRoot = false
    try {
      await fs.mkdir(this.storeRoot, { mode: 0o700 })
      createdStoreRoot = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    try {
      await verifyPrivateStoreDirectory(this.storeRoot)
    } catch {
      throw new GfsDownloadStoreError('workspace_unavailable')
    }

    await this.acquireWriterLease(createdStoreRoot)
    this.writerSessionId = randomUUID()
    let raw: string | undefined
    try {
      try {
        const handle = await openPrivateStoreObject(
          this.ledgerPath,
          'file',
          constants.O_RDONLY,
          false
        )
        try {
          raw = await handle.readFile('utf8')
          parseLedger(raw)
          await handle.chmod(0o600)
        } finally {
          await handle.close()
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (raw !== undefined) {
        // A successful read must always parse, including empty content, so a
        // truncated ledger fails closed.
        this.ledger = parseLedger(raw)
        await this.discardLegacyProcessingLeases()
        this.reportInheritedQuarantine()
      } else if (createdStoreRoot) {
        // Genuinely new store directory: make the durable schema-1 ledger exist
        // before reconciliation or any transfer exposure, so a ledger missing
        // later is unambiguously unknown state.
        await this.persist()
      } else {
        // The directory already existed with no durable ledger: a lost ledger
        // or an interrupted first creation. Both are unknown state. Fail closed
        // for operator recovery instead of silently resetting quota.
        throw new GfsDownloadStoreError('corrupt_store_ledger')
      }
      await this.reconcile()
      this.initialized = true
      await this.cleanupExpired()
      await this.persist()
    } catch (error) {
      this.initialized = false
      await this.releaseWriterLease()
      throw error
    }
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
    this.assertInitialized()
    if (this.closing) throw new GfsDownloadStoreError('download_busy')
    if (
      !Number.isSafeInteger(input.sizeBytes) ||
      input.sizeBytes < 0 ||
      input.sizeBytes > GFS_FILE_LIMITS.maxFileBytes
    )
      throw new GfsDownloadStoreError('host_quota_exceeded')

    if (typeof input.callerIdentity !== 'string' || input.callerIdentity.length === 0)
      throw new GfsDownloadStoreError('caller_mismatch')
    if (!Number.isFinite(Date.parse(input.expiresAt)))
      throw new GfsDownloadStoreError('corrupt_store_ledger')
    const callerRoot = await this.validateCallerRoot(input.callerWorkspacePath)
    const id = randomUUID()
    const relativeDirectory = path.join(
      path.relative(this.hostRoot, callerRoot),
      '.gfs-downloads',
      `input-${id}`
    )
    const absoluteDirectory = path.join(this.hostRoot, relativeDirectory)
    const hostPath = path.join(relativeDirectory, 'source')
    const callerPath = path.relative(callerRoot, path.join(this.hostRoot, hostPath))
    const record: GfsDownloadRecord = {
      id,
      callerIdentity: input.callerIdentity,
      source: input.source,
      directory: relativeDirectory,
      path: callerPath,
      hostPath,
      sizeBytes: input.sizeBytes,
      createdAt: new Date().toISOString(),
      expiresAt: input.expiresAt,
      state: 'transferring',
    }

    await this.serialize(async () => {
      this.assertInitialized()
      if (this.closing) throw new GfsDownloadStoreError('download_busy')
      if (this.active >= GFS_HOST_ACTIVE_DOWNLOADS) {
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
      if (input.retentionOwnerId !== undefined)
        this.assertReceiptOwner(input.retentionOwnerId, input.callerIdentity)
      await this.assertPhysicalCapacity(input.sizeBytes)
      await this.reclaimForAdmission(input.callerIdentity, input.sizeBytes)
      const denial = this.quotaDenial(input.callerIdentity, input.sizeBytes)
      if (denial) {
        recordGfsDownloadQuota(denial.scope, denial.reason)
        throw new GfsDownloadStoreError(
          denial.scope === 'host' ? 'host_quota_exceeded' : 'caller_quota_exceeded'
        )
      }
      await this.assertPhysicalCapacity(input.sizeBytes)

      const previousOwner =
        input.retentionOwnerId === undefined
          ? undefined
          : this.ledger.retentionOwners?.[input.retentionOwnerId]
      try {
        if (input.retentionOwnerId !== undefined)
          this.retainReceiptRecord(record, input.retentionOwnerId)
        this.ledger.records[id] = record
        await this.persist()
      } catch (error) {
        // No filesystem transfer or worker has been exposed. In-memory
        // admission rolls back; an uncertain durable write stays fail-closed.
        delete this.ledger.records[id]
        if (input.retentionOwnerId !== undefined) {
          if (previousOwner) this.ledger.retentionOwners![input.retentionOwnerId] = previousOwner
          else delete this.ledger.retentionOwners![input.retentionOwnerId]
        }
        throw error
      }
      this.active += 1
      this.activeIds.add(id)
      this.activeByCaller.set(
        input.callerIdentity,
        (this.activeByCaller.get(input.callerIdentity) ?? 0) + 1
      )
      return undefined
    })

    try {
      await this.assertWriterOwnership()
      const cacheRoot = path.dirname(absoluteDirectory)
      try {
        await fs.mkdir(cacheRoot, { mode: 0o700 })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      await verifyPrivateStoreDirectory(cacheRoot)
      await fs.mkdir(absoluteDirectory, { mode: 0o700 })
      await this.verifyManagedDirectory(record)
      const partial = await fs.open(
        path.join(this.hostRoot, `${record.hostPath}.partial`),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      )
      await partial.close()
    } catch (error) {
      try {
        await this.serialize(async () => {
          record.state = 'cleanup_failed'
          // The producer's new pin has never exposed a transfer or receipt, so
          // proven absence rolls it back. Delete/prove absence before
          // releasing the durable reservation.
          if (!(await this.removeRecordDirectory(record))) {
            await this.persist()
            throw new GfsDownloadStoreError('storage_write_failed')
          }
          await this.releaseRecordCharge(record)
        })
      } finally {
        this.releaseActive(record)
      }
      if (error instanceof GfsDownloadStoreError) throw error
      throw new GfsDownloadStoreError('storage_write_failed')
    }

    const callerPartialPath = `${record.path}.partial`
    return {
      id,
      path: record.path,
      partialPath: callerPartialPath,
      sizeBytes: input.sizeBytes,
      expiresAt: input.expiresAt,
    }
  }

  async publish(
    id: string,
    callerIdentity: string,
    sha256: string,
    publication?: { signal?: AbortSignal; deadlineMs?: number }
  ): Promise<GfsDownloadReceipt> {
    this.assertInitialized()
    const record = this.record(id)
    const receipt = await this.serialize(async () => {
      if (record.callerIdentity !== callerIdentity)
        throw new GfsDownloadStoreError('caller_mismatch')
      if (!SHA256_RE.test(sha256)) throw new GfsDownloadStoreError('corrupt_store_ledger')
      if (record.state !== 'transferring') throw new GfsDownloadStoreError('download_missing')
      if (Date.parse(record.expiresAt) <= Date.now())
        throw new GfsDownloadStoreError('download_expired')
      const partial = path.join(this.hostRoot, `${record.hostPath}.partial`)
      const source = path.join(this.hostRoot, record.hostPath)
      await this.verifyManagedDirectory(record)
      const partialHandle = await openPrivateStoreObject(
        partial,
        'file',
        constants.O_RDONLY,
        false
      ).catch(() => undefined)
      if (!partialHandle) throw new GfsDownloadStoreError('download_missing')
      let renamed = false
      try {
        const info = await partialHandle.stat()
        if (!info.isFile() || info.isSymbolicLink() || info.size !== record.sizeBytes)
          throw new GfsDownloadStoreError('download_missing')
        if (
          (await sha256FileHandle(partialHandle, () => this.assertPublicationOpen(publication))) !==
          sha256
        )
          throw new GfsDownloadStoreError('corrupt_store_ledger')
        // A finished rename is not a publication. The journal commit below is.
        this.assertPublicationOpen(publication)
        const named = await fs.lstat(partial)
        if (named.isSymbolicLink() || named.dev !== info.dev || named.ino !== info.ino)
          throw new GfsDownloadStoreError('download_missing')
        await partialHandle.chmod(0o600)
        await this.assertWriterOwnership()
        await fs.rename(partial, source)
        renamed = true
      } finally {
        await partialHandle.close()
      }
      if (!renamed) throw new GfsDownloadStoreError('download_missing')
      await syncDirectory(path.dirname(source))
      this.assertPublicationOpen(publication)
      record.state = 'completed'
      record.sha256 = sha256
      try {
        await this.persist(publication)
        this.assertPublicationOpen(publication)
      } catch (error) {
        // Publication is not observable outside this serialized operation until
        // its journal has settled. Cancellation restores charged, unreadable
        // transfer state even when it arrives during the atomic journal commit.
        record.state = 'transferring'
        delete record.sha256
        if (error instanceof GfsDownloadStoreError && error.code === 'publication_cancelled')
          await this.persist()
        throw error
      }
      return {
        id,
        source: record.source,
        path: record.path,
        sizeBytes: record.sizeBytes,
        sha256,
        expiresAt: record.expiresAt,
      }
    })
    this.releaseActive(record)
    return receipt
  }

  /** Reuse only after the caller has freshly authorized this exact source version. */
  async reusableReceipt(
    callerIdentity: string,
    source: GfsImageSource,
    sizeBytes: number,
    bounds?: { signal?: AbortSignal; deadlineMs?: number; retentionOwnerId?: string }
  ): Promise<GfsDownloadReceipt | undefined> {
    this.assertInitialized()
    return this.serialize(async () => {
      this.assertPublicationOpen(bounds)
      if (bounds?.retentionOwnerId !== undefined)
        this.assertReceiptOwner(bounds.retentionOwnerId, callerIdentity, true)
      const record = Object.values(this.ledger.records).find(
        item =>
          item.callerIdentity === callerIdentity &&
          item.state === 'completed' &&
          Date.parse(item.expiresAt) > Date.now() &&
          item.sizeBytes === sizeBytes &&
          item.source.drive === source.drive &&
          item.source.resourceId === source.resourceId &&
          item.source.version === source.version &&
          item.sha256 !== undefined
      )
      if (!record) return undefined
      const unavailable = async (): Promise<undefined> => {
        record.state = 'missing'
        delete record.sha256
        await this.persist()
        return undefined
      }
      const handle = await this.openRecordContent(record).catch(() => undefined)
      if (!handle) return unavailable()
      try {
        const info = await handle.stat()
        if (!info.isFile() || info.size !== sizeBytes || (info.mode & 0o777) !== 0o600)
          return unavailable()
        if (
          (await sha256FileHandle(handle, () => this.assertPublicationOpen(bounds))) !==
          record.sha256
        )
          return unavailable()
      } finally {
        await handle.close()
      }
      this.assertPublicationOpen(bounds)
      if (bounds?.retentionOwnerId !== undefined) {
        const previousOwner = this.ledger.retentionOwners?.[bounds.retentionOwnerId]
        this.retainReceiptRecord(record, bounds.retentionOwnerId, true)
        try {
          await this.persist(bounds)
        } catch (error) {
          if (previousOwner) this.ledger.retentionOwners![bounds.retentionOwnerId] = previousOwner
          else delete this.ledger.retentionOwners![bounds.retentionOwnerId]
          throw error
        }
      }
      return {
        id: record.id,
        source,
        path: record.path,
        sizeBytes: record.sizeBytes,
        sha256: record.sha256!,
        expiresAt: record.expiresAt,
      }
    })
  }

  async fail(id: string, callerIdentity: string): Promise<void> {
    const record = this.record(id)
    if (record.callerIdentity !== callerIdentity) throw new GfsDownloadStoreError('caller_mismatch')
    if (!this.activeIds.has(id) && record.state !== 'cleanup_failed')
      throw new GfsDownloadStoreError('download_busy')
    try {
      this.assertInitialized()
      await this.serialize(async () => {
        this.assertInitialized()
        if (record.callerIdentity !== callerIdentity)
          throw new GfsDownloadStoreError('caller_mismatch')
        // Publication or another admission may have settled while this waited.
        if (
          (!this.activeIds.has(id) && record.state !== 'cleanup_failed') ||
          record.state === 'completed'
        )
          throw new GfsDownloadStoreError('download_busy')
        record.state = 'cleanup_failed'
        if (this.hasReceiptOwner(id)) {
          await this.persist()
          return
        }
        if (!(await this.removeRecordDirectory(record))) {
          await this.persist()
          throw new GfsDownloadStoreError('storage_write_failed')
        }
        await this.releaseRecordCharge(record)
      })
    } finally {
      // The caller invokes failure only after its stream/descriptor is settled.
      // Uncertain bytes stay charged.
      this.releaseActive(record)
    }
  }
  async inspect(
    callerRelativePath: string,
    callerIdentity: string
  ): Promise<GfsDownloadReceipt & { id: string }> {
    this.assertInitialized()
    const record = Object.values(this.ledger.records).find(
      item => item.callerIdentity === callerIdentity && item.path === callerRelativePath
    )
    if (!record) throw new GfsDownloadStoreError('caller_mismatch')
    if (Date.parse(record.expiresAt) <= Date.now())
      throw new GfsDownloadStoreError('download_expired')
    if (record.state !== 'completed' || !record.sha256)
      throw new GfsDownloadStoreError('download_missing')
    const handle = await this.openRecordContent(record).catch(() => undefined)
    if (!handle) throw new GfsDownloadStoreError('download_missing')
    let digestValid = false
    try {
      const info = await handle.stat()
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size !== record.sizeBytes ||
        (info.mode & 0o777) !== 0o600
      )
        throw new GfsDownloadStoreError('download_missing')
      const digest = createHash('sha256')
      const chunk = Buffer.alloc(64 * 1024)
      let position = 0
      for (;;) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, position)
        if (bytesRead === 0) break
        digest.update(chunk.subarray(0, bytesRead))
        position += bytesRead
      }
      digestValid = digest.digest('hex') === record.sha256
    } finally {
      await handle.close()
    }
    if (!digestValid) throw new GfsDownloadStoreError('download_missing')
    return {
      id: record.id,
      source: record.source,
      path: record.path,
      sizeBytes: record.sizeBytes,
      sha256: record.sha256,
      expiresAt: record.expiresAt,
    }
  }

  async readManagedFile(callerRelativePath: string, callerIdentity: string): Promise<Buffer> {
    this.assertInitialized()
    const record = Object.values(this.ledger.records).find(
      item => item.callerIdentity === callerIdentity && item.path === callerRelativePath
    )
    if (!record) throw new GfsDownloadStoreError('caller_mismatch')
    if (Date.parse(record.expiresAt) <= Date.now())
      throw new GfsDownloadStoreError('download_expired')
    if (record.state !== 'completed' || !record.sha256)
      throw new GfsDownloadStoreError('download_missing')

    const handle = await this.openRecordContent(record).catch(() => undefined)
    if (!handle) throw new GfsDownloadStoreError('download_missing')
    let bytes: Buffer
    try {
      const info = await handle.stat()
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size !== record.sizeBytes ||
        (info.mode & 0o777) !== 0o600
      )
        throw new GfsDownloadStoreError('download_missing')
      bytes = Buffer.alloc(record.sizeBytes)
      let offset = 0
      while (offset < record.sizeBytes) {
        const { bytesRead } = await handle.read(bytes, offset, record.sizeBytes - offset, offset)
        if (bytesRead <= 0) throw new GfsDownloadStoreError('download_missing')
        offset += bytesRead
      }
      const probe = Buffer.alloc(1)
      const extra = await handle.read(probe, 0, 1, record.sizeBytes)
      if (extra.bytesRead !== 0) throw new GfsDownloadStoreError('download_missing')
    } finally {
      await handle.close()
    }
    if (createHash('sha256').update(bytes).digest('hex') !== record.sha256)
      throw new GfsDownloadStoreError('download_missing')
    return bytes
  }

  async readManagedFilePrefix(
    callerRelativePath: string,
    callerIdentity: string,
    prefixBytes = 16
  ): Promise<Buffer> {
    this.assertInitialized()
    if (!Number.isSafeInteger(prefixBytes) || prefixBytes <= 0 || prefixBytes > 4096)
      throw new GfsDownloadStoreError('corrupt_store_ledger')
    const record = Object.values(this.ledger.records).find(
      item => item.callerIdentity === callerIdentity && item.path === callerRelativePath
    )
    if (!record) throw new GfsDownloadStoreError('caller_mismatch')
    if (Date.parse(record.expiresAt) <= Date.now())
      throw new GfsDownloadStoreError('download_expired')
    if (record.state !== 'completed' || !record.sha256)
      throw new GfsDownloadStoreError('download_missing')

    const handle = await this.openRecordContent(record).catch(() => undefined)
    if (!handle) throw new GfsDownloadStoreError('download_missing')
    try {
      const info = await handle.stat()
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size !== record.sizeBytes ||
        (info.mode & 0o777) !== 0o600
      )
        throw new GfsDownloadStoreError('download_missing')
      const prefix = Buffer.alloc(prefixBytes)
      const { bytesRead } = await handle.read(prefix, 0, prefix.byteLength, 0)
      return prefix.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
  }

  /** Caller/task lifecycle must prove consumer settlement before invoking this. */
  async releaseReceiptOwner(ownerId: string, callerIdentity: string): Promise<void> {
    this.assertInitialized()
    await this.serialize(async () => {
      const owner = this.ledger.retentionOwners?.[ownerId]
      if (!owner) return
      if (owner.callerIdentity !== callerIdentity)
        throw new GfsDownloadStoreError('caller_mismatch')
      delete this.ledger.retentionOwners![ownerId]
      try {
        await this.persist()
      } catch (error) {
        this.ledger.retentionOwners![ownerId] = owner
        throw error
      }
      await this.cleanupSettledFailedTransfers(callerIdentity)
    })
  }

  private assertReceiptOwner(
    ownerId: string,
    callerIdentity: string,
    allowPriorOwner = false
  ): void {
    if (!validReceiptOwnerId(ownerId)) throw new GfsDownloadStoreError('caller_mismatch')
    const existing = this.ledger.retentionOwners?.[ownerId]
    if (existing && existing.callerIdentity !== callerIdentity)
      throw new GfsDownloadStoreError('caller_mismatch')
    if (existing && existing.writerSessionId !== this.writerSessionId && !allowPriorOwner)
      throw new GfsDownloadStoreError('download_busy')
  }

  private retainReceiptRecord(
    record: GfsDownloadRecord,
    ownerId: string,
    allowPriorOwner = false
  ): void {
    this.assertReceiptOwner(ownerId, record.callerIdentity, allowPriorOwner)
    this.ledger.retentionOwners ??= {}
    const existing = this.ledger.retentionOwners[ownerId]
    this.ledger.retentionOwners[ownerId] = {
      ownerId,
      callerIdentity: record.callerIdentity,
      writerSessionId: this.writerSessionId,
      recordIds: [...new Set([...(existing?.recordIds ?? []), record.id])],
    }
  }

  private forgetReceiptRecord(recordId: string): void {
    for (const [ownerId, owner] of Object.entries(this.ledger.retentionOwners ?? {})) {
      const recordIds = owner.recordIds.filter(id => id !== recordId)
      if (recordIds.length === 0) delete this.ledger.retentionOwners![ownerId]
      else this.ledger.retentionOwners![ownerId] = { ...owner, recordIds }
    }
  }

  private hasReceiptOwner(recordId: string): boolean {
    return Object.values(this.ledger.retentionOwners ?? {}).some(owner =>
      owner.recordIds.includes(recordId)
    )
  }

  private hasLiveReceiptOwners(): boolean {
    return Object.values(this.ledger.retentionOwners ?? {}).some(
      owner => owner.writerSessionId === this.writerSessionId
    )
  }

  debugRecord(id: string): GfsDownloadRecord | undefined {
    return this.ledger.records[id]
  }

  debugUsage(): Usage {
    return usageFor(Object.values(this.ledger.records))
  }

  async debugPersist(): Promise<void> {
    await this.persist()
  }

  async close(drainTimeoutMs = 5_000): Promise<void> {
    if (!this.initialized) return
    this.closing = true
    const deadline = Date.now() + drainTimeoutMs
    while ((this.activeIds.size > 0 || this.hasLiveReceiptOwners()) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    if (this.activeIds.size > 0 || this.hasLiveReceiptOwners()) {
      this.closing = false
      throw new GfsDownloadStoreError('download_busy')
    }
    await this.mutationTail
    // Work already queued before shutdown can finish admission while close
    // waits. Never release writer ownership over a newly active operation.
    if (this.activeIds.size > 0 || this.hasLiveReceiptOwners()) {
      this.closing = false
      throw new GfsDownloadStoreError('download_busy')
    }
    try {
      await this.serialize(async () => {
        await this.persist()
      })
    } finally {
      this.initialized = false
      await this.releaseWriterLease()
      this.closing = false
    }
  }

  async cleanupExpired(now = Date.now()): Promise<void> {
    this.assertInitialized()
    try {
      await this.serialize(async () => {
        for (const record of Object.values(this.ledger.records)) {
          if (
            Date.parse(record.expiresAt) > now ||
            this.activeIds.has(record.id) ||
            this.hasReceiptOwner(record.id) ||
            record.state === 'quarantined'
          )
            continue
          if (await this.removeRecordDirectory(record)) {
            await this.releaseRecordCharge(record)
            recordGfsDownloadExpiry('expired_removed')
          } else {
            record.state = 'cleanup_failed'
            await this.persist()
            recordGfsDownloadExpiry('cleanup_failed')
          }
        }
      })
    } catch (error) {
      recordGfsDownloadExpiry('sweep_failed')
      throw error
    }
  }

  private async cleanupSettledFailedTransfers(callerIdentity: string): Promise<void> {
    for (const record of Object.values(this.ledger.records)) {
      if (
        record.callerIdentity !== callerIdentity ||
        record.state !== 'cleanup_failed' ||
        this.activeIds.has(record.id) ||
        this.hasReceiptOwner(record.id)
      )
        continue
      if (await this.removeRecordDirectory(record)) await this.releaseRecordCharge(record)
    }
  }

  private async assertPhysicalCapacity(sizeBytes: number): Promise<void> {
    const space = await fs.statfs(this.storeRoot, { bigint: true })
    if (space.bsize <= 0n || space.bavail < 0n) {
      recordGfsDownloadQuota('host', 'free_space')
      throw new GfsDownloadStoreError('host_quota_exceeded')
    }
    const reserve = (bytes: number): bigint => {
      const amount = BigInt(bytes)
      return ((amount + space.bsize - 1n) / space.bsize) * space.bsize
    }
    let required = reserve(sizeBytes) + 16n * 1024n * 1024n
    for (const id of this.activeIds) {
      const record = this.ledger.records[id]
      // Use the full outstanding reservation rather than optimistically
      // crediting sparse, shared or concurrently written physical allocation.
      if (record && record.state !== 'completed') required += reserve(record.sizeBytes)
    }
    // Allocated/apparent cache bytes are not proven freeable bytes on shared,
    // reflink or snapshot filesystems. Require currently verified free capacity
    // before any destructive quota reclaim, then measure it again afterward.
    if (space.bavail * space.bsize < required) {
      recordGfsDownloadQuota('host', 'free_space')
      throw new GfsDownloadStoreError('host_quota_exceeded')
    }
  }

  private quotaDenial(
    callerIdentity: string,
    sizeBytes: number,
    records: Iterable<GfsDownloadRecord> = Object.values(this.ledger.records)
  ): { scope: 'host' | 'caller'; reason: 'storage_bytes' | 'retained_files' } | undefined {
    const usage = usageFor(records)
    // Prove caller admission before considering eviction of another caller.
    if ((usage.callerBytes[callerIdentity] ?? 0) + sizeBytes > GFS_FILE_LIMITS.callerStorageBytes)
      return { scope: 'caller', reason: 'storage_bytes' }
    if ((usage.callerFiles[callerIdentity] ?? 0) >= GFS_FILE_LIMITS.callerRetainedFiles)
      return { scope: 'caller', reason: 'retained_files' }
    if (usage.bytes + sizeBytes > GFS_FILE_LIMITS.storageBytes)
      return { scope: 'host', reason: 'storage_bytes' }
    if (usage.files >= GFS_HOST_RETAINED_FILES) return { scope: 'host', reason: 'retained_files' }
    return undefined
  }

  /** Retention is an upper bound; verified, unused completed copies are a cache. */
  private async reclaimForAdmission(callerIdentity: string, sizeBytes: number): Promise<void> {
    if (!this.quotaDenial(callerIdentity, sizeBytes)) return
    const candidates = Object.values(this.ledger.records)
      .filter(
        record =>
          record.state === 'completed' &&
          !this.activeIds.has(record.id) &&
          !this.hasReceiptOwner(record.id)
      )
      .sort(
        (left, right) =>
          Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
          left.id.localeCompare(right.id)
      )
    const verified: GfsDownloadRecord[] = []
    for (const record of candidates) {
      try {
        await this.verifyRecordContent(record)
        verified.push(record)
      } catch {
        // Corrupt or inaccessible content is not a safe eviction candidate.
      }
    }
    const remaining = new Map(Object.values(this.ledger.records).map(record => [record.id, record]))
    const plan: GfsDownloadRecord[] = []
    for (;;) {
      const denial = this.quotaDenial(callerIdentity, sizeBytes, remaining.values())
      if (!denial) break
      const next = verified.find(
        record =>
          remaining.has(record.id) &&
          (denial.scope === 'host' || record.callerIdentity === callerIdentity)
      )
      // No feasible complete plan means no destructive cache-pressure effects.
      if (!next) return
      remaining.delete(next.id)
      plan.push(next)
    }
    await this.assertPhysicalCapacity(sizeBytes)
    for (const record of plan) {
      if (!(await this.removeRecordDirectory(record))) continue
      await this.releaseRecordCharge(record)
    }
  }

  private async releaseRecordCharge(record: GfsDownloadRecord): Promise<void> {
    const previousOwners = this.ledger.retentionOwners
    this.ledger.retentionOwners = { ...previousOwners }
    this.forgetReceiptRecord(record.id)
    delete this.ledger.records[record.id]
    try {
      await this.persist()
    } catch (error) {
      this.ledger.records[record.id] = record
      this.ledger.retentionOwners = previousOwners
      throw error
    }
  }

  private async removeRecordDirectory(record: GfsDownloadRecord): Promise<boolean> {
    await this.assertWriterOwnership()
    const directory = path.join(this.hostRoot, record.directory)
    try {
      await this.verifyManagedDirectory(record)
      await fs.rm(directory, { recursive: true, force: true })
      // A successful rm alone is not proof that a racing replacement is absent.
      await fs.lstat(directory)
      return false
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT'
    }
  }

  private async verifyManagedDirectory(record: GfsDownloadRecord): Promise<void> {
    const directory = path.join(this.hostRoot, record.directory)
    if (!isWithinDirectory(directory, this.hostRoot))
      throw new GfsDownloadStoreError('workspace_unavailable')
    if (
      (await fs.realpath(path.dirname(path.dirname(directory)))) !==
      path.dirname(path.dirname(directory))
    )
      throw new GfsDownloadStoreError('workspace_unavailable')
    await verifyPrivateStoreDirectory(path.dirname(directory))
    await verifyPrivateStoreDirectory(directory)
  }

  private async openRecordContent(record: GfsDownloadRecord): Promise<fs.FileHandle> {
    await this.verifyManagedDirectory(record)
    const handle = await openPrivateStoreObject(
      path.join(this.hostRoot, record.hostPath),
      'file',
      constants.O_RDONLY,
      false
    )
    try {
      const info = await handle.stat()
      if (info.size !== record.sizeBytes) throw new GfsDownloadStoreError('download_missing')
      if ((info.mode & 0o7777) !== 0o600) {
        if (!record.sha256 || (await sha256FileHandle(handle)) !== record.sha256)
          throw new GfsDownloadStoreError('download_missing')
        await handle.chmod(0o600)
      }
      return handle
    } catch (error) {
      await handle.close()
      throw error
    }
  }

  private async verifyRecordContent(record: GfsDownloadRecord): Promise<void> {
    const handle = await this.openRecordContent(record)
    try {
      if (!record.sha256 || (await sha256FileHandle(handle)) !== record.sha256)
        throw new GfsDownloadStoreError('download_missing')
    } finally {
      await handle.close()
    }
  }

  /**
   * #1019: shell_exec no longer holds processing leases, so no lease in a
   * ledger written by an earlier build protects an executor of this boot. A
   * lease left by a crashed Host would otherwise fence the store forever. The
   * field is removed durably before reconciliation; the warning and the
   * counter are emitted only after that removal is persisted, so a failed
   * persist leaves the ledger untouched and initialize rejects.
   */
  private async discardLegacyProcessingLeases(): Promise<void> {
    const legacy = this.ledger.processingLeases
    if (legacy === undefined) return
    const discarded = Object.keys(legacy).length
    delete this.ledger.processingLeases
    // An empty legacy map is dropped by the final initialize persist.
    if (discarded === 0) return
    try {
      await this.persist()
    } catch (error) {
      this.ledger.processingLeases = legacy
      throw error
    }
    logger.warn(
      { discarded },
      `GFS download store discarded ${discarded} legacy processing lease(s) at initialize`
    )
    recordGfsLegacyProcessingLeasesDiscarded(discarded)
  }

  /**
   * Records an earlier boot quarantined stay charged to quota (`usageFor`).
   * They are reported so an operator can recover them; this boot never
   * reuses or deletes them.
   */
  private reportInheritedQuarantine(): void {
    const quarantined = Object.values(this.ledger.records).filter(
      record => record.state === 'quarantined'
    ).length
    if (quarantined === 0) return
    logger.warn(
      { quarantined },
      `GFS download store found ${quarantined} record(s) quarantined by an earlier boot; they stay charged to quota until operator recovery`
    )
    recordGfsInheritedQuarantinedRecords(quarantined)
  }

  private async reconcile(): Promise<void> {
    for (const record of Object.values(this.ledger.records)) {
      // Kernel ownership recovery proves only the previous Host writer exited.
      // Unfinished/uncertain transfers stay charged. A completed copy is reused
      // only after its content re-verifies: a shell command can have altered it
      // (#1019 accepted risk), and an altered copy is quarantined.
      if (record.state !== 'completed') {
        record.state = 'quarantined'
        continue
      }
      try {
        await this.verifyRecordContent(record)
      } catch {
        record.state = 'quarantined'
      }
    }
  }

  private async persist(publication?: {
    signal?: AbortSignal
    deadlineMs?: number
  }): Promise<void> {
    const temporary = `${this.ledgerPath}.tmp-${randomUUID()}`
    try {
      await this.assertWriterOwnership()
      this.assertPublicationOpen(publication)
      const handle = await fs.open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600
      )
      try {
        await handle.writeFile(JSON.stringify(this.ledger), 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      this.assertPublicationOpen(publication)
      await fs.rename(temporary, this.ledgerPath)
      await syncDirectory(this.storeRoot)
      this.assertPublicationOpen(publication)
    } catch (error) {
      if (error instanceof GfsDownloadStoreError && error.code === 'publication_cancelled') {
        try {
          await fs.rm(temporary, { force: true })
        } catch {
          this.unsafe = true
          throw new GfsDownloadStoreError('storage_write_failed')
        }
      } else this.unsafe = true
      throw error
    }
  }

  private async acquireWriterLease(allowBootstrap: boolean): Promise<void> {
    const lease = new GfsStoreWriterLease(this.storeRoot, allowBootstrap)
    try {
      await lease.acquire()
      this.writerLease = lease
    } catch (error) {
      if (error instanceof GfsStoreWriterOwnershipError) {
        if (error.transientWriterContention) {
          // Contention alone must not turn a lost/corrupt durable journal into
          // a retryable state. Read only; the live writer retains all effects.
          let handle: fs.FileHandle | undefined
          try {
            handle = await openPrivateStoreObject(
              this.ledgerPath,
              'file',
              constants.O_RDONLY,
              false
            )
            parseLedger(await handle.readFile('utf8'))
          } catch {
            throw new GfsDownloadStoreError('corrupt_store_ledger')
          } finally {
            await handle?.close()
          }
        }
        throw new GfsDownloadStoreError(error.reason, error.transientWriterContention)
      }
      throw new GfsDownloadStoreError('workspace_unavailable')
    }
  }

  private async releaseWriterLease(): Promise<void> {
    await this.writerLease?.release()
    this.writerLease = undefined
  }

  private async assertWriterOwnership(): Promise<void> {
    try {
      if (!this.writerLease) throw new GfsStoreWriterOwnershipError('Writer ownership lost')
      await this.writerLease.verifyHeld()
    } catch {
      this.unsafe = true
      throw new GfsDownloadStoreError('writer_locked')
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

  private record(id: string): GfsDownloadRecord {
    const record = this.ledger.records[id]
    if (!record) throw new GfsDownloadStoreError('download_missing')
    return record
  }

  private releaseActive(record: GfsDownloadRecord): void {
    if (!this.activeIds.has(record.id)) return
    this.active = Math.max(0, this.active - 1)
    this.activeIds.delete(record.id)
    const current = this.activeByCaller.get(record.callerIdentity) ?? 0
    if (current <= 1) this.activeByCaller.delete(record.callerIdentity)
    else this.activeByCaller.set(record.callerIdentity, current - 1)
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail
    let unlock!: () => void
    this.mutationTail = new Promise<void>(resolve => {
      unlock = resolve
    })
    await previous
    try {
      if (!this.writerLease) throw new GfsDownloadStoreError('workspace_unavailable')
      await this.assertWriterOwnership()
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

  private assertInitialized(): void {
    if (!this.initialized) throw new GfsDownloadStoreError('workspace_unavailable')
    if (this.unsafe) throw new GfsDownloadStoreError('storage_write_failed')
    try {
      this.writerLease?.assertHeld()
    } catch {
      throw new GfsDownloadStoreError('writer_locked')
    }
  }
}
