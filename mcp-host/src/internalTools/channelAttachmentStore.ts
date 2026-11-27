/**
 * X3 — Dedicated Host-owned PVC store for inbound channel attachments.
 *
 * Rooted at `<hostWorkspaceRoot>/.clerum-state/channel-attachments/` (protected
 * from agent workspace tools by `PROTECTED_WORKSPACE_DIRS`).
 *
 * Security & reliability invariants (`C4` / `SF5` / `SF8` / `SF9` / `SF10`):
 * - Fails closed (`channel_attachment_store_unavailable`) when
 *   `sessionStoreMode === 'memory'`, workspace root is unconfigured, or volume
 *   space is unmeasurable.
 * - Enforces the 15% volume free-space floor (`freeSpaceFloor`) WITH upfront
 *   in-process `activeReservedBytes` accounting across concurrent streams.
 * - Atomic streaming write (`<id>.partial` -> `fsync` -> `rename` -> `<id>.bin`),
 *   incremental SHA-256, and strict abort at `maxBytes + 1` with `.partial`
 *   cleanup and reservation release in `finally`.
 * - Every read verifies directory trust (`verifyPrivateStoreDirectory`), opens
 *   the regular non-symlink file via `openPrivateStoreObject` (`O_NOFOLLOW`),
 *   and recomputes SHA-256 before returning bytes.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { type FileClass, resourceNameProblem } from '@clerum/gfs-interaction-policy'
import type { RetainedChannelAttachmentRow, SweptChannelAttachmentRef } from '../db/worker/protocol'
import { logger } from '../logger'
import { freeSpaceFloor } from './gfsDownloadStore'
import {
  PrivateStoreUntrustedError,
  openPrivateStoreObject,
  verifyPrivateStoreDirectory,
} from './gfsStorePrivateFiles'

export const CHANNEL_ATTACHMENT_MAX_BYTES_DEFAULT = 11_534_336 // 11 MiB
export const CHANNEL_ATTACHMENT_MAX_BYTES_CEILING = 20_971_520 // 20 MiB
export const CHANNEL_ATTACHMENT_DEFAULT_TTL_HOURS = 168 // 7 days
export const CHANNEL_ATTACHMENT_DEFAULT_HOST_QUOTA_BYTES = 512 * 1024 * 1024 // 512 MiB
export const CHANNEL_ATTACHMENT_DEFAULT_USER_QUOTA_BYTES = 128 * 1024 * 1024 // 128 MiB
export const CHANNEL_ATTACHMENT_STORE_SUBDIR = path.join('.clerum-state', 'channel-attachments')

const MAX_FILENAME_CODE_POINTS = 255
const MAX_EXTENSION_CODE_POINTS = 32
const ATTACHMENT_BLOB_RE = /^[0-9a-f-]{36}\.bin$/
const PARTIAL_FILE_RE = /^[0-9a-f-]{36}\.partial$/
const SHA256_HEX_RE = /^[0-9a-f]{64}$/

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_IHDR = 'IHDR'
const PNG_IDAT = 'IDAT'
const PNG_IEND = 'IEND'

// SOF0..SOF15 except DHT (0xC4), JPG (0xC8), and DAC (0xCC), matching
// `@clerum/llm-provider-attempt-contract/visualPayload.cjs` &
// `@clerum/grok-provider-attempt-contract/visualPayload.cjs`.
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
])
const JPEG_SOI = 0xd8
const JPEG_EOI = 0xd9
const JPEG_SOS = 0xda
const JPEG_TEM = 0x01

const EXT_BY_CLASS: Record<string, string> = {
  jpeg: '.jpg',
  png: '.png',
  pdf: '.pdf',
  xlsx: '.xlsx',
  docx: '.docx',
  markdown: '.md',
  html: '.html',
  svg: '.svg',
  code: '.txt',
  text: '.txt',
  binary_unsupported: '.bin',
}

/**
 * Deterministic pure filename normalizer (`X3` / `X4` / `R49`).
 *
 * Normalizes to NFC, strips ASCII control characters (`0x00-0x1f`, `0x7f`),
 * replaces `/` and `\` with `_`, rejects `.` / `..` / empty names, truncates to
 * <= 255 Unicode code points while preserving any sanitized extension, and
 * synthesizes `attachment-<shortId>.<extFromClass>` when input is null, empty,
 * or unusable. Guaranteed to satisfy `resourceNameProblem(name) === null`.
 */
