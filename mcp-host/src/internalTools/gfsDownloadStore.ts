import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { GfsImageSource } from '../visualInput/policy'
import {
  GFS_FILE_LIMITS,
  GFS_HOST_ACTIVE_DOWNLOADS,
  GFS_HOST_RETAINED_FILES,
} from './gfsFilePolicy'
import type {
  GfsProcessingLease,
  GfsProcessingLeaseAcquisition,
  GfsProcessingLeaseProvider,
} from './gfsProcessingLease'

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
  constructor(readonly code: GfsDownloadStoreErrorCode) {
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
  state: 'transferring' | 'completed' | 'missing' | 'cleanup_failed'
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

interface StoreLedger {
  schemaVersion: 1
  records: Record<string, GfsDownloadRecord>
  processingLeases?: Record<string, GfsProcessingLeaseRecord>
}

interface GfsProcessingLeaseRecord {
  leaseId: string
  callerIdentity: string
  recordIds: string[]
  acquiredAt: string
  expiresAt: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHA256_RE = /^[0-9a-f]{64}$/

function parseLedger(raw: string): StoreLedger {
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
  const result: StoreLedger = { schemaVersion: 1, records: {}, processingLeases: {} }
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
      !['transferring', 'completed', 'missing', 'cleanup_failed'].includes(record.state) ||
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
    for (const [id, value] of Object.entries(rawProcessingLeases)) {
      const lease = value as GfsProcessingLeaseRecord
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
        lease.recordIds.some(recordId => result.records[recordId] === undefined) ||
        !Number.isFinite(Date.parse(lease.acquiredAt)) ||
        !Number.isFinite(Date.parse(lease.expiresAt)) ||
        Date.parse(lease.expiresAt) <= Date.parse(lease.acquiredAt)
      )
        throw new GfsDownloadStoreError('corrupt_store_ledger')
      result.processingLeases![id] = lease
    }
  }
  return result
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
  const usage: Usage = { bytes: 0, files: 0, callerBytes: {}, callerFiles: {} }
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
  private storeRoot: string
  private ledgerPath: string
  private lockPath: string
  private writerLeaseId?: string
  private ledger: StoreLedger = { schemaVersion: 1, records: {}, processingLeases: {} }
  private readonly activeByCaller = new Map<string, number>()
  private readonly activeIds = new Set<string>()
  private readonly liveProcessingLeases = new Set<string>()
  private active = 0
  private mutationTail = Promise.resolve()
  private initialized = false
  private closing = false
  private unsafe = false
  private static readonly writerOwners = new Map<string, string>()

  constructor(hostRoot: string) {
    this.hostRoot = path.resolve(hostRoot)
    this.storeRoot = path.join(this.hostRoot, '.gfs-download-store')
    this.ledgerPath = path.join(this.storeRoot, 'ledger-v1.json')
    this.lockPath = path.join(this.storeRoot, 'writer.lock')
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    await fs.mkdir(this.hostRoot, { recursive: true, mode: 0o700 })
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
    const storeInfo = await fs.lstat(this.storeRoot)
    if (!storeInfo.isDirectory() || storeInfo.isSymbolicLink() || storeInfo.mode & 0o077)
      throw new GfsDownloadStoreError('workspace_unavailable')

    await this.acquireWriterLease()
    let raw: string | undefined
    try {
      try {
        raw = await fs.readFile(this.ledgerPath, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (raw !== undefined) {
        // A successful read must always parse, including empty content, so a
        // truncated ledger fails closed.
        this.ledger = parseLedger(raw)
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
  }): Promise<GfsDownloadTransfer> {
    this.assertInitialized()
    if (this.closing) throw new GfsDownloadStoreError('download_busy')
    if (
      !Number.isSafeInteger(input.sizeBytes) ||
      input.sizeBytes < 0 ||
      input.sizeBytes > GFS_FILE_LIMITS.maxFileBytes
    )
      throw new GfsDownloadStoreError('host_quota_exceeded')

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
      const usage = usageFor(Object.values(this.ledger.records))
      const callerBytes = usage.callerBytes[input.callerIdentity] ?? 0
      if (usage.bytes + input.sizeBytes > GFS_FILE_LIMITS.storageBytes)
        throw new GfsDownloadStoreError('host_quota_exceeded')
      if (callerBytes + input.sizeBytes > GFS_FILE_LIMITS.callerStorageBytes)
        throw new GfsDownloadStoreError('caller_quota_exceeded')
      if (usage.files >= GFS_HOST_RETAINED_FILES)
        throw new GfsDownloadStoreError('host_quota_exceeded')
      if ((usage.callerFiles[input.callerIdentity] ?? 0) >= GFS_FILE_LIMITS.callerRetainedFiles)
        throw new GfsDownloadStoreError('caller_quota_exceeded')
      if (this.active >= GFS_HOST_ACTIVE_DOWNLOADS) throw new GfsDownloadStoreError('download_busy')
      if (
        (this.activeByCaller.get(input.callerIdentity) ?? 0) >=
        GFS_FILE_LIMITS.callerActiveDownloads
      )
        throw new GfsDownloadStoreError('download_busy')

      const space = await fs.statfs(this.storeRoot, { bigint: true })
      if (space.bavail * space.bsize < BigInt(input.sizeBytes + 16 * 1024 * 1024))
        throw new GfsDownloadStoreError('host_quota_exceeded')

      this.ledger.records[id] = record
      await this.persist()
      this.active += 1
      this.activeIds.add(id)
      this.activeByCaller.set(
        input.callerIdentity,
        (this.activeByCaller.get(input.callerIdentity) ?? 0) + 1
      )
      return undefined
    })

    try {
      await fs.mkdir(path.dirname(path.join(this.hostRoot, record.hostPath)), {
        recursive: true,
        mode: 0o700,
      })
      await fs.mkdir(absoluteDirectory, { recursive: true, mode: 0o700 })
      const partial = await fs.open(
        path.join(this.hostRoot, `${record.hostPath}.partial`),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      )
      await partial.close()
    } catch (error) {
      try {
        await this.serialize(async () => {
          delete this.ledger.records[id]
          await this.persist()
        })
        await fs.rm(absoluteDirectory, { recursive: true, force: true }).catch(() => undefined)
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
      const partialHandle = await fs
        .open(
          partial,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_EXCL | constants.O_NONBLOCK
        )
        .catch(() => undefined)
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
    bounds?: { signal?: AbortSignal; deadlineMs?: number }
  ): Promise<GfsDownloadReceipt | undefined> {
    this.assertInitialized()
    return this.serialize(async () => {
      this.assertPublicationOpen(bounds)
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
      const handle = await fs
        .open(
          path.join(this.hostRoot, record.hostPath),
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_EXCL | constants.O_NONBLOCK
        )
        .catch(() => undefined)
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
    this.assertInitialized()
    const record = this.record(id)
    try {
      await this.serialize(async () => {
        if (record.callerIdentity !== callerIdentity)
          throw new GfsDownloadStoreError('caller_mismatch')
        const directory = path.join(this.hostRoot, record.directory)
        let info: Awaited<ReturnType<typeof fs.lstat>>
        try {
          info = await fs.lstat(directory)
        } catch (error) {
          // A proven ENOENT means the directory was already removed; release the
          // durable charge instead of stranding an unrecoverable cleanup_failed
          // entry. Any other failure stays charged.
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            record.state = 'cleanup_failed'
            await this.persist()
            throw new GfsDownloadStoreError('storage_write_failed')
          }
          delete this.ledger.records[id]
          await this.persist()
          return
        }
        if (!info.isDirectory() || info.isSymbolicLink()) {
          record.state = 'cleanup_failed'
          await this.persist()
          throw new GfsDownloadStoreError('storage_write_failed')
        }
        try {
          await fs.rm(directory, { recursive: true, force: true })
        } catch {
          record.state = 'cleanup_failed'
          await this.persist()
          throw new GfsDownloadStoreError('storage_write_failed')
        }
        delete this.ledger.records[id]
        await this.persist()
      })
    } finally {
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
    const source = path.join(this.hostRoot, record.hostPath)
    const handle = await fs
      .open(
        source,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_EXCL | constants.O_NONBLOCK
      )
      .catch(() => undefined)
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

    const source = path.join(this.hostRoot, record.hostPath)
    const handle = await fs
      .open(
        source,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_EXCL | constants.O_NONBLOCK
      )
      .catch(() => undefined)
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

    const source = path.join(this.hostRoot, record.hostPath)
    const handle = await fs
      .open(
        source,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_EXCL | constants.O_NONBLOCK
      )
      .catch(() => undefined)
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

  processingLeaseProvider(callerIdentity: string): GfsProcessingLeaseProvider {
    return {
      acquireProcessingLease: (options?: GfsProcessingLeaseAcquisition) =>
        this.acquireProcessingLease(callerIdentity, options),
      releaseProcessingLease: (lease: GfsProcessingLease) =>
        this.releaseProcessingLease(callerIdentity, lease),
    }
  }

  private async acquireProcessingLease(
    callerIdentity: string,
    options?: GfsProcessingLeaseAcquisition
  ): Promise<GfsProcessingLease> {
    this.assertInitialized()
    if (this.closing) throw new GfsDownloadStoreError('download_busy')
    if (typeof callerIdentity !== 'string' || callerIdentity.length === 0)
      throw new GfsDownloadStoreError('caller_mismatch')
    const requestedMs = options?.durationMs ?? 60_000
    if (!Number.isSafeInteger(requestedMs) || requestedMs <= 0 || requestedMs > 3_600_000)
      throw new GfsDownloadStoreError('download_busy')

    return this.serialize(async () => {
      this.assertInitialized()
      if (this.closing) throw new GfsDownloadStoreError('download_busy')
      const now = Date.now()
      const retained = Object.values(this.ledger.records).filter(
        record => record.callerIdentity === callerIdentity
      )
      // Admission covers this caller's retained files without parsing the
      // command. Expired bytes can remain while an existing execution holds
      // them, but they must not authorize another execution before cleanup.
      if (retained.some(record => Date.parse(record.expiresAt) <= now))
        throw new GfsDownloadStoreError('download_expired')
      const candidates = retained.filter(
        record => record.state === 'completed' && record.sha256 !== undefined
      )
      if (candidates.length === 0) {
        return {
          leaseId: randomUUID(),
          expiresAt: new Date(now + requestedMs).toISOString(),
        }
      }
      for (const record of candidates) await this.inspect(record.path, callerIdentity)
      if (this.closing) throw new GfsDownloadStoreError('download_busy')
      const admittedAt = Date.now()
      if (retained.some(record => Date.parse(record.expiresAt) <= admittedAt))
        throw new GfsDownloadStoreError('download_expired')
      const leaseId = randomUUID()
      const expiresAt = new Date(admittedAt + requestedMs).toISOString()
      const lease: GfsProcessingLeaseRecord = {
        leaseId,
        callerIdentity,
        recordIds: candidates.map(record => record.id),
        acquiredAt: new Date(admittedAt).toISOString(),
        expiresAt,
      }
      this.ledger.processingLeases ??= {}
      this.ledger.processingLeases[leaseId] = lease
      try {
        await this.persist()
      } catch (error) {
        delete this.ledger.processingLeases[leaseId]
        throw error
      }
      // Hashing and durable publication can outlast either deadline. Only
      // return a new lease while both remain valid; an already admitted
      // execution keeps its existing protection after the file's expiry.
      const publishedAt = Date.now()
      const denial = retained.some(record => Date.parse(record.expiresAt) <= publishedAt)
        ? 'download_expired'
        : this.closing || Date.parse(expiresAt) <= publishedAt
          ? 'download_busy'
          : undefined
      if (denial) {
        delete this.ledger.processingLeases[leaseId]
        try {
          await this.persist()
        } catch (error) {
          // A failed rollback retains the durable reservation until its
          // deadline, without registering an execution that never started.
          this.ledger.processingLeases[leaseId] = lease
          throw error
        }
        throw new GfsDownloadStoreError(denial)
      }
      this.liveProcessingLeases.add(leaseId)
      return { leaseId, expiresAt }
    })
  }

  private async releaseProcessingLease(
    callerIdentity: string,
    lease: GfsProcessingLease
  ): Promise<void> {
    this.assertInitialized()
    await this.serialize(async () => {
      const record = this.ledger.processingLeases?.[lease.leaseId]
      if (!record) {
        this.liveProcessingLeases.delete(lease.leaseId)
        return
      }
      if (record.callerIdentity !== callerIdentity || record.expiresAt !== lease.expiresAt)
        throw new GfsDownloadStoreError('caller_mismatch')
      delete this.ledger.processingLeases![lease.leaseId]
      try {
        await this.persist()
      } catch (error) {
        this.ledger.processingLeases![lease.leaseId] = record
        this.liveProcessingLeases.add(lease.leaseId)
        throw error
      }
      this.liveProcessingLeases.delete(lease.leaseId)
    })
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
    while (
      (this.activeIds.size > 0 || this.liveProcessingLeases.size > 0) &&
      Date.now() < deadline
    ) {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    if (this.activeIds.size > 0 || this.liveProcessingLeases.size > 0) {
      this.closing = false
      throw new GfsDownloadStoreError('download_busy')
    }
    await this.mutationTail
    // Work already queued before shutdown can finish admission while close
    // waits. Never release writer ownership over a newly active operation.
    if (this.activeIds.size > 0 || this.liveProcessingLeases.size > 0) {
      this.closing = false
      throw new GfsDownloadStoreError('download_busy')
    }
    this.initialized = false
    try {
      await this.serialize(async () => {
        await this.persist()
      })
      await this.releaseWriterLease()
    } finally {
      this.closing = false
    }
  }

  async cleanupExpired(now = Date.now()): Promise<void> {
    if (!this.initialized && !this.closing) throw new GfsDownloadStoreError('workspace_unavailable')
    await this.serialize(async () => {
      const removed: string[] = []
      let stateChanged = false
      for (const [leaseId, lease] of Object.entries(this.ledger.processingLeases ?? {})) {
        // A live execution releases its lease after process-group termination.
        // The durable deadline governs recovery when no live owner remains.
        if (Date.parse(lease.expiresAt) <= now && !this.liveProcessingLeases.has(leaseId)) {
          delete this.ledger.processingLeases![leaseId]
          stateChanged = true
        }
      }
      for (const record of Object.values(this.ledger.records)) {
        if (Date.parse(record.expiresAt) > now) continue
        if (this.activeIds.has(record.id)) continue
        if (this.hasProcessingLease(record.id, now)) continue
        const directory = path.join(this.hostRoot, record.directory)
        let info: Awaited<ReturnType<typeof fs.lstat>>
        try {
          info = await fs.lstat(directory)
        } catch (error) {
          // Only a proven ENOENT establishes that nothing remains to delete.
          // Permission errors, ENOTDIR and other uncertain outcomes stay charged.
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            removed.push(record.id)
            continue
          }
          if (record.state !== 'cleanup_failed') {
            record.state = 'cleanup_failed'
            stateChanged = true
          }
          continue
        }
        try {
          const realDirectory = await fs.realpath(directory)
          if (!info.isDirectory() || info.isSymbolicLink() || realDirectory !== directory) {
            if (record.state !== 'cleanup_failed') {
              record.state = 'cleanup_failed'
              stateChanged = true
            }
            continue
          }
          await fs.rm(directory, { recursive: true, force: true })
          removed.push(record.id)
        } catch {
          if (record.state !== 'cleanup_failed') {
            record.state = 'cleanup_failed'
            stateChanged = true
          }
        }
      }
      if (removed.length > 0) for (const id of removed) delete this.ledger.records[id]
      if (removed.length > 0 || stateChanged) await this.persist()
    })
  }

  private async reconcile(): Promise<void> {
    for (const record of Object.values(this.ledger.records)) {
      const directory = path.join(this.hostRoot, record.directory)
      if (!isWithinDirectory(directory, this.hostRoot))
        throw new GfsDownloadStoreError('workspace_unavailable')
      const sourceInfo = await fs
        .lstat(path.join(this.hostRoot, record.hostPath))
        .catch(() => undefined)
      if (
        sourceInfo?.isFile() &&
        !sourceInfo.isSymbolicLink() &&
        sourceInfo.size === record.sizeBytes &&
        SHA256_RE.test(record.sha256 ?? '')
      ) {
        record.state = 'completed'
        continue
      }
      const partialInfo = await fs
        .lstat(path.join(this.hostRoot, `${record.hostPath}.partial`))
        .catch(() => undefined)
      if (
        (sourceInfo?.isFile() || partialInfo?.isFile()) &&
        !sourceInfo?.isSymbolicLink() &&
        !partialInfo?.isSymbolicLink()
      ) {
        record.state = 'transferring'
        continue
      }
      record.state = 'missing'
    }
  }

  private async persist(publication?: {
    signal?: AbortSignal
    deadlineMs?: number
  }): Promise<void> {
    const temporary = `${this.ledgerPath}.tmp-${randomUUID()}`
    try {
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

  private async acquireWriterLease(): Promise<void> {
    const currentOwner = GfsDownloadStore.writerOwners.get(this.storeRoot)
    if (currentOwner) throw new GfsDownloadStoreError('writer_locked')
    const leaseId = randomUUID()
    let handle: fs.FileHandle | undefined
    try {
      handle = await fs.open(
        this.lockPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600
      )
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, leaseId, acquiredAt: new Date().toISOString() }),
        'utf8'
      )
      await handle.sync()
      this.writerLeaseId = leaseId
      GfsDownloadStore.writerOwners.set(this.storeRoot, leaseId)
    } catch (error) {
      await handle?.close().catch(() => undefined)
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new GfsDownloadStoreError('writer_locked')
      throw error
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }

  private async releaseWriterLease(): Promise<void> {
    if (!this.writerLeaseId) return
    if (GfsDownloadStore.writerOwners.get(this.storeRoot) === this.writerLeaseId)
      GfsDownloadStore.writerOwners.delete(this.storeRoot)
    await fs.rm(this.lockPath, { force: true })
    this.writerLeaseId = undefined
  }

  private async validateCallerRoot(callerRoot: string): Promise<string> {
    const lexical = path.resolve(callerRoot)
    const real = await fs.realpath(lexical).catch(() => {
      throw new GfsDownloadStoreError('workspace_unavailable')
    })
    if (!isWithinDirectory(real, await fs.realpath(this.hostRoot)))
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

  private hasProcessingLease(recordId: string, now: number): boolean {
    return Object.values(this.ledger.processingLeases ?? {}).some(
      lease =>
        (this.liveProcessingLeases.has(lease.leaseId) || Date.parse(lease.expiresAt) > now) &&
        lease.recordIds.includes(recordId)
    )
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
  }
}
