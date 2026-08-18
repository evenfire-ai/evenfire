import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, rm, stat } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { dirname, resolve } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { GfsError } from '../api/errors'
import { ResourceNameError, normalizeResourceName } from '../api/resourceName'
import type { GfsUploadConfig } from '../config'
import { CommitOutcomeUnknownError, RollbackOutcomeUnknownError } from '../db/writeStore'
import type { BlobWriter, Transactor, TxClient } from '../db/writeStore'
import { PathError, normalizeResourceId } from '../storage/paths'
import type { GfsBrokeredAuthority } from '../auth/verify'
import {
  GFS_UPLOAD_V2_COMPLETE_BODY_MAX_BYTES,
  GFS_UPLOAD_V2_METADATA_BODY_MAX_BYTES,
  GfsUploadGeometryError,
  type GfsUploadPartGeometry,
  disabledGfsUploadV2Capability,
  partCountFor,
  partGeometry,
  validatePartGeometry,
} from './protocol'

export type { GfsUploadPartGeometry } from './protocol'

export interface UploadSessionQuery {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
}

export interface UploadPrincipal {
  drive: string
  ownerSubject: string
  primarySubject: string
  /** Signed authority metadata must survive every check-time reauthorization. */
  authGeneration?: number
  principalType?: 'user' | 'control-admin'
  brokeredAuthority?: GfsBrokeredAuthority
}

export interface CreateUploadSessionInput extends UploadPrincipal {
  uploadId?: string
  idempotencyKey: string
  operation: 'create' | 'replace'
  parentRid?: string
  resourceRid?: string
  name?: string
  ifMatch?: number
  sizeBytes: number
  wholeSha256?: string | null
}

export interface UploadSessionReceipt {
  uploadId: string
  drive: string
  operation: 'create' | 'replace'
  expectedBytes: number
  partBytes: number
  partCount: number
  state: string
  contiguousBytes: number
  committedBytes: number
  committedPartCount: number
  activePartCount: number
  /** Reserved part numbers currently holding a durable lease. Status-only. */
  activePartNumbers?: number[]
  expiresAt: string
  resultResourceId?: string
  resultVersion?: number
  resultSha256?: string
}

export interface UploadPartStatus {
  partNumber: number
  offsetBytes: number
  lengthBytes: number
  sha256: string
}

export interface UploadStatusPage {
  session: UploadSessionReceipt
  parts: UploadPartStatus[]
  nextCursor: string | null
}

export interface UploadSessionServiceDeps {
  db: UploadSessionQuery
  tx: Transactor
  blobs: BlobWriter
  storageMountPath: string
  config: GfsUploadConfig
  now?: () => number
  authorize?: (
    principal: UploadPrincipal,
    operation: 'create' | 'replace',
    resourceRid?: string
  ) => Promise<void>
  /** PR3 supplies this; PR2 intentionally cannot publish a resource. */
  finalize?: (
    session: UploadSessionRow,
    parts: UploadPartRow[],
    signal?: AbortSignal,
    deadlineAtMs?: number,
    principal?: UploadPrincipal
  ) => Promise<{ resourceId: string; version: number; sha256: string }>
}

export interface UploadSessionRow {
  uploadId: string
  idempotencyKey: string
  drive: string
  ownerSubject: string
  primarySubject: string
  operation: 'create' | 'replace'
  requestFingerprint: string
  parentRid: string | null
  resourceRid: string | null
  resourceName: string | null
  ifMatch: number | null
  expectedBytes: number
  partBytes: number
  partCount: number
  wholeSha256: string | null
  committedBytes: number
  contiguousBytes: number
  committedPartCount: number
  activePartCount: number
  finalizingStartedAt: string | null
  sessionEpoch: number
  state: string
  resultResourceId: string | null
  resultVersion: number | null
  resultSha256: string | null
  failureCode: string | null
  expiresAt: string
}

export interface UploadPartRow extends UploadPartStatus {
  uploadId: string
  state: 'reserved' | 'committed' | 'failed'
  stagingPath: string
  leaseEpoch: number
}

export interface UploadSessionTarget {
  operation: 'create' | 'replace'
  targetRid: string | null
}

export interface UploadReconcileResult {
  staleParts: number
  expiredSessions: number
}

interface InFlightPart {
  controller: AbortController
  sessionEpoch: number
}

interface InFlightFinalizer {
  controller: AbortController
  sessionEpoch: number
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHA256_RE = /^[0-9a-f]{64}$/i
const TEMP_PART_RE =
  /^(\d+)\.part\.tmp-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

function rowToSession(row: Record<string, unknown>): UploadSessionRow {
  return {
    uploadId: String(row.upload_id),
    idempotencyKey: String(row.idempotency_key),
    drive: String(row.drive),
    ownerSubject: String(row.owner_subject),
    primarySubject: String(row.primary_subject),
    operation: row.operation === 'replace' ? 'replace' : 'create',
    requestFingerprint: String(row.request_fingerprint),
    parentRid: row.parent_rid == null ? null : String(row.parent_rid),
    resourceRid: row.resource_rid == null ? null : String(row.resource_rid),
    resourceName: row.resource_name == null ? null : String(row.resource_name),
    ifMatch: row.if_match == null ? null : Number(row.if_match),
    expectedBytes: Number(row.expected_bytes),
    partBytes: Number(row.part_bytes),
    partCount: Number(row.part_count),
    wholeSha256: row.whole_sha256 == null ? null : String(row.whole_sha256),
    committedBytes: Number(row.committed_bytes),
    contiguousBytes: Number(row.contiguous_bytes),
    committedPartCount: Number(row.committed_part_count),
    activePartCount: Number(row.active_part_count),
    finalizingStartedAt:
      row.finalizing_started_at == null
        ? null
        : new Date(String(row.finalizing_started_at)).toISOString(),
    sessionEpoch: Number(row.session_epoch),
    state: String(row.state),
    resultResourceId: row.result_resource_id == null ? null : String(row.result_resource_id),
    resultVersion: row.result_version == null ? null : Number(row.result_version),
    resultSha256: row.result_sha256 == null ? null : String(row.result_sha256),
    failureCode: row.failure_code == null ? null : String(row.failure_code),
    expiresAt: new Date(String(row.expires_at)).toISOString(),
  }
}

function rowToPart(row: Record<string, unknown>): UploadPartRow {
  return {
    uploadId: String(row.upload_id),
    partNumber: Number(row.part_number),
    offsetBytes: Number(row.offset_bytes),
    lengthBytes: Number(row.length_bytes),
    sha256: String(row.sha256),
    state: String(row.state) as UploadPartRow['state'],
    stagingPath: String(row.staging_path),
    leaseEpoch: Number(row.lease_epoch),
  }
}

function canonicalFingerprint(
  input: CreateUploadSessionInput,
  partBytes: number,
  partCount: number
): string {
  return JSON.stringify({
    owner: input.ownerSubject,
    drive: input.drive,
    operation: input.operation,
    parentRid: input.parentRid ?? null,
    resourceRid: input.resourceRid ?? null,
    name: input.name ?? null,
    sizeBytes: input.sizeBytes,
    ifMatch: input.ifMatch ?? null,
    wholeSha256: input.wholeSha256 ?? null,
    partBytes,
    partCount,
  })
}

function normalizedName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  try {
    return normalizeResourceName(value)
  } catch (error) {
    if (error instanceof ResourceNameError) throw new GfsError('path_invalid', error.message)
    throw error
  }
}

function normalizedRid(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined
  try {
    return normalizeResourceId(value)
  } catch (error) {
    if (error instanceof PathError) throw new GfsError('path_invalid', `${field} is invalid`)
    throw error
  }
}

function requireUuid(value: string, field: string): string {
  if (!UUID_RE.test(value)) throw new GfsError('path_invalid', `${field} must be a UUID`)
  return value.toLowerCase()
}

function requireChecksum(value: string | undefined, field: string): string {
  if (value === undefined || !SHA256_RE.test(value))
    throw new GfsError('path_invalid', `${field} must be a SHA-256 hex digest`)
  return value.toLowerCase()
}

function requireEnabled(config: GfsUploadConfig): void {
  if (!config.enabled) throw new GfsError('forbidden', 'resumable GFS uploads are disabled')
}

function quotaExceeded(message: string, limit: string, limitValue: number): GfsError {
  return new GfsError('quota_exceeded', message, undefined, {
    retryAfterSeconds: 1,
    limit,
    rateLimitLimit: limitValue,
  })
}

function toReceipt(session: UploadSessionRow): UploadSessionReceipt {
  return {
    uploadId: session.uploadId,
    drive: session.drive,
    operation: session.operation,
    expectedBytes: session.expectedBytes,
    partBytes: session.partBytes,
    partCount: session.partCount,
    state: session.state,
    contiguousBytes: session.contiguousBytes,
    committedBytes: session.committedBytes,
    committedPartCount: session.committedPartCount,
    activePartCount: session.activePartCount,
    expiresAt: session.expiresAt,
    ...(session.resultResourceId ? { resultResourceId: session.resultResourceId } : {}),
    ...(session.resultVersion === null ? {} : { resultVersion: session.resultVersion }),
    ...(session.resultSha256 ? { resultSha256: session.resultSha256 } : {}),
  }
}