export function normalizeChannelFilename(
  filename: string | null | undefined,
  fileClass: FileClass | string,
  shortId?: string
): string {
  const extFromClass = EXT_BY_CLASS[fileClass] ?? '.bin'
  const rawShort =
    typeof shortId === 'string' ? shortId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 12) : ''
  const safeShort = rawShort.length > 0 ? rawShort : randomBytes(4).toString('hex')
  const synthesized = `attachment-${safeShort}${extFromClass}`

  if (typeof filename !== 'string') return synthesized

  // Strip ASCII control characters and replace path separators before trimming.
  // eslint-disable-next-line no-control-regex
  let cleaned = filename
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/\\]/g, '_')
    .trim()
  if (cleaned.length === 0 || cleaned === '.' || cleaned === '..') {
    return synthesized
  }

  let codePoints = [...cleaned]
  if (codePoints.length > MAX_FILENAME_CODE_POINTS) {
    const lastDotIndex = codePoints.lastIndexOf('.')
    const extLength = lastDotIndex > 0 ? codePoints.length - lastDotIndex : 0
    if (extLength > 1 && extLength <= MAX_EXTENSION_CODE_POINTS) {
      const ext = codePoints.slice(lastDotIndex).join('')
      const stemBudget = MAX_FILENAME_CODE_POINTS - extLength
      const stem = codePoints.slice(0, Math.max(1, stemBudget)).join('')
      cleaned = `${stem}${ext}`.normalize('NFC')
    } else {
      cleaned = codePoints.slice(0, MAX_FILENAME_CODE_POINTS).join('').normalize('NFC')
    }
    codePoints = [...cleaned]
    if (codePoints.length > MAX_FILENAME_CODE_POINTS) {
      cleaned = codePoints.slice(0, MAX_FILENAME_CODE_POINTS).join('')
    }
  }

  if (
    cleaned.length === 0 ||
    cleaned === '.' ||
    cleaned === '..' ||
    resourceNameProblem(cleaned) !== null
  ) {
    return synthesized
  }
  return cleaned
}

export interface StrictChannelImageValidationResult {
  width: number | null
  height: number | null
  visualValid: boolean
}

function validateStrictPng(buffer: Buffer): StrictChannelImageValidationResult {
  const length = buffer.length
  if (length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { width: null, height: null, visualValid: false }
  }
  let pos = 8
  let header: { width: number; height: number } | null = null
  let sawImageData = false
  let sawEnd = false
  while (pos < length) {
    if (pos + 8 > length) return { width: null, height: null, visualValid: false }
    const chunkLength = buffer.readUInt32BE(pos)
    const type = buffer.toString('latin1', pos + 4, pos + 8)
    if (pos + 12 + chunkLength > length) return { width: null, height: null, visualValid: false }
    if (header === null) {
      if (type !== PNG_IHDR || chunkLength !== 13) {
        return { width: null, height: null, visualValid: false }
      }
      const width = buffer.readUInt32BE(pos + 8)
      const height = buffer.readUInt32BE(pos + 12)
      if (width < 1 || height < 1) return { width: null, height: null, visualValid: false }
      header = { width, height }
    } else if (type === PNG_IHDR) {
      return { width: null, height: null, visualValid: false }
    }
    if (type === PNG_IDAT) sawImageData = true
    if (type === PNG_IEND) {
      if (chunkLength !== 0 || pos + 12 !== length) {
        return { width: null, height: null, visualValid: false }
      }
      sawEnd = true
      break
    }
    pos += 12 + chunkLength
  }
  if (header === null || !sawImageData || !sawEnd) {
    return { width: null, height: null, visualValid: false }
  }
  return { width: header.width, height: header.height, visualValid: true }
}

