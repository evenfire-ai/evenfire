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

export type GfsDownloadStoreErrorCode =
  | 'caller_mismatch'
  | 'caller_quota_exceeded'
  | 'corrupt_store_ledger'
  | 'download_expired'
  | 'download_missing'
  | 'download_busy'
  | 'host_quota_exceeded'
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
    (parsed as { records: unknown }).records === null
  )
    throw new GfsDownloadStoreError('corrupt_store_ledger')

  const records = (parsed as { records: Record<string, unknown> }).records
  const result: StoreLedger = { schemaVersion: 1, records: {} }
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

async function sha256File(path: string): Promise<string> {
  const digest = createHash('sha256')
  const handle = await fs.open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  )
  try {
    const chunk = Buffer.alloc(64 * 1024)
    let position = 0
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, position)
      if (bytesRead === 0) break
      digest.update(chunk.subarray(0, bytesRead))
      position += bytesRead
    }
  } finally {
    await handle.close()
  }
  return digest.digest('hex')
}

/** One Host/PVC-owned durable store; task registries receive bound handles. */
export class GfsDownloadStore {
  private hostRoot: string
  private storeRoot: string
  private ledgerPath: string
  private lockPath: string
  private writerLeaseId?: string
  private ledger: StoreLedger = { schemaVersion: 1, records: {} }
  private readonly activeByCaller = new Map<string, number>()
  private readonly activeIds = new Set<string>()
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
    await fs.mkdir(this.storeRoot, { recursive: true, mode: 0o700 })
    const storeInfo = await fs.lstat(this.storeRoot)
    if (!storeInfo.isDirectory() || storeInfo.isSymbolicLink() || storeInfo.mode & 0o077)
      throw new GfsDownloadStoreError('workspace_unavailable')

    await this.acquireWriterLease()
    let raw = ''
    try {
      try {
        raw = await fs.readFile(this.ledgerPath, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (raw) this.ledger = parseLedger(raw)
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

  async publish(id: string, callerIdentity: string, sha256: string): Promise<GfsDownloadReceipt> {
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
      const info = await fs.lstat(partial).catch(() => undefined)
      if (!info?.isFile() || info.isSymbolicLink() || info.size !== record.sizeBytes)
        throw new GfsDownloadStoreError('download_missing')
      if ((await sha256File(partial)) !== sha256)
        throw new GfsDownloadStoreError('corrupt_store_ledger')
      await fs.rename(partial, source)
      await syncDirectory(path.dirname(source))
      record.state = 'completed'
      record.sha256 = sha256
      await this.persist()
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

  async fail(id: string, callerIdentity: string): Promise<void> {
    this.assertInitialized()
    const record = this.record(id)
    try {
      await this.serialize(async () => {
        if (record.callerIdentity !== callerIdentity)
          throw new GfsDownloadStoreError('caller_mismatch')
        const directory = path.join(this.hostRoot, record.directory)
        try {
          const info = await fs.lstat(directory)
          if (!info.isDirectory() || info.isSymbolicLink())
            throw new GfsDownloadStoreError('workspace_unavailable')
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
    const info = await fs.lstat(source).catch(() => undefined)
    if (
      !info?.isFile() ||
      info.isSymbolicLink() ||
      info.size !== record.sizeBytes ||
      (info.mode & 0o777) !== 0o600
    )
      throw new GfsDownloadStoreError('download_missing')
    const digest = createHash('sha256')
    const handle = await fs.open(
      source,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    )
    try {
      const chunk = Buffer.alloc(64 * 1024)
      let position = 0
      for (;;) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, position)
        if (bytesRead === 0) break
        digest.update(chunk.subarray(0, bytesRead))
        position += bytesRead
      }
    } finally {
      await handle.close()
    }
    if (digest.digest('hex') !== record.sha256) throw new GfsDownloadStoreError('download_missing')
    return {
      id: record.id,
      source: record.source,
      path: record.path,
      sizeBytes: record.sizeBytes,
      sha256: record.sha256,
      expiresAt: record.expiresAt,
    }
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
    while (this.activeIds.size > 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    if (this.activeIds.size > 0) {
      this.closing = false
      throw new GfsDownloadStoreError('download_busy')
    }
    await this.mutationTail
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
      for (const record of Object.values(this.ledger.records)) {
        if (Date.parse(record.expiresAt) > now) continue
        if (this.activeIds.has(record.id)) continue
        const directory = path.join(this.hostRoot, record.directory)
        try {
          const info = await fs.lstat(directory)
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

  private async persist(): Promise<void> {
    try {
      const temporary = `${this.ledgerPath}.tmp-${randomUUID()}`
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
      await fs.rename(temporary, this.ledgerPath)
      await syncDirectory(this.storeRoot)
    } catch (error) {
      this.unsafe = true
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

  private assertInitialized(): void {
    if (!this.initialized) throw new GfsDownloadStoreError('workspace_unavailable')
    if (this.unsafe) throw new GfsDownloadStoreError('storage_write_failed')
  }
}