function assertNotExpired(session: UploadSessionRow, now: number): void {
  if (
    Date.parse(session.expiresAt) <= now &&
    !['completed', 'aborted', 'expired'].includes(session.state)
  ) {
    throw new GfsError('upload_expired', 'upload session has expired')
  }
}

function sessionPath(root: string, uploadId: string, partNumber: number, suffix: string): string {
  requireUuid(uploadId, 'uploadId')
  if (!Number.isSafeInteger(partNumber) || partNumber < 0 || partNumber > 1024) {
    throw new GfsError('path_invalid', 'part number is invalid')
  }
  const base = resolve(root)
  const dir = resolve(base, '.uploads', uploadId, 'parts')
  const path = resolve(dir, `${partNumber}.part${suffix}`)
  if (!path.startsWith(`${base}/.uploads/${uploadId}/parts/`)) {
    throw new GfsError('path_invalid', 'staging path escapes upload root')
  }
  return path
}

/**
 * A database path is metadata, never an authorization to delete an arbitrary
 * writer file. Reconciliation may unlink only the exact temporary filename
 * generated for this upload/part. The common committed `<n>.part` path is
 * intentionally rejected because a new lease may own it after the row lock is
 * released.
 */
async function validatedTempPath(
  root: string,
  uploadId: string,
  partNumber: number,
  candidate: string
): Promise<string | null> {
  const canonicalUploadId = requireUuid(uploadId, 'uploadId')
  const expectedDir = resolve(root, '.uploads', canonicalUploadId, 'parts')
  const resolved = resolve(candidate)
  const prefix = `${expectedDir}/`
  if (!resolved.startsWith(prefix)) return null
  const match = TEMP_PART_RE.exec(resolved.slice(prefix.length))
  if (!match || Number(match[1]) !== partNumber) return null
  for (const directory of [
    resolve(root),
    resolve(root, '.uploads'),
    resolve(root, '.uploads', canonicalUploadId),
    expectedDir,
  ]) {
    try {
      if (!(await lstat(directory)).isDirectory()) return null
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return resolved
      return null
    }
  }
  return resolved
}

async function ensureStagingDir(path: string): Promise<void> {
  const partsDir = dirname(path)
  const uploadDir = dirname(partsDir)
  const uploadsDir = dirname(uploadDir)
  const root = dirname(uploadsDir)
  await mkdir(partsDir, { recursive: true, mode: 0o700 })
  for (const directory of [root, uploadsDir, uploadDir, partsDir]) {
    const info = await lstat(directory)
    if (!info.isDirectory())
      throw new GfsError('path_invalid', 'upload staging ancestors must be real directories')
  }
}

async function removeIfPresent(path: string): Promise<void> {
  await rm(path, { force: true }).catch(() => undefined)
}

async function removeStrict(path: string, recursive = false): Promise<boolean> {
  try {
    await rm(path, { force: true, ...(recursive ? { recursive: true } : {}) })
    return true
  } catch {
    return false
  }
}

async function removeUploadDirectory(root: string, uploadId: string): Promise<boolean> {
  const directory = resolve(root, '.uploads', requireUuid(uploadId, 'uploadId'))
  try {
    const info = await lstat(directory)
    if (!info.isDirectory()) return false
  } catch (error) {
    return (error as { code?: string }).code === 'ENOENT'
  }
  return removeStrict(directory, true)
}

async function committedPartFilePresent(root: string, part: UploadPartRow): Promise<boolean> {
  const expected = sessionPath(root, part.uploadId, part.partNumber, '')
  if (part.stagingPath !== expected) return false
  const safe = await validatedTempPath(
    root,
    part.uploadId,
    part.partNumber,
    `${expected}.tmp-${randomUUID()}`
  )
  // validatedTempPath also validates all private ancestors. The synthetic
  // candidate is never unlinked and only serves as the containment check.
  if (!safe) return false
  try {
    const handle = await open(expected, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      return (await handle.stat()).isFile()
    } finally {
      await handle.close().catch(() => undefined)
    }
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return false
    throw error
  }
}

async function readPartBody(
  req: IncomingMessage,
  expectedLength: number,
  maxLength: number,
  destination?: string,
  signal?: AbortSignal
): Promise<{ bytes: number; sha256: string }> {
  if (!Number.isSafeInteger(expectedLength) || expectedLength <= 0 || expectedLength > maxLength) {
    throw new GfsError('payload_too_large', `part length must be between 1 and ${maxLength} bytes`)
  }
  const digest = createHash('sha256')
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let stream: import('node:fs').WriteStream | undefined
  try {
    if (destination) {
      await ensureStagingDir(destination)
      handle = await open(
        destination,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600
      )
      stream = handle.createWriteStream()
    }
    let bytes = 0
    if (stream) {
      const verifier = new Transform({
        transform(raw: Buffer | string, _encoding, callback) {
          try {
            signal?.throwIfAborted()
            const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
            bytes += chunk.length
            if (bytes > expectedLength || bytes > maxLength) {
              callback(new GfsError('payload_too_large', 'part body exceeds its declared length'))
              return
            }
            digest.update(chunk)
            callback(null, chunk)
          } catch (error) {
            callback(error as Error)
          }
        },
      })
      await pipeline(req as unknown as Readable, verifier, stream, { signal })
      // createWriteStream owns and closes this descriptor when the pipeline
      // finishes; keeping the FileHandle around would double-close it.
      handle = undefined
    } else {
      for await (const raw of req as unknown as AsyncIterable<Buffer | string>) {
        signal?.throwIfAborted()
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
        bytes += chunk.length
        if (bytes > expectedLength || bytes > maxLength)
          throw new GfsError('payload_too_large', 'part body exceeds its declared length')
        digest.update(chunk)
      }
    }
    if (bytes !== expectedLength)
      throw new GfsError('path_invalid', `part body has ${bytes} bytes; expected ${expectedLength}`)
    if (destination) {
      const syncHandle = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        await syncHandle.sync()
      } finally {
        await syncHandle.close().catch(() => undefined)
      }
    }
    const sha256 = digest.digest('hex')
    return { bytes, sha256 }
  } catch (error) {
    stream?.destroy()
    if (!stream) await handle?.close().catch(() => undefined)
    if (destination) await removeIfPresent(destination)
    const reason = signal?.reason
    if (reason instanceof GfsError) throw reason
    const cause = (error as { cause?: unknown } | undefined)?.cause
    if (cause instanceof GfsError) throw cause
    throw error
  } finally {
    if (!stream) await handle?.close().catch(() => undefined)
  }
}

/**
 * Stateful writer-side engine. It owns part geometry/leases and never hands a
 * whole file to a caller. Publication is injected by PR3 so PR2 can be tested
 * independently without silently inventing a second blob/resource writer.
 */
export class GfsUploadSessionService {
  private readonly inFlight = new Map<string, InFlightPart>()
  private readonly inFlightFinalizers = new Map<string, InFlightFinalizer>()
  private readonly canceledUploads = new Set<string>()
  /**
   * The writer is a singleton. This keyed gate closes the reservation race
   * while pause drains existing leases; committed in-flight parts are still
   * allowed to finish, then the durable state transitions to `paused`.
   */
  private readonly pauseRequested = new Set<string>()