function validateStrictJpeg(buffer: Buffer): StrictChannelImageValidationResult {
  const length = buffer.length
  if (length < 4 || buffer[0] !== 0xff || buffer[1] !== JPEG_SOI) {
    return { width: null, height: null, visualValid: false }
  }
  if (buffer[length - 2] !== 0xff || buffer[length - 1] !== JPEG_EOI) {
    return { width: null, height: null, visualValid: false }
  }
  let pos = 2
  let frame: { width: number; height: number } | null = null
  let scanEnd = -1
  while (pos < length) {
    if (buffer[pos] !== 0xff) return { width: null, height: null, visualValid: false }
    while (pos < length && buffer[pos] === 0xff) pos += 1
    if (pos >= length) return { width: null, height: null, visualValid: false }
    const marker = buffer[pos]!
    pos += 1
    if (marker === 0x00) return { width: null, height: null, visualValid: false }
    if (marker === JPEG_EOI) break
    if (marker === JPEG_SOI) return { width: null, height: null, visualValid: false }
    if (marker === JPEG_TEM || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (pos + 2 > length) return { width: null, height: null, visualValid: false }
    const segmentLength = buffer.readUInt16BE(pos)
    if (segmentLength < 2 || pos + segmentLength > length) {
      return { width: null, height: null, visualValid: false }
    }
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (segmentLength < 8) return { width: null, height: null, visualValid: false }
      const height = buffer.readUInt16BE(pos + 3)
      const width = buffer.readUInt16BE(pos + 5)
      if (width < 1 || height < 1) return { width: null, height: null, visualValid: false }
      frame = { width, height }
    }
    if (marker === JPEG_SOS) {
      scanEnd = pos + segmentLength
      break
    }
    pos += segmentLength
  }
  if (frame === null || scanEnd < 0 || scanEnd >= length - 2) {
    return { width: null, height: null, visualValid: false }
  }
  return { width: frame.width, height: frame.height, visualValid: true }
}

/**
 * Strict JPEG/PNG container framing validator matching
 * `@clerum/llm-provider-attempt-contract/visualPayload.cjs` and
 * `@clerum/grok-provider-attempt-contract/visualPayload.cjs`.
 *
 * Never rejects ingest (`R58`); returns `visualValid: false` on any framing
 * defect (Motion-Photo trailing bytes after EOI, missing SOS/EOI, PNG missing
 * IDAT or trailing bytes after IEND, etc.) so `X12` can demote before provider
 * dispatch while keeping the attachment stored and saveable.
 */
export function validateStrictChannelImageContainer(
  bytes: Buffer | Uint8Array,
  detectedClass: string
): StrictChannelImageValidationResult {
  const buf = Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (detectedClass === 'png') return validateStrictPng(buf)
  if (detectedClass === 'jpeg') return validateStrictJpeg(buf)
  return { width: null, height: null, visualValid: false }
}

export type ChannelAttachmentStoreErrorCode =
  | 'channel_attachment_store_unavailable'
  | 'file_too_large'
  | 'disk_full'
  | 'quota_exceeded'
  | 'attachment_not_found'
  | 'attachment_integrity_failed'
  | 'storage_write_failed'

export class ChannelAttachmentStoreError extends Error {
  constructor(
    readonly code: ChannelAttachmentStoreErrorCode,
    message?: string
  ) {
    super(message ?? `Channel attachment store error (${code})`)
    this.name = 'ChannelAttachmentStoreError'
  }
}

export interface VolumeStatFs {
  bsize: bigint | number
  blocks: bigint | number
  bavail: bigint | number
}

export interface ChannelAttachmentStoreOptions {
  hostWorkspaceRoot: string | null | undefined
  sessionStoreMode: 'memory' | 'sqlite' | 'dual'
  maxFileBytes?: number
  hostQuotaBytes?: number
  userQuotaBytes?: number
  statfsFn?: (dir: string) => Promise<VolumeStatFs>
  now?: () => number
}

export interface ChannelAttachmentPutResult {
  attachmentId: string
  storageRelPath: string
  sha256: string
  byteLength: number
  bytes: Buffer
}

export interface ChannelAttachmentDbReader {
  getChannelAttachmentForOwner(
    attachmentId: string,
    sessionKey: string,
    linkedUserId: string,
    nowEpoch?: number
  ): Promise<RetainedChannelAttachmentRow | null>
}

export interface ChannelAttachmentDbSweeper {
  sweepExpiredChannelAttachments(
    nowEpoch?: number,
    limit?: number
  ): Promise<SweptChannelAttachmentRef[]>
}

export class ChannelAttachmentStore {
  private readonly storeDir: string | null
  private readonly sessionStoreMode: 'memory' | 'sqlite' | 'dual'
  private readonly maxFileBytes: number
  private readonly hostQuotaBytes: bigint
  private readonly userQuotaBytes: bigint
  private readonly statfsFn: (dir: string) => Promise<VolumeStatFs>
  private readonly now: () => number