  constructor(private readonly deps: UploadSessionServiceDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private hasInFlight(uploadId: string): boolean {
    return (
      [...this.inFlight.keys()].some(key => key.startsWith(`${uploadId}:`)) ||
      this.inFlightFinalizers.has(uploadId)
    )
  }

  async create(
    input: CreateUploadSessionInput
  ): Promise<{ created: boolean; session: UploadSessionReceipt }> {
    requireEnabled(this.deps.config)
    const idempotencyKey = requireUuid(input.idempotencyKey, 'idempotencyKey')
    if (
      !Number.isSafeInteger(input.sizeBytes) ||
      input.sizeBytes < 0 ||
      input.sizeBytes > this.deps.config.productMaxFileBytes
    ) {
      throw new GfsError(
        'payload_too_large',
        `sizeBytes must be between 0 and ${this.deps.config.productMaxFileBytes}`
      )
    }
    const name = normalizedName(input.name)
    const parentRid = normalizedRid(input.parentRid, 'parentRid')
    const resourceRid = normalizedRid(input.resourceRid, 'resourceRid')
    if (input.operation === 'create' && (!parentRid || !name))
      throw new GfsError('path_invalid', 'create requires parentRid and name')
    if (input.operation === 'replace' && !resourceRid)
      throw new GfsError('path_invalid', 'replace requires resourceRid')
    const wholeSha256 =
      input.wholeSha256 === null || input.wholeSha256 === undefined
        ? null
        : requireChecksum(input.wholeSha256, 'wholeSha256')
    await this.deps.authorize?.(
      input,
      input.operation,
      input.operation === 'create' ? parentRid : resourceRid
    )
    const partBytes = this.deps.config.preferredPartBytes
    const partCount = partCountFor({ expectedBytes: input.sizeBytes, partBytes })
    if (partCount > this.deps.config.maxPartCount)
      throw new GfsError('payload_too_large', 'upload part count exceeds the configured maximum')
    const canonicalInput = { ...input, name, parentRid, resourceRid, wholeSha256 }
    const requestFingerprint = canonicalFingerprint(canonicalInput, partBytes, partCount)
    const existing = await this.deps.db.query(
      `SELECT * FROM gfs_upload_sessions WHERE owner_subject = $1 AND drive = $2 AND idempotency_key = $3`,
      [input.ownerSubject, input.drive, idempotencyKey]
    )
    if (existing.rows[0]) {
      const row = rowToSession(existing.rows[0])
      if (row.requestFingerprint !== requestFingerprint)
        throw new GfsError(
          'idempotency_conflict',
          'idempotency key is bound to a different request'
        )
      return { created: false, session: toReceipt(row) }
    }
    const uploadId = requireUuid(input.uploadId ?? randomUUID(), 'uploadId')
    const expiresAt = new Date(this.now() + this.deps.config.sessionTtlSeconds * 1000)
    const available = this.deps.blobs.availableBytes ? await this.deps.blobs.availableBytes() : null
    try {
      const result = await this.deps.tx.transaction(async client => {
        await client.query(
          `SELECT pg_advisory_xact_lock(hashtext('gfs:upload:admission:' || $1)::bigint)`,
          [input.drive]
        )
        const subjectActive = await client.query(
          `SELECT COUNT(*)::bigint AS count FROM gfs_upload_sessions
            WHERE drive = $1 AND owner_subject = $2 AND state IN ('initiated','uploading','paused','finalizing') AND expires_at > now()`,
          [input.drive, input.ownerSubject]
        )
        if (Number(subjectActive.rows[0]?.count ?? 0) >= this.deps.config.maxActivePerSubject) {
          throw quotaExceeded(
            'active upload session subject quota reached',
            'active_sessions_subject',
            this.deps.config.maxActivePerSubject
          )
        }
        const globalActive = await client.query(
          `SELECT COUNT(*)::bigint AS count FROM gfs_upload_sessions
            WHERE state IN ('initiated','uploading','paused','finalizing') AND expires_at > now()`,
          []
        )
        if (Number(globalActive.rows[0]?.count ?? 0) >= this.deps.config.maxActiveGlobal) {
          throw quotaExceeded(
            'active upload session global quota reached',
            'active_sessions_global',
            this.deps.config.maxActiveGlobal
          )
        }
        if (available !== null) {
          const reserved = await client.query(
            `SELECT COALESCE(SUM((expected_bytes - committed_bytes) + expected_bytes), 0)::bigint AS reserved
               FROM gfs_upload_sessions
              WHERE drive = $1 AND state IN ('initiated','uploading','paused','finalizing') AND expires_at > now()`,
            [input.drive]
          )
          const reservedBytes = BigInt(String(reserved.rows[0]?.reserved ?? 0))
          if (
            reservedBytes + BigInt(input.sizeBytes) * 2n + BigInt(this.deps.config.minFreeBytes) >
            available
          ) {
            throw new GfsError(
              'insufficient_storage',
              'insufficient storage for upload reservation'
            )
          }
        }
        const inserted = await client.query(
          `INSERT INTO gfs_upload_sessions
             (upload_id, idempotency_key, drive, owner_subject, primary_subject,
              operation, request_fingerprint, parent_rid, resource_rid,
              resource_name, if_match, expected_bytes, part_bytes, part_count,
              whole_sha256, state, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'initiated',$16)
           RETURNING *`,
          [
            uploadId,
            idempotencyKey,
            input.drive,
            input.ownerSubject,
            input.primarySubject,
            input.operation,
            requestFingerprint,
            parentRid ?? null,
            resourceRid ?? null,
            name ?? null,
            input.ifMatch ?? null,
            input.sizeBytes,
            partBytes,
            partCount,
            wholeSha256,
            expiresAt,
          ]
        )
        return rowToSession(inserted.rows[0]!)
      })
      return { created: true, session: toReceipt(result) }
    } catch (error) {
      if ((error as { code?: string }).code !== '23505') throw error
      const replay = await this.deps.db.query(
        `SELECT * FROM gfs_upload_sessions WHERE owner_subject = $1 AND drive = $2 AND idempotency_key = $3`,
        [input.ownerSubject, input.drive, idempotencyKey]
      )
      const row = replay.rows[0] ? rowToSession(replay.rows[0]) : null
      if (!row) throw error
      if (row.requestFingerprint !== requestFingerprint)
        throw new GfsError(
          'idempotency_conflict',
          'idempotency key is bound to a different request'
        )
      return { created: false, session: toReceipt(row) }
    }
  }

  async get(uploadId: string, principal: UploadPrincipal): Promise<UploadSessionReceipt> {
    requireEnabled(this.deps.config)
    requireUuid(uploadId, 'uploadId')
    const result = await this.deps.db.query(
      `SELECT * FROM gfs_upload_sessions WHERE upload_id = $1 AND drive = $2 AND owner_subject = $3`,
      [uploadId, principal.drive, principal.ownerSubject]
    )
    const row = result.rows[0] ? rowToSession(result.rows[0]) : null
    if (!row) throw new GfsError('not_found', 'upload session not found')
    assertNotExpired(row, this.now())
    if (row.state === 'expired') throw new GfsError('upload_expired', 'upload session has expired')
    if (row.state === 'aborted') throw new GfsError('upload_aborted', 'upload session was canceled')
    return toReceipt(row)
  }

  async target(uploadId: string, principal: UploadPrincipal): Promise<UploadSessionTarget> {
    requireEnabled(this.deps.config)
    const session = await this.loadOwned(uploadId, principal)
    return {
      operation: session.operation,
      targetRid: session.operation === 'create' ? session.parentRid : session.resourceRid,
    }
  }

  async status(
    uploadId: string,
    principal: UploadPrincipal,
    options?: { cursor?: string; limit?: number }
  ): Promise<UploadStatusPage> {
    requireEnabled(this.deps.config)
    requireUuid(uploadId, 'uploadId')
    const rawCursor = options?.cursor ?? ''
    if (rawCursor && !/^\d+$/.test(rawCursor))
      throw new GfsError('path_invalid', 'status cursor is invalid')
    const cursor = rawCursor ? Number(rawCursor) : -1
    const requestedLimit = options?.limit ?? 256
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 256)
      throw new GfsError('path_invalid', 'status limit is invalid')
    return this.deps.tx.transaction(async client => {
      // A status response is consumed as one reconciliation snapshot. Keep
      // session state, committed parts, and durable active leases on the same
      // MVCC snapshot so a sibling reservation/commit cannot produce a stale
      // count paired with a newer part-number set.
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
      const sessionResult = await client.query(
        `SELECT * FROM gfs_upload_sessions WHERE upload_id = $1 AND drive = $2 AND owner_subject = $3`,
        [uploadId, principal.drive, principal.ownerSubject]
      )
      const sessionRow = sessionResult.rows[0]
      if (!sessionRow) throw new GfsError('not_found', 'upload session not found')
      const session = rowToSession(sessionRow)
      assertNotExpired(session, this.now())

      const result = await client.query(
        `SELECT upload_id, part_number, offset_bytes, length_bytes, sha256, state, staging_path, lease_epoch
           FROM gfs_upload_parts WHERE upload_id = $1 AND state = 'committed' AND part_number > $2 ORDER BY part_number ASC LIMIT $3`,
        [uploadId, cursor, requestedLimit + 1]
      )
      const active = await client.query(
        `SELECT part_number FROM gfs_upload_parts WHERE upload_id = $1 AND state = 'reserved' ORDER BY part_number ASC`,
        [uploadId]
      )
      const activePartNumbers = active.rows.map(row => Number(row.part_number))
      const hasMore = result.rows.length > requestedLimit
      const rows = hasMore ? result.rows.slice(0, requestedLimit) : result.rows
      const lastPart = rows.at(-1)
      return {
        session: {
          ...toReceipt(session),
          activePartCount: activePartNumbers.length,
          activePartNumbers,
        },
        parts: rows.map(row => {
          const part = rowToPart(row)
          return {
            partNumber: part.partNumber,
            offsetBytes: part.offsetBytes,
            lengthBytes: part.lengthBytes,
            sha256: part.sha256,
          }
        }),
        nextCursor: hasMore && lastPart ? String(Number(lastPart.part_number)) : null,
      }
    })
  }

  async putPart(
    uploadId: string,
    part: GfsUploadPartGeometry,
    checksum: string | undefined,
    req: IncomingMessage,
    principal: UploadPrincipal
  ): Promise<{ part: UploadPartStatus; session: UploadSessionReceipt }> {
    requireEnabled(this.deps.config)
    const expectedChecksum = requireChecksum(checksum, 'Upload-Checksum')
    const session = await this.loadOwned(uploadId, principal)
    await this.deps.authorize?.(
      principal,
      session.operation,
      session.operation === 'create'
        ? (session.parentRid ?? undefined)
        : (session.resourceRid ?? undefined)
    )
    if (this.pauseRequested.has(uploadId))
      throw new GfsError('conflict', 'upload session is pausing')
    assertNotExpired(session, this.now())
    if (session.state === 'paused') throw new GfsError('conflict', 'upload session is paused')
    if (['finalizing', 'completed'].includes(session.state))
      throw new GfsError('upload_completed', 'upload session is no longer writable')
    if (['aborted', 'expired', 'failed'].includes(session.state))
      throw new GfsError('upload_aborted', 'upload session is not writable')
    try {
      validatePartGeometry(
        { expectedBytes: session.expectedBytes, partBytes: session.partBytes },
        part
      )
    } catch (error) {
      if (error instanceof GfsUploadGeometryError) throw new GfsError('path_invalid', error.message)
      throw error
    }

    const key = `${uploadId}:${part.partNumber}`
    if (this.inFlight.has(key)) throw new GfsError('conflict', 'upload part is already in flight')
    // Register the abort controller before the reservation transaction. DELETE
    // can therefore fence and abort this request even in the small interval
    // between the DB reservation commit and the first body read.
    const controller = new AbortController()
    this.inFlight.set(key, { controller, sessionEpoch: session.sessionEpoch })
    let reserved: {
      session: UploadSessionRow
      existing: UploadPartRow | null
      stagingPath?: string
      leaseEpoch?: number
    }
    try {
      reserved = await this.deps.tx.transaction(async client => {
        const locked = await this.lockSession(client, uploadId, principal)
        if (this.pauseRequested.has(uploadId))
          throw new GfsError('conflict', 'upload session is pausing')
        if (locked.state === 'paused') throw new GfsError('conflict', 'upload session is paused')
        if (locked.state !== 'initiated' && locked.state !== 'uploading')
          throw new GfsError('upload_aborted', 'upload session is not writable')
        await client.query(
          `SELECT pg_advisory_xact_lock(hashtext('gfs:upload:streams:' || $1)::bigint)`,
          [locked.drive]
        )
        const existing = await client.query(
          `SELECT upload_id, part_number, offset_bytes, length_bytes, sha256, state, staging_path, lease_epoch
           FROM gfs_upload_parts WHERE upload_id = $1 AND part_number = $2 FOR UPDATE`,
          [uploadId, part.partNumber]
        )
        if (existing.rows[0] && String(existing.rows[0].state) === 'committed')
          return { session: locked, existing: rowToPart(existing.rows[0]) }
        if (existing.rows[0] && String(existing.rows[0].state) === 'reserved') {
          throw new GfsError('conflict', 'upload part is already in flight')
        }
        const activeGlobal = await client.query(
          `SELECT COUNT(*)::bigint AS count
           FROM gfs_upload_parts p
           JOIN gfs_upload_sessions s ON s.upload_id = p.upload_id
          WHERE s.drive = $1 AND p.state = 'reserved'`,
          [locked.drive]
        )
        if (
          Number(activeGlobal.rows[0]?.count ?? 0) >=
          this.deps.config.maxConcurrentPartStreamsGlobal
        ) {
          throw quotaExceeded(
            'global upload stream concurrency limit reached',
            'active_part_streams_global',
            this.deps.config.maxConcurrentPartStreamsGlobal
          )
        }
        // The scalar on the session is a receipt/cache field. Admission must
        // use the locked part rows as the authority so an outcome-unknown
        // commit or a stale response can never resurrect a false slot.
        const activeSession = await client.query(
          `SELECT COUNT(*)::bigint AS count
             FROM gfs_upload_parts
            WHERE upload_id = $1 AND state = 'reserved'`,
          [uploadId]
        )
        const activeSessionCount = Number(activeSession.rows[0]?.count ?? 0)
        if (activeSessionCount >= this.deps.config.maxConcurrentPartsPerSession)
          throw quotaExceeded(
            'per-session part concurrency limit reached',
            'active_part_streams_session',
            this.deps.config.maxConcurrentPartsPerSession
          )
        const stagingPath = sessionPath(
          this.deps.storageMountPath,
          uploadId,
          part.partNumber,
          `.tmp-${randomUUID()}`
        )
        const previousLeaseEpoch = existing.rows[0]
          ? Number(existing.rows[0].lease_epoch)
          : locked.sessionEpoch
        const leaseEpoch = Math.max(locked.sessionEpoch + 1, previousLeaseEpoch + 1)
        if (existing.rows[0]) {
          await client.query(
            `UPDATE gfs_upload_parts
              SET offset_bytes = $3, length_bytes = $4, sha256 = $5, state = 'reserved',
                  staging_path = $6, lease_epoch = $7, lease_started_at = now(), committed_at = NULL
            WHERE upload_id = $1 AND part_number = $2`,
            [
              uploadId,
              part.partNumber,
              part.offsetBytes,
              part.lengthBytes,
              expectedChecksum,
              stagingPath,
              leaseEpoch,
            ]
          )
        } else {
          await client.query(
            `INSERT INTO gfs_upload_parts
             (upload_id, part_number, offset_bytes, length_bytes, sha256, state, staging_path, lease_epoch, lease_started_at)
           VALUES ($1,$2,$3,$4,$5,'reserved',$6,$7,now())`,
            [
              uploadId,
              part.partNumber,
              part.offsetBytes,
              part.lengthBytes,
              expectedChecksum,
              stagingPath,
              leaseEpoch,
            ]
          )
        }
        await client.query(
          `UPDATE gfs_upload_sessions SET state = 'uploading', active_part_count = (
             SELECT COUNT(*) FROM gfs_upload_parts WHERE upload_id = $1 AND state = 'reserved'
           ), updated_at = now()
          WHERE upload_id = $1`,
          [uploadId]
        )
        const refreshed = await this.lockSession(client, uploadId, principal)
        return {
          session: refreshed,
          existing: null as UploadPartRow | null,
          stagingPath,
          leaseEpoch,
        }
      })
    } catch (error) {
      this.inFlight.delete(key)
      throw error
    }

    if (reserved.existing) {
      this.inFlight.set(key, { controller, sessionEpoch: reserved.session.sessionEpoch })
      const replayTimer = setTimeout(
        () => controller.abort(new GfsError('precondition_failed', 'upload part replay timed out')),
        this.deps.config.partTimeoutMs
      )
      replayTimer.unref?.()
      try {
        const postReplay = await this.deps.db.query(
          `SELECT session_epoch, state FROM gfs_upload_sessions WHERE upload_id = $1 AND drive = $2 AND owner_subject = $3`,
          [uploadId, principal.drive, principal.ownerSubject]
        )
        const postReplayRow = postReplay.rows[0]
        if (
          this.canceledUploads.has(uploadId) ||
          !postReplayRow ||
          String(postReplayRow.state) === 'aborted' ||
          Number(postReplayRow.session_epoch) !== reserved.session.sessionEpoch
        ) {
          controller.abort(
            new GfsError('upload_aborted', 'upload session changed while replay was starting')
          )
        }
        const observed = await readPartBody(
          req,
          reserved.existing.lengthBytes,
          this.deps.config.maxPartBytes,
          undefined,
          controller.signal
        )
        if (
          observed.sha256 !== reserved.existing.sha256 ||
          observed.bytes !== reserved.existing.lengthBytes ||
          expectedChecksum !== reserved.existing.sha256
        ) {
          throw new GfsError('conflict', 'committed part checksum or length differs')
        }
        if (this.canceledUploads.has(uploadId))
          throw new GfsError('upload_aborted', 'upload session was canceled')
        return { part: reserved.existing, session: toReceipt(reserved.session) }
      } finally {
        clearTimeout(replayTimer)
        this.inFlight.delete(key)
      }
    }
    const stagingPath = reserved.stagingPath!
    this.inFlight.set(key, { controller, sessionEpoch: reserved.session.sessionEpoch })
    const partTimer = setTimeout(
      () => controller.abort(new GfsError('precondition_failed', 'upload part timed out')),
      this.deps.config.partTimeoutMs
    )
    partTimer.unref?.()
    let finalPath: string | undefined
    try {
      const postReservation = await this.deps.db.query(
        `SELECT session_epoch, state FROM gfs_upload_sessions WHERE upload_id = $1 AND drive = $2 AND owner_subject = $3`,
        [uploadId, principal.drive, principal.ownerSubject]
      )
      const postReservationRow = postReservation.rows[0]
      if (
        this.canceledUploads.has(uploadId) ||
        !postReservationRow ||
        String(postReservationRow.state) === 'aborted' ||
        Number(postReservationRow.session_epoch) !== reserved.session.sessionEpoch
      ) {
        controller.abort(
          new GfsError('upload_aborted', 'upload session changed while part was reserving')
        )
      }
      const observed = await readPartBody(
        req,
        part.lengthBytes,
        this.deps.config.maxPartBytes,
        stagingPath,
        controller.signal
      )
      if (observed.sha256 !== expectedChecksum)
        throw new GfsError('checksum_mismatch', 'part checksum does not match Upload-Checksum')
      finalPath = sessionPath(this.deps.storageMountPath, uploadId, part.partNumber, '')
      try {
        await stat(finalPath)
        throw new GfsError('conflict', 'committed part file already exists')
      } catch (error) {
        if (error instanceof GfsError) throw error
        if ((error as { code?: string }).code !== 'ENOENT') throw error
      }
      await rename(stagingPath, finalPath)
      const committed = await this.deps.tx.transaction(async client => {
        const locked = await this.lockSession(client, uploadId, principal)
        const rowResult = await client.query(
          `SELECT upload_id, part_number, offset_bytes, length_bytes, sha256, state, staging_path, lease_epoch
             FROM gfs_upload_parts WHERE upload_id = $1 AND part_number = $2 FOR UPDATE`,
          [uploadId, part.partNumber]
        )
        const row = rowResult.rows[0] ? rowToPart(rowResult.rows[0]) : null
        if (
          !row ||
          row.state !== 'reserved' ||
          row.leaseEpoch !== reserved.leaseEpoch ||
          locked.sessionEpoch !== reserved.session.sessionEpoch ||
          locked.state !== 'uploading'
        ) {
          throw new GfsError('upload_aborted', 'upload session changed while part was in flight')
        }
        await client.query(
          `UPDATE gfs_upload_parts SET state = 'committed', staging_path = $3, committed_at = now()
            WHERE upload_id = $1 AND part_number = $2`,
          [uploadId, part.partNumber, finalPath]
        )
        await client.query(
          `UPDATE gfs_upload_sessions
              SET committed_bytes = committed_bytes + $2,
                  committed_part_count = committed_part_count + 1,
                  active_part_count = (
                    SELECT COUNT(*) FROM gfs_upload_parts WHERE upload_id = $1 AND state = 'reserved'
                  ),
                  contiguous_bytes = COALESCE((
                    SELECT SUM(p.length_bytes) FROM gfs_upload_parts p
                     WHERE p.upload_id = $1 AND p.state = 'committed'
                       AND p.part_number < COALESCE((
                         SELECT MIN(missing.part_number)
                           FROM generate_series(0, $3 - 1) AS missing(part_number)
                          WHERE NOT EXISTS (
                            SELECT 1 FROM gfs_upload_parts present
                             WHERE present.upload_id = $1 AND present.part_number = missing.part_number
                               AND present.state = 'committed'
                          )
                       ), $3)
                  ), 0),
                  updated_at = now()
            WHERE upload_id = $1`,
          [uploadId, part.lengthBytes, reserved.session.partCount]
        )
        const refreshed = await this.lockSession(client, uploadId, principal)
        return { row: { ...row, state: 'committed', stagingPath: finalPath }, session: refreshed }
      })
      return { part: committed.row, session: toReceipt(committed.session) }
    } catch (error) {
      let reconciliation: { part: UploadPartRow; session: UploadSessionRow } | null | undefined
      if (finalPath) {
        try {
          reconciliation = await this.reconcileCommittedPart(
            uploadId,
            part,
            expectedChecksum,
            reserved.leaseEpoch!,
            finalPath,
            principal
          )
        } catch {
          // A failed read cannot prove whether COMMIT reached Postgres. Keep
          // the renamed file; the writer reconciler can remove it after a
          // definitive row/lease check. Deleting here could destroy a part
          // whose transaction actually committed.
          reconciliation = undefined
        }
      }
      if (reconciliation)
        return { part: reconciliation.part, session: toReceipt(reconciliation.session) }
      await removeIfPresent(stagingPath)
      await this.deps.tx
        .transaction(async client => {
          // A definitive row lock separates a pre-commit failure from an
          // outcome-unknown commit. Only a still-reserved row with the same
          // lease may safely lose its computed final path; the lock fences a
          // fresh reservation from racing that removal.
          const currentPart = await client.query(
            `SELECT state, lease_epoch FROM gfs_upload_parts
              WHERE upload_id = $1 AND part_number = $2 FOR UPDATE`,
            [uploadId, part.partNumber]
          )
          const current = currentPart.rows[0] as
            | { state?: unknown; lease_epoch?: unknown }
            | undefined
          if (
            !current ||
            current.state !== 'reserved' ||
            Number(current.lease_epoch) !== reserved.leaseEpoch
          )
            return
          if (finalPath && !(await removeStrict(finalPath)))
            throw new Error('could not remove an orphaned committed-part path')
          const failedPart = await client.query(
            `UPDATE gfs_upload_parts SET state = 'failed', committed_at = NULL
              WHERE upload_id = $1 AND part_number = $2 AND state = 'reserved' AND lease_epoch = $3
              RETURNING 1`,
            [uploadId, part.partNumber, reserved.leaseEpoch]
          )
          // The commit transaction already decremented the durable counter when
          // it reached PostgreSQL. Only a part that was still reserved needs a
          // recovery decrement; otherwise a lost response plus an inconclusive
          // reconciliation would undercount other concurrent parts.
          if (failedPart.rows.length > 0) {
            await client.query(
              `UPDATE gfs_upload_sessions SET active_part_count = (
                SELECT COUNT(*) FROM gfs_upload_parts WHERE upload_id = $1 AND state = 'reserved'
              ), updated_at = now()
              WHERE upload_id = $1`,
              [uploadId]
            )
          }
        })
        .catch(() => undefined)
      throw error
    } finally {
      clearTimeout(partTimer)
      this.inFlight.delete(key)
    }
  }