  private activeReservedBytes = 0n
  private readonly activeReservedByUser = new Map<string, bigint>()
  private readonly committedBytesByUser = new Map<string, bigint>()
  private readonly blobOwnerAndSize = new Map<string, { linkedUserId?: string; bytes: bigint }>()
  private readonly activePartials = new Set<string>()
  private committedHostBytes = 0n
  private hostUsageScanPromise: Promise<void> | null = null

  constructor(options: ChannelAttachmentStoreOptions) {
    this.sessionStoreMode = options.sessionStoreMode
    const root =
      typeof options.hostWorkspaceRoot === 'string' ? options.hostWorkspaceRoot.trim() : ''
    this.storeDir =
      this.sessionStoreMode !== 'memory' && root.length > 0
        ? path.join(path.resolve(root), CHANNEL_ATTACHMENT_STORE_SUBDIR)
        : null
    this.maxFileBytes = Math.min(
      Math.max(1, options.maxFileBytes ?? CHANNEL_ATTACHMENT_MAX_BYTES_DEFAULT),
      CHANNEL_ATTACHMENT_MAX_BYTES_CEILING
    )
    this.hostQuotaBytes = BigInt(
      options.hostQuotaBytes ?? CHANNEL_ATTACHMENT_DEFAULT_HOST_QUOTA_BYTES
    )
    this.userQuotaBytes = BigInt(
      options.userQuotaBytes ?? CHANNEL_ATTACHMENT_DEFAULT_USER_QUOTA_BYTES
    )
    this.statfsFn =
      options.statfsFn ??
      (async dir => {
        const stats = await fs.statfs(dir, { bigint: true })
        return { bsize: stats.bsize, blocks: stats.blocks, bavail: stats.bavail }
      })
    this.now = options.now ?? (() => Date.now())
  }

  isAvailable(): boolean {
    return this.storeDir !== null && this.sessionStoreMode !== 'memory'
  }

  private assertAvailable(): string {
    if (!this.storeDir || this.sessionStoreMode === 'memory') {
      throw new ChannelAttachmentStoreError(
        'channel_attachment_store_unavailable',
        'Channel attachment store is unavailable in memory session store mode or without a workspace root'
      )
    }
    return this.storeDir
  }