  async pause(uploadId: string, principal: UploadPrincipal): Promise<UploadSessionReceipt> {
    requireEnabled(this.deps.config)
    const session = await this.loadOwned(uploadId, principal)
    await this.deps.authorize?.(
      principal,
      session.operation,
      session.operation === 'create'
        ? (session.parentRid ?? undefined)
        : (session.resourceRid ?? undefined)
    )
    if (session.state === 'paused') return toReceipt(session)
    if (session.state !== 'initiated' && session.state !== 'uploading')
      throw new GfsError('conflict', `cannot pause upload in ${session.state}`)
    if (this.pauseRequested.has(uploadId))
      throw new GfsError('conflict', 'upload session is already pausing')
    this.pauseRequested.add(uploadId)
    try {
      const deadline = this.now() + this.deps.config.partTimeoutMs
      for (;;) {
        const latest = await this.loadOwned(uploadId, principal)
        if (!['initiated', 'uploading'].includes(latest.state)) {
          if (latest.state === 'paused') return toReceipt(latest)
          throw new GfsError('conflict', `upload pause was interrupted by ${latest.state}`)
        }
        const localInFlight = [...this.inFlight.keys()].some(key => key.startsWith(`${uploadId}:`))
        if (latest.activePartCount === 0 && !localInFlight) {
          const paused = await this.deps.tx.transaction(async client => {
            const locked = await this.lockSession(client, uploadId, principal)
            if (locked.state === 'paused') return locked
            if (!['initiated', 'uploading'].includes(locked.state)) {
              throw new GfsError('conflict', `cannot pause upload in ${locked.state}`)
            }
            if (locked.activePartCount !== 0) return locked
            await client.query(
              `UPDATE gfs_upload_sessions SET state = 'paused', updated_at = now() WHERE upload_id = $1 AND state IN ('initiated','uploading') AND active_part_count = 0`,
              [uploadId]
            )
            return { ...locked, state: 'paused' }
          })
          if (paused.state === 'paused') return toReceipt(paused)
        }
        if (this.now() >= deadline)
          throw new GfsError(
            'precondition_failed',
            'upload pause timed out while draining in-flight parts'
          )
        await new Promise<void>(resolve =>
          setTimeout(resolve, Math.min(25, Math.max(1, deadline - this.now())))
        )
      }
    } finally {
      this.pauseRequested.delete(uploadId)
    }
  }

  async resume(uploadId: string, principal: UploadPrincipal): Promise<UploadSessionReceipt> {
    requireEnabled(this.deps.config)
    const session = await this.loadOwned(uploadId, principal)
    assertNotExpired(session, this.now())
    await this.deps.authorize?.(
      principal,
      session.operation,
      session.operation === 'create'
        ? (session.parentRid ?? undefined)
        : (session.resourceRid ?? undefined)
    )
    if (this.pauseRequested.has(uploadId))
      throw new GfsError('conflict', 'upload session is pausing')
    if (session.state === 'uploading' || session.state === 'initiated') return toReceipt(session)
    if (session.state !== 'paused')
      throw new GfsError('conflict', `cannot resume upload in ${session.state}`)
    const resumed = await this.deps.tx.transaction(async client => {
      const locked = await this.lockSession(client, uploadId, principal)
      await client.query(
        `UPDATE gfs_upload_sessions SET state = 'uploading', updated_at = now() WHERE upload_id = $1 AND state = 'paused'`,
        [uploadId]
      )
      return { ...locked, state: 'uploading' }
    })
    return toReceipt(resumed)
  }

  async cancel(uploadId: string, principal: UploadPrincipal): Promise<void> {
    requireEnabled(this.deps.config)
    const session = await this.loadOwned(uploadId, principal)
    await this.deps.authorize?.(
      principal,
      session.operation,
      session.operation === 'create'
        ? (session.parentRid ?? undefined)
        : (session.resourceRid ?? undefined)
    )
    if (session.state === 'completed')
      throw new GfsError('upload_completed', 'completed upload cannot be canceled')
    if (session.state === 'finalizing')
      throw new GfsError('upload_finalizing', 'upload finalization is in progress')
    if (session.state === 'aborted') return
    this.canceledUploads.add(uploadId)
    try {
      await this.deps.tx.transaction(async client => {
        const locked = await this.lockSession(client, uploadId, principal)
        if (locked.state === 'finalizing')
          throw new GfsError('upload_finalizing', 'upload finalization is in progress')
        if (locked.state === 'completed')
          throw new GfsError('upload_completed', 'completed upload cannot be canceled')
        // Once the row is fenced as aborted no new reservation can enter. Any
        // reserved rows are now owned by the cancel drain (or the startup
        // reconciler), so the durable counter must not keep DELETE waiting for
        // a process that may have crashed before registering an in-flight
        // controller.
        await client.query(
          `UPDATE gfs_upload_sessions SET state = 'aborted', session_epoch = session_epoch + 1, active_part_count = 0, updated_at = now() WHERE upload_id = $1`,
          [uploadId]
        )
        await client.query(
          `UPDATE gfs_upload_parts SET state = 'failed' WHERE upload_id = $1 AND state = 'reserved'`,
          [uploadId]
        )
      })
    } catch (error) {
      this.canceledUploads.delete(uploadId)
      throw error
    }
    for (const [key, flight] of this.inFlight) {
      if (key.startsWith(`${uploadId}:`))
        flight.controller.abort(new GfsError('upload_aborted', 'upload canceled'))
    }
    await this.waitForActivePartsZero(uploadId, principal)
    await this.deps.tx.transaction(async client => {
      await client.query(`DELETE FROM gfs_upload_parts WHERE upload_id = $1`, [uploadId])
    })
    const cleaned = await removeUploadDirectory(this.deps.storageMountPath, uploadId)
    if (cleaned) {
      await this.deps.tx.transaction(async client => {
        await client.query(`DELETE FROM gfs_upload_parts WHERE upload_id = $1`, [uploadId])
        await client.query(
          `UPDATE gfs_upload_sessions SET cleanup_at = now(), updated_at = now() WHERE upload_id = $1 AND state = 'aborted'`,
          [uploadId]
        )
      })
    }
    this.canceledUploads.delete(uploadId)
  }

  /**
   * Crash/expiry repair hook. It is deliberately writer-only: callers should
   * run it from the writer's periodic maintenance loop, never from a reader.
   */
  async reconcile(): Promise<UploadReconcileResult> {
    const uploadDirs = new Map<string, { purgeReceipt: boolean }>()
    let staleParts = 0
    let expiredSessions = 0
    await this.deps.tx.transaction(async client => {
      const stale = await client.query(
        `SELECT p.upload_id, p.part_number, p.staging_path
           FROM gfs_upload_parts p
           JOIN gfs_upload_sessions s ON s.upload_id = p.upload_id
          WHERE p.state = 'reserved' AND p.lease_started_at < now() - ($1::bigint * interval '1 millisecond')
           LIMIT 100
           FOR UPDATE SKIP LOCKED`,
        [this.deps.config.stalePartLeaseMs]
      )
      for (const row of stale.rows) {
        const uploadId = String(row.upload_id)
        const partNumber = Number(row.part_number)
        const safePath = await validatedTempPath(
          this.deps.storageMountPath,
          uploadId,
          partNumber,
          String(row.staging_path)
        )
        if (!safePath) continue
        // The row lock fences a new lease for this part. Remove both the
        // recorded temporary file and a possible rename-before-commit orphan
        // while the lock is still held; deleting the common final path after
        // releasing the row would race a fresh reservation.
        if (
          !(
            (await removeStrict(safePath)) &&
            (await removeStrict(sessionPath(this.deps.storageMountPath, uploadId, partNumber, '')))
          )
        )
          continue
        const failed = await client.query(
          `UPDATE gfs_upload_parts SET state = 'failed', committed_at = NULL
            WHERE upload_id = $1 AND part_number = $2 AND state = 'reserved'
            RETURNING staging_path`,
          [row.upload_id, row.part_number]
        )
        if (failed.rows.length === 1) {
          await client.query(
            `UPDATE gfs_upload_sessions SET active_part_count = (
              SELECT COUNT(*) FROM gfs_upload_parts WHERE upload_id = $1 AND state = 'reserved'
            ), updated_at = now()
            WHERE upload_id = $1`,
            [row.upload_id]
          )
        }
        if (failed.rows.length === 1) staleParts += 1
      }
      const staleFinalizers = await client.query(
        `SELECT upload_id
           FROM gfs_upload_sessions
          WHERE state = 'finalizing'
            AND finalizing_started_at IS NOT NULL
            AND finalizing_started_at < now() - ($1::bigint * interval '1 millisecond')
          LIMIT 100
          FOR UPDATE SKIP LOCKED`,
        [this.deps.config.finalizeTimeoutMs]
      )
      for (const row of staleFinalizers.rows) {
        const uploadId = String(row.upload_id)
        // A live finalizer owns the in-process fence. A different writer may
        // still finish against the same row, so the session epoch update below
        // is the durable fence that makes any late publication fail closed.
        if (this.inFlightFinalizers.has(uploadId)) continue
        await client.query(
          `UPDATE gfs_upload_sessions
              SET state = 'uploading', session_epoch = session_epoch + 1,
                  finalizing_started_at = NULL,
                  expires_at = GREATEST(
                    expires_at,
                    now() + ($2::bigint * interval '1 second')
                  ),
                  updated_at = now()
            WHERE upload_id = $1 AND state = 'finalizing'`,
          [uploadId, this.deps.config.sessionTtlSeconds]
        )
      }
      const expired = await client.query(
        `SELECT upload_id FROM gfs_upload_sessions
          WHERE expires_at <= now()
            AND (
              state IN ('initiated','uploading','paused')
              OR (state = 'finalizing' AND finalizing_started_at IS NULL)
            )
          LIMIT 100
          FOR UPDATE SKIP LOCKED`,
        []
      )
      for (const row of expired.rows) {
        const uploadId = String(row.upload_id)
        // A local finalizer may belong to an older rolling-deploy process that
        // did not persist its start timestamp. Let that process settle before
        // expiring the row; the next reconciliation fences it if it remains
        // expired, while avoiding a local self-cancel during the same cycle.
        if (this.inFlightFinalizers.has(uploadId)) continue
        uploadDirs.set(uploadId, { purgeReceipt: false })
        this.canceledUploads.add(uploadId)
        await client.query(
          `UPDATE gfs_upload_sessions SET state = 'expired', session_epoch = session_epoch + 1, active_part_count = 0, updated_at = now()
            WHERE upload_id = $1`,
          [uploadId]
        )
        await client.query(`DELETE FROM gfs_upload_parts WHERE upload_id = $1`, [uploadId])
        expiredSessions += 1
      }
      const committed = await client.query(
        `SELECT p.upload_id, p.part_number, p.offset_bytes, p.length_bytes, p.sha256, p.state, p.staging_path, p.lease_epoch
           FROM gfs_upload_parts p
           JOIN gfs_upload_sessions s ON s.upload_id = p.upload_id
          WHERE p.state = 'committed' AND s.state IN ('uploading','paused','finalizing')
          ORDER BY p.committed_at ASC NULLS FIRST
          LIMIT 100
          FOR UPDATE OF p SKIP LOCKED`,
        []
      )
      for (const row of committed.rows) {
        const part = rowToPart(row)
        if (await committedPartFilePresent(this.deps.storageMountPath, part)) continue
        await client.query(
          `UPDATE gfs_upload_sessions
              SET state = 'failed', failure_code = 'corrupt_part_missing', session_epoch = session_epoch + 1,
                  active_part_count = 0, updated_at = now()
            WHERE upload_id = $1 AND state IN ('uploading','paused','finalizing')`,
          [part.uploadId]
        )
        uploadDirs.set(part.uploadId, { purgeReceipt: false })
        this.canceledUploads.add(part.uploadId)
      }
      const terminal = await client.query(
        `SELECT upload_id, state FROM gfs_upload_sessions
          WHERE state IN ('aborted', 'expired', 'failed', 'completed') AND cleanup_at IS NULL
          ORDER BY updated_at ASC
          LIMIT 100`,
        []
      )
      for (const row of terminal.rows) {
        const uploadId = String(row.upload_id)
        uploadDirs.set(uploadId, { purgeReceipt: false })
        this.canceledUploads.add(uploadId)
      }
      const purge = await client.query(
        `SELECT upload_id FROM gfs_upload_sessions
          WHERE state = 'completed' AND cleanup_at <= now() - ($1::bigint * interval '1 second')
          ORDER BY cleanup_at ASC
          LIMIT 100`,
        [this.deps.config.receiptRetentionSeconds]
      )
      for (const row of purge.rows) {
        const uploadId = String(row.upload_id)
        uploadDirs.set(uploadId, { purgeReceipt: true })
      }
    })
    for (const [uploadId, cleanup] of uploadDirs) {
      for (const [key, flight] of this.inFlight) {
        if (key.startsWith(`${uploadId}:`))
          flight.controller.abort(
            new GfsError('upload_aborted', 'upload session expired or was canceled')
          )
      }
      this.inFlightFinalizers
        .get(uploadId)
        ?.controller.abort(new GfsError('upload_aborted', 'upload session expired or was canceled'))
      const deadline = this.now() + this.deps.config.partTimeoutMs
      while (this.hasInFlight(uploadId) && this.now() < deadline) {
        await new Promise<void>(resolve => setTimeout(resolve, 25))
      }
      if (
        !this.hasInFlight(uploadId) &&
        (await removeUploadDirectory(this.deps.storageMountPath, uploadId))
      ) {
        await this.deps.tx
          .transaction(async client => {
            await client.query(`DELETE FROM gfs_upload_parts WHERE upload_id = $1`, [uploadId])
            if (cleanup.purgeReceipt) {
              await client.query(
                `DELETE FROM gfs_upload_sessions WHERE upload_id = $1 AND state = 'completed'`,
                [uploadId]
              )
            } else {
              await client.query(
                `UPDATE gfs_upload_sessions SET cleanup_at = now(), updated_at = now() WHERE upload_id = $1 AND state IN ('aborted','expired','failed','completed')`,
                [uploadId]
              )
            }
          })
          .catch(() => undefined)
        this.canceledUploads.delete(uploadId)
      } else {
        // Rotate failed cleanup attempts so a permanently broken oldest batch
        // cannot starve newer terminal sessions. The terminal row remains
        // eligible (`cleanup_at IS NULL`) and will be retried next cycle.
        await this.deps.tx
          .transaction(async client => {
            await client.query(
              `UPDATE gfs_upload_sessions SET updated_at = now()
               WHERE upload_id = $1 AND state IN ('aborted','expired','failed','completed') AND cleanup_at IS NULL`,
              [uploadId]
            )
          })
          .catch(() => undefined)
        // A terminal session with no registered flight no longer needs the
        // in-memory cancellation fence. Keep it only while an operation is
        // still alive so repeated filesystem failures cannot leak one set
        // entry per terminal upload; the durable terminal row remains the
        // authority for the next reconciliation cycle.
        if (!this.hasInFlight(uploadId)) this.canceledUploads.delete(uploadId)
      }
    }
    return { staleParts, expiredSessions }
  }