  private async ensureStoreDirectory(): Promise<string> {
    const storeDir = this.assertAvailable()
    const stateDir = path.dirname(storeDir)
    await fs.mkdir(stateDir, { recursive: true })
    try {
      await fs.mkdir(storeDir, { mode: 0o700 })
      await fs.chmod(storeDir, 0o700)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code !== 'EEXIST') {
        throw new ChannelAttachmentStoreError(
          'channel_attachment_store_unavailable',
          `Failed to initialize channel attachment directory (${code ?? 'unknown'})`
        )
      }
    }
    await verifyPrivateStoreDirectory(storeDir)
    await this.scanHostUsageOnce(storeDir)
    return storeDir
  }

  private async scanHostUsageOnce(storeDir: string): Promise<void> {
    if (!this.hostUsageScanPromise) {
      this.hostUsageScanPromise = (async () => {
        let total = 0n
        try {
          const entries = await fs.readdir(storeDir)
          for (const entry of entries) {
            if (!ATTACHMENT_BLOB_RE.test(entry)) continue
            try {
              const stat = await fs.lstat(path.join(storeDir, entry))
              if (stat.isFile()) {
                const size = BigInt(stat.size)
                total += size
                this.blobOwnerAndSize.set(entry, { bytes: size })
              }
            } catch {
              // Ignore disappeared entries during initial scan.
            }
          }
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
            throw err
          }
        }
        this.committedHostBytes = total
      })().catch(err => {
        this.hostUsageScanPromise = null
        throw err
      })
    }
    await this.hostUsageScanPromise
  }

  private async measureVolume(storeDir: string): Promise<{
    bsize: bigint
    blocks: bigint
    bavail: bigint
  }> {
    let raw: VolumeStatFs
    try {
      raw = await this.statfsFn(storeDir)
    } catch {
      throw new ChannelAttachmentStoreError(
        'channel_attachment_store_unavailable',
        'Unable to measure channel attachment volume free space'
      )
    }
    const bsize = typeof raw.bsize === 'bigint' ? raw.bsize : BigInt(Math.trunc(raw.bsize))
    const blocks = typeof raw.blocks === 'bigint' ? raw.blocks : BigInt(Math.trunc(raw.blocks))
    const bavail = typeof raw.bavail === 'bigint' ? raw.bavail : BigInt(Math.trunc(raw.bavail))
    if (bsize <= 0n || blocks <= 0n || bavail < 0n) {
      throw new ChannelAttachmentStoreError(
        'channel_attachment_store_unavailable',
        'Channel attachment volume returned invalid statfs measurements'
      )
    }
    return { bsize, blocks, bavail }
  }

  /**
   * Stream bytes atomically to `.partial`, fsync, and rename to `<id>.bin`.
   * Reserves space synchronously after `statfs` so concurrent streams cannot
   * jointly breach the 15% free-space floor (`S29`, `SF9`).
   */
  async putStream(input: {
    stream: AsyncIterable<Uint8Array | Buffer> | NodeJS.ReadableStream
    linkedUserId: string
    declaredBytes?: number
    maxBytes?: number
    attachmentId?: string
  }): Promise<ChannelAttachmentPutResult> {
    const storeDir = await this.ensureStoreDirectory()
    const limitBytes = Math.min(
      Math.max(1, input.maxBytes ?? this.maxFileBytes),
      CHANNEL_ATTACHMENT_MAX_BYTES_CEILING
    )

    if (input.declaredBytes !== undefined) {
      if (!Number.isSafeInteger(input.declaredBytes) || input.declaredBytes < 0) {
        throw new ChannelAttachmentStoreError('storage_write_failed', 'Invalid content length')
      }
      if (input.declaredBytes > limitBytes) {
        throw new ChannelAttachmentStoreError(
          'file_too_large',
          `Attachment exceeds maximum size of ${limitBytes} bytes`
        )
      }
    }

    const reserveBytes = BigInt(input.declaredBytes ?? limitBytes)
    const volume = await this.measureVolume(storeDir)

    // Synchronous reservation check + increment right after `await measureVolume`
    // closes the TOCTOU window across concurrent `/ingest` streams (`S29`).
    const floor = freeSpaceFloor(volume)
    const availableFreeBytes = volume.bavail * volume.bsize
    if (availableFreeBytes - this.activeReservedBytes - reserveBytes < floor) {
      throw new ChannelAttachmentStoreError(
        'disk_full',
        'Insufficient disk free space above safety floor'
      )
    }

    const userReserved = this.activeReservedByUser.get(input.linkedUserId) ?? 0n
    const userCommitted = this.committedBytesByUser.get(input.linkedUserId) ?? 0n
    if (this.committedHostBytes + this.activeReservedBytes + reserveBytes > this.hostQuotaBytes) {
      throw new ChannelAttachmentStoreError(
        'quota_exceeded',
        'Host channel attachment storage quota exceeded'
      )
    }
    if (userCommitted + userReserved + reserveBytes > this.userQuotaBytes) {
      throw new ChannelAttachmentStoreError(
        'quota_exceeded',
        'User channel attachment storage quota exceeded'
      )
    }

    this.activeReservedBytes += reserveBytes
    this.activeReservedByUser.set(input.linkedUserId, userReserved + reserveBytes)

    const attachmentId = input.attachmentId ?? randomUUID()
    const storageRelPath = `${attachmentId}.bin`
    const partialName = `${attachmentId}.partial`
    if (!ATTACHMENT_BLOB_RE.test(storageRelPath)) {
      this.releaseReservation(input.linkedUserId, reserveBytes)
      throw new ChannelAttachmentStoreError('storage_write_failed', 'Invalid attachment ID format')
    }
    const partialPath = path.join(storeDir, partialName)
    const finalPath = path.join(storeDir, storageRelPath)
    this.activePartials.add(partialName)

    let handle: fs.FileHandle | null = null
    let renamed = false
    try {
      handle = await fs.open(
        partialPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      )
      const hash = createHash('sha256')
      const chunks: Buffer[] = []
      let byteLength = 0

      for await (const rawChunk of input.stream) {
        const chunk = Buffer.isBuffer(rawChunk)
          ? rawChunk
          : typeof rawChunk === 'string'
            ? Buffer.from(rawChunk)
            : Buffer.from(rawChunk.buffer, rawChunk.byteOffset, rawChunk.byteLength)
        if (chunk.length === 0) continue
        if (byteLength + chunk.length > limitBytes) {
          throw new ChannelAttachmentStoreError(
            'file_too_large',
            `Attachment exceeds maximum size of ${limitBytes} bytes`
          )
        }
        byteLength += chunk.length
        hash.update(chunk)
        chunks.push(chunk)
        await handle.write(chunk)
      }

      await handle.sync()
      await handle.close()
      handle = null

      await fs.rename(partialPath, finalPath)
      renamed = true

      const committedBig = BigInt(byteLength)
      this.committedHostBytes += committedBig
      this.committedBytesByUser.set(
        input.linkedUserId,
        (this.committedBytesByUser.get(input.linkedUserId) ?? 0n) + committedBig
      )
      this.blobOwnerAndSize.set(storageRelPath, {
        linkedUserId: input.linkedUserId,
        bytes: committedBig,
      })

      return {
        attachmentId,
        storageRelPath,
        sha256: hash.digest('hex'),
        byteLength,
        bytes: Buffer.concat(chunks, byteLength),
      }
    } catch (err) {
      if (handle) {
        await handle.close().catch(() => {})
      }
      if (!renamed) {
        await fs.unlink(partialPath).catch(() => {})
      }
      if (err instanceof ChannelAttachmentStoreError || err instanceof PrivateStoreUntrustedError) {
        throw err
      }
      throw new ChannelAttachmentStoreError(
        'storage_write_failed',
        `Failed to store channel attachment (${(err as NodeJS.ErrnoException)?.code ?? 'unknown'})`
      )
    } finally {
      this.activePartials.delete(partialName)
      this.releaseReservation(input.linkedUserId, reserveBytes)
    }
  }

  private releaseReservation(linkedUserId: string, reserveBytes: bigint): void {
    this.activeReservedBytes =
      this.activeReservedBytes >= reserveBytes ? this.activeReservedBytes - reserveBytes : 0n
    const prev = this.activeReservedByUser.get(linkedUserId) ?? 0n
    const next = prev >= reserveBytes ? prev - reserveBytes : 0n
    if (next === 0n) {
      this.activeReservedByUser.delete(linkedUserId)
    } else {
      this.activeReservedByUser.set(linkedUserId, next)
    }
  }

  /**
   * Open a committed blob via `openPrivateStoreObject` (`O_NOFOLLOW` + regular
   * file + owner/mode check) and verify its SHA-256 digest before returning
   * bytes (`S41`, `SF5`).
   */
  async readVerified(storageRelPath: string, expectedSha256: string): Promise<Buffer> {
    const storeDir = this.assertAvailable()
    if (!ATTACHMENT_BLOB_RE.test(storageRelPath)) {
      throw new PrivateStoreUntrustedError('Invalid channel attachment storage path')
    }
    if (!SHA256_HEX_RE.test(expectedSha256)) {
      throw new ChannelAttachmentStoreError(
        'attachment_integrity_failed',
        'Expected attachment digest is invalid'
      )
    }
    await verifyPrivateStoreDirectory(storeDir)
    const fullPath = path.join(storeDir, storageRelPath)

    let handle: fs.FileHandle
    try {
      handle = await openPrivateStoreObject(fullPath, 'file', constants.O_RDONLY, true)
    } catch (err) {
      if (err instanceof PrivateStoreUntrustedError) throw err
      const code = (err as NodeJS.ErrnoException)?.code
      if (code === 'ENOENT') {
        throw new ChannelAttachmentStoreError('attachment_not_found', 'Attachment blob not found')
      }
      if (code === 'ELOOP' || code === 'ENOTDIR') {
        throw new PrivateStoreUntrustedError('Channel attachment path is not a regular file')
      }
      throw new ChannelAttachmentStoreError(
        'attachment_integrity_failed',
        `Unable to open channel attachment (${code ?? 'unknown'})`
      )
    }

    let buf: Buffer
    try {
      buf = await handle.readFile()
    } finally {
      await handle.close()
    }

    const actualSha256 = createHash('sha256').update(buf).digest('hex')
    if (actualSha256 !== expectedSha256) {
      throw new ChannelAttachmentStoreError(
        'attachment_integrity_failed',
        'Channel attachment SHA-256 verification failed'
      )
    }
    return buf
  }

  /**
   * Owner-scoped read combining SQLite ownership/pin verification (`X2`) with
   * private-store non-symlink open + SHA-256 verification (`X3`).
   */
  async readForOwner(
    dbReader: ChannelAttachmentDbReader,
    params: {
      attachmentId: string
      sessionKey: string
      linkedUserId: string
      nowEpoch?: number
    }
  ): Promise<{ record: RetainedChannelAttachmentRow; bytes: Buffer }> {
    this.assertAvailable()
    const record = await dbReader.getChannelAttachmentForOwner(
      params.attachmentId,
      params.sessionKey,
      params.linkedUserId,
      params.nowEpoch ?? this.now() / 1000
    )
    if (!record) {
      throw new ChannelAttachmentStoreError('attachment_not_found', 'Attachment not found')
    }
    const bytes = await this.readVerified(record.storage_rel_path, record.sha256)
    return { record, bytes }
  }

  async removeBlob(storageRelPath: string): Promise<void> {
    if (!this.storeDir || !ATTACHMENT_BLOB_RE.test(storageRelPath)) return
    const fullPath = path.join(this.storeDir, storageRelPath)
    let removedSize = this.blobOwnerAndSize.get(storageRelPath)?.bytes
    const owner = this.blobOwnerAndSize.get(storageRelPath)?.linkedUserId
    if (removedSize === undefined) {
      try {
        const stat = await fs.lstat(fullPath)
        if (stat.isFile()) removedSize = BigInt(stat.size)
      } catch {
        // Ignore if already removed.
      }
    }
    try {
      await fs.unlink(fullPath)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code !== 'ENOENT') {
        logger.warn({ component: 'ChannelAttachmentStore', code }, 'Failed to unlink blob')
      }
    }
    this.blobOwnerAndSize.delete(storageRelPath)
    if (removedSize !== undefined) {
      this.committedHostBytes =
        this.committedHostBytes >= removedSize ? this.committedHostBytes - removedSize : 0n
      if (owner) {
        const prev = this.committedBytesByUser.get(owner) ?? 0n
        const next = prev >= removedSize ? prev - removedSize : 0n
        if (next === 0n) this.committedBytesByUser.delete(owner)
        else this.committedBytesByUser.set(owner, next)
      }
    }
  }

  /**
   * Startup and periodic cleanup of orphan `.partial` files left behind by
   * crashed/aborted uploads. Active in-flight partials tracked in
   * `this.activePartials` are never deleted.
   */
  async cleanupOrphanPartials(graceWindowMs = 0): Promise<{ removed: number }> {
    if (!this.storeDir || this.sessionStoreMode === 'memory') return { removed: 0 }
    let entries: string[]
    try {
      entries = await fs.readdir(this.storeDir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { removed: 0 }
      throw err
    }
    const nowMs = this.now()
    let removed = 0
    for (const entry of entries) {
      if (!PARTIAL_FILE_RE.test(entry)) continue
      if (this.activePartials.has(entry)) continue
      const fullPath = path.join(this.storeDir, entry)
      try {
        const stat = await fs.lstat(fullPath)
        if (graceWindowMs > 0 && nowMs - stat.mtimeMs < graceWindowMs) continue
        await fs.unlink(fullPath)
        removed += 1
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          logger.warn(
            { component: 'ChannelAttachmentStore', entry, err },
            'Failed to clean up orphan partial attachment'
          )
        }
      }
    }
    return { removed }
  }

  /**
   * Periodic TTL sweep coordinated with SQLite `pending_approvals` / active
   * session pinning (`X2`, `S40`, `SF10`).
   */
  async sweepExpired(
    dbSweeper: ChannelAttachmentDbSweeper,
    opts?: { nowEpoch?: number; limit?: number; partialGraceWindowMs?: number }
  ): Promise<{ sweptRows: number; removedBlobs: number; removedPartials: number }> {
    if (!this.isAvailable()) {
      return { sweptRows: 0, removedBlobs: 0, removedPartials: 0 }
    }
    const nowEpoch = opts?.nowEpoch ?? this.now() / 1000
    const swept = await dbSweeper.sweepExpiredChannelAttachments(nowEpoch, opts?.limit)
    let removedBlobs = 0
    for (const ref of swept) {
      if (!ATTACHMENT_BLOB_RE.test(ref.storage_rel_path)) continue
      await this.removeBlob(ref.storage_rel_path)
      removedBlobs += 1
    }
    const { removed: removedPartials } = await this.cleanupOrphanPartials(
      opts?.partialGraceWindowMs ?? 5 * 60 * 1000
    )
    return { sweptRows: swept.length, removedBlobs, removedPartials }
  }
}