  async complete(
    uploadId: string,
    principal: UploadPrincipal,
    wholeSha256?: string | null
  ): Promise<UploadSessionReceipt> {
    requireEnabled(this.deps.config)
    const session = await this.loadOwned(uploadId, principal)
    assertNotExpired(session, this.now())
    await this.deps.authorize?.(
      principal,
      session.operation,
      session.operation === 'create'
        ? (session.parentRid ?? undefined)
        : (session.resourceRid ?? undefined)
    )
    if (this.pauseRequested.has(uploadId))
      throw new GfsError('conflict', 'upload session is pausing')
    if (session.state === 'completed') return toReceipt(session)
    if (session.state === 'finalizing')
      throw new GfsError('upload_finalizing', 'upload finalization is already in progress')
    if (!this.deps.finalize)
      throw new GfsError('not_mounted', 'upload finalization is not available yet')
    const expectedWhole =
      wholeSha256 === null || wholeSha256 === undefined
        ? session.wholeSha256
        : requireChecksum(wholeSha256, 'wholeSha256')
    const started: UploadSessionRow & { parts?: UploadPartRow[] } = await this.deps.tx.transaction(
      async client => {
        const locked = await this.lockSession(client, uploadId, principal)
        if (this.pauseRequested.has(uploadId))
          throw new GfsError('conflict', 'upload session is pausing')
        if (locked.state === 'completed') return locked
        if (locked.state === 'finalizing')
          throw new GfsError('upload_finalizing', 'upload finalization is already in progress')
        if (!['initiated', 'uploading', 'paused'].includes(locked.state)) {
          if (locked.state === 'aborted')
            throw new GfsError('upload_aborted', 'upload session was canceled')
          if (locked.state === 'expired')
            throw new GfsError('upload_expired', 'upload session has expired')
          throw new GfsError('conflict', `cannot complete upload in ${locked.state}`)
        }
        if (locked.wholeSha256 && expectedWhole && locked.wholeSha256 !== expectedWhole) {
          throw new GfsError('conflict', 'whole-file checksum differs from the session checksum')
        }
        const parts = await client.query(
          `SELECT upload_id, part_number, offset_bytes, length_bytes, sha256, state, staging_path, lease_epoch FROM gfs_upload_parts WHERE upload_id = $1 AND state = 'committed' ORDER BY part_number`,
          [uploadId]
        )
        const committedParts = parts.rows.map(rowToPart)
        if (committedParts.length !== locked.partCount)
          throw new GfsError('upload_incomplete', 'not all upload parts are committed')
        for (let index = 0; index < locked.partCount; index += 1) {
          const actual = committedParts[index]
          const expected = partGeometry(
            { expectedBytes: locked.expectedBytes, partBytes: locked.partBytes },
            index
          )
          if (
            !actual ||
            actual.partNumber !== expected.partNumber ||
            actual.offsetBytes !== expected.offsetBytes ||
            actual.lengthBytes !== expected.lengthBytes
          ) {
            throw new GfsError(
              'upload_incomplete',
              `upload part ${index} does not match the session geometry`
            )
          }
        }
        if (
          locked.activePartCount !== 0 ||
          locked.committedPartCount !== locked.partCount ||
          locked.committedBytes !== locked.expectedBytes
        )
          throw new GfsError('upload_incomplete', 'not all upload parts are committed')
        await client.query(
          `SELECT pg_advisory_xact_lock(hashtext('gfs:upload:finalizers')::bigint)`,
          []
        )
        const finalizing = await client.query(
          `SELECT COUNT(*)::bigint AS count FROM gfs_upload_sessions WHERE state = 'finalizing'`,
          []
        )
        if (Number(finalizing.rows[0]?.count ?? 0) >= this.deps.config.maxConcurrentFinalizations) {
          throw quotaExceeded(
            'upload finalization concurrency limit reached',
            'active_finalizations',
            this.deps.config.maxConcurrentFinalizations
          )
        }
        if (!locked.wholeSha256 && expectedWhole) {
          await client.query(
            `UPDATE gfs_upload_sessions SET whole_sha256 = $2, updated_at = now() WHERE upload_id = $1`,
            [uploadId, expectedWhole]
          )
        }
        await client.query(
          `UPDATE gfs_upload_sessions
              SET state = 'finalizing',
                  finalizing_started_at = now(),
                  expires_at = GREATEST(
                    expires_at,
                    now() + ($3::bigint * interval '1 millisecond')
                  ),
                  updated_at = now()
            WHERE upload_id = $1 AND session_epoch = $2`,
          [uploadId, locked.sessionEpoch, this.deps.config.finalizeTimeoutMs]
        )
        // Re-read the row while the transaction lock is held. The finalizer
        // and any receipt now carry the durable deadline, not the pre-
        // finalization session TTL that could expire during publication.
        const refreshed = await this.lockSession(client, uploadId, principal)
        return {
          ...refreshed,
          wholeSha256: expectedWhole ?? locked.wholeSha256,
          state: 'finalizing' as const,
          parts: committedParts,
        }
      }
    )
    if (started.state === 'completed') return toReceipt(started)
    if (!started.parts) throw new GfsError('internal', 'finalization parts were not loaded')
    let receipt: { resourceId: string; version: number; sha256: string }
    const finalizationAbort = new AbortController()
    const finalizationDeadlineAtMs = this.now() + this.deps.config.finalizeTimeoutMs
    const finalizationTimer = setTimeout(
      () =>
        finalizationAbort.abort(
          new GfsError('precondition_failed', 'upload finalization timed out')
        ),
      Math.max(1, this.deps.config.finalizeTimeoutMs)
    )
    finalizationTimer.unref?.()
    if (this.inFlightFinalizers.has(uploadId)) {
      clearTimeout(finalizationTimer)
      throw new GfsError('upload_finalizing', 'upload finalization is already in progress')
    }
    this.inFlightFinalizers.set(uploadId, {
      controller: finalizationAbort,
      sessionEpoch: started.sessionEpoch,
    })
    try {
      receipt = await this.deps.finalize(
        started,
        started.parts,
        finalizationAbort.signal,
        finalizationDeadlineAtMs,
        principal
      )
    } catch (error) {
      const failureCode = error instanceof GfsError ? error.code : 'finalization_failed'
      let ownsFailureCleanup = false
      await this.deps.tx.transaction(async client => {
        const locked = await this.lockSession(client, uploadId, principal)
        if (locked.state === 'finalizing' && locked.sessionEpoch === started.sessionEpoch) {
          const transitioned = await client.query(
            `UPDATE gfs_upload_sessions
                SET state = 'failed', failure_code = $2, active_part_count = 0,
                    finalizing_started_at = NULL, updated_at = now()
              WHERE upload_id = $1 AND state = 'finalizing' AND session_epoch = $3
              RETURNING upload_id`,
            [uploadId, failureCode, started.sessionEpoch]
          )
          ownsFailureCleanup = transitioned.rows.length === 1
        }
      })
      // `deps.finalize` has already settled, so this controller no longer
      // represents active work. Release it before draining; otherwise
      // waitForQuiescence observes the current finalizer and waits on itself
      // until the part timeout, preventing the direct failure cleanup below.
      const current = this.inFlightFinalizers.get(uploadId)
      if (current?.controller === finalizationAbort) this.inFlightFinalizers.delete(uploadId)
      // A reclaimed epoch belongs to a newer attempt. The old finalizer may
      // report its own failure, but it must never delete shared parts or the
      // staging directory owned by the reclaimed session.
      if (!ownsFailureCleanup) throw error
      await this.waitForQuiescence(uploadId)
      if (
        !this.hasInFlight(uploadId) &&
        (await removeUploadDirectory(this.deps.storageMountPath, uploadId))
      ) {
        await this.deps.tx
          .transaction(async client => {
            await client.query(
              `DELETE FROM gfs_upload_parts
                WHERE upload_id = $1
                  AND EXISTS (
                    SELECT 1 FROM gfs_upload_sessions
                     WHERE upload_id = $1 AND state = 'failed' AND session_epoch = $2
                  )`,
              [uploadId, started.sessionEpoch]
            )
            await client.query(
              `UPDATE gfs_upload_sessions SET cleanup_at = now(), updated_at = now()
                WHERE upload_id = $1 AND state = 'failed' AND session_epoch = $2`,
              [uploadId, started.sessionEpoch]
            )
          })
          .catch(() => undefined)
      }
      throw error
    } finally {
      clearTimeout(finalizationTimer)
      const current = this.inFlightFinalizers.get(uploadId)
      if (current?.controller === finalizationAbort) this.inFlightFinalizers.delete(uploadId)
    }
    let completed: UploadSessionRow
    try {
      completed = await this.deps.tx.transaction(async client => {
        const locked = await this.lockSession(client, uploadId, principal)
        if (locked.state === 'completed') return locked
        if (locked.state !== 'finalizing' || locked.sessionEpoch !== started.sessionEpoch)
          throw new GfsError('upload_aborted', 'upload session changed during finalization')
        await client.query(
          `UPDATE gfs_upload_sessions SET state = 'completed', result_resource_id = $2, result_version = $3, result_sha256 = $4, completed_at = now(), finalizing_started_at = NULL, updated_at = now() WHERE upload_id = $1`,
          [uploadId, receipt.resourceId, receipt.version, receipt.sha256]
        )
        return {
          ...locked,
          state: 'completed',
          resultResourceId: receipt.resourceId,
          resultVersion: receipt.version,
          resultSha256: receipt.sha256,
        }
      })
    } catch (error) {
      if (
        error instanceof CommitOutcomeUnknownError ||
        error instanceof RollbackOutcomeUnknownError
      ) {
        const observed = await this.deps.db.query(
          `SELECT * FROM gfs_upload_sessions WHERE upload_id = $1 AND drive = $2 AND owner_subject = $3`,
          [uploadId, principal.drive, principal.ownerSubject]
        )
        const row = observed.rows[0] ? rowToSession(observed.rows[0]) : null
        if (
          row?.state === 'completed' &&
          row.resultResourceId === receipt.resourceId &&
          row.resultVersion === receipt.version &&
          row.resultSha256 === receipt.sha256
        ) {
          completed = row
        } else {
          throw error
        }
      } else {
        throw error
      }
    }
    if (await removeUploadDirectory(this.deps.storageMountPath, uploadId)) {
      await this.deps.tx
        .transaction(async client => {
          await client.query(`DELETE FROM gfs_upload_parts WHERE upload_id = $1`, [uploadId])
          await client.query(
            `UPDATE gfs_upload_sessions SET cleanup_at = now(), updated_at = now() WHERE upload_id = $1 AND state = 'completed'`,
            [uploadId]
          )
        })
        .catch(() => undefined)
    }
    return toReceipt(completed)
  }

  private async loadOwned(uploadId: string, principal: UploadPrincipal): Promise<UploadSessionRow> {
    requireUuid(uploadId, 'uploadId')
    const result = await this.deps.db.query(
      `SELECT * FROM gfs_upload_sessions WHERE upload_id = $1 AND drive = $2 AND owner_subject = $3`,
      [uploadId, principal.drive, principal.ownerSubject]
    )
    if (!result.rows[0]) throw new GfsError('not_found', 'upload session not found')
    const session = rowToSession(result.rows[0])
    assertNotExpired(session, this.now())
    return session
  }

  private async waitForActivePartsZero(
    uploadId: string,
    principal: UploadPrincipal
  ): Promise<void> {
    const deadline = this.now() + this.deps.config.partTimeoutMs
    for (;;) {
      const result = await this.deps.db.query(
        `SELECT * FROM gfs_upload_sessions WHERE upload_id = $1 AND drive = $2 AND owner_subject = $3`,
        [uploadId, principal.drive, principal.ownerSubject]
      )
      const row = result.rows[0] ? rowToSession(result.rows[0]) : null
      if (!row) throw new GfsError('not_found', 'upload session not found')
      const localInFlight = this.hasInFlight(uploadId)
      if (row.activePartCount === 0 && !localInFlight) return
      if (this.now() >= deadline)
        throw new GfsError(
          'precondition_failed',
          'upload cancellation timed out while draining in-flight parts'
        )
      await new Promise<void>(resolve =>
        setTimeout(resolve, Math.min(25, Math.max(1, deadline - this.now())))
      )
    }
  }

  private async waitForQuiescence(uploadId: string): Promise<void> {
    const deadline = this.now() + this.deps.config.partTimeoutMs
    while (this.hasInFlight(uploadId) && this.now() < deadline) {
      await new Promise<void>(resolve => setTimeout(resolve, 25))
    }
  }

  private async reconcileCommittedPart(
    uploadId: string,
    part: GfsUploadPartGeometry,
    checksum: string,
    leaseEpoch: number,
    finalPath: string,
    principal: UploadPrincipal
  ): Promise<{ part: UploadPartRow; session: UploadSessionRow } | null> {
    const result = await this.deps.db.query(
      `SELECT upload_id, part_number, offset_bytes, length_bytes, sha256, state, staging_path, lease_epoch
         FROM gfs_upload_parts WHERE upload_id = $1 AND part_number = $2`,
      [uploadId, part.partNumber]
    )
    if (!result.rows[0]) return null
    const committedPart = rowToPart(result.rows[0])
    if (
      committedPart.state !== 'committed' ||
      committedPart.sha256 !== checksum ||
      committedPart.offsetBytes !== part.offsetBytes ||
      committedPart.lengthBytes !== part.lengthBytes ||
      committedPart.leaseEpoch !== leaseEpoch ||
      committedPart.stagingPath !== finalPath
    )
      return null
    const sessionResult = await this.deps.db.query(
      `SELECT * FROM gfs_upload_sessions WHERE upload_id = $1 AND drive = $2 AND owner_subject = $3`,
      [uploadId, principal.drive, principal.ownerSubject]
    )
    if (!sessionResult.rows[0]) return null
    const session = rowToSession(sessionResult.rows[0])
    if (['aborted', 'expired', 'failed'].includes(session.state)) return null
    return { part: committedPart, session }
  }

  private async lockSession(
    client: TxClient,
    uploadId: string,
    principal: UploadPrincipal
  ): Promise<UploadSessionRow> {
    const result = await client.query(
      `SELECT * FROM gfs_upload_sessions WHERE upload_id = $1 AND drive = $2 AND owner_subject = $3 FOR UPDATE`,
      [uploadId, principal.drive, principal.ownerSubject]
    )
    if (!result.rows[0]) throw new GfsError('not_found', 'upload session not found')
    return rowToSession(result.rows[0])
  }
}

export const GFS_UPLOAD_REQUEST_BODY_LIMITS = {
  metadataBytes: GFS_UPLOAD_V2_METADATA_BODY_MAX_BYTES,
  completeBytes: GFS_UPLOAD_V2_COMPLETE_BODY_MAX_BYTES,
}

export function uploadCapabilities(
  enabled: boolean,
  config: GfsUploadConfig
): {
  legacyBase64: { enabled: true; maxFileBytes: number }
  resumableV2:
    | ReturnType<typeof disabledGfsUploadV2Capability>
    | {
        enabled: true
        maxFileBytes: number
        preferredChunkBytes: number
        maxChunkBytes: number
        maxConcurrentPartsPerSession: number
        fallbackConcurrency: number
        maxConcurrentPartStreamsGlobal: number
        instabilityFailureThreshold: number
        sessionTtlSeconds: number
        checksumAlgorithms: ['sha256']
        wholeFileChecksumRequired: boolean
      }
} {
  if (!enabled)
    return {
      legacyBase64: { enabled: true, maxFileBytes: 16 * 1024 * 1024 },
      resumableV2: disabledGfsUploadV2Capability(),
    }
  return {
    legacyBase64: { enabled: true, maxFileBytes: 16 * 1024 * 1024 },
    resumableV2: {
      enabled: true,
      maxFileBytes: config.productMaxFileBytes,
      preferredChunkBytes: config.preferredPartBytes,
      maxChunkBytes: config.maxPartBytes,
      maxConcurrentPartsPerSession: config.maxConcurrentPartsPerSession,
      fallbackConcurrency: config.fallbackConcurrency,
      maxConcurrentPartStreamsGlobal: config.maxConcurrentPartStreamsGlobal,
      instabilityFailureThreshold: config.instabilityFailureThreshold,
      sessionTtlSeconds: config.sessionTtlSeconds,
      checksumAlgorithms: ['sha256'],
      wholeFileChecksumRequired: false,
    },
  }
}
