import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { GfsUploadConfig } from '../config'
import {
  CommitOutcomeUnknownError,
  type TransactionOptions,
  type Transactor,
  type TxClient,
} from '../db/writeStore'
import { GFS_UPLOAD_V2_PRODUCT_MAX_BYTES, partGeometry } from './protocol'
import { GfsUploadSessionService, type UploadSessionServiceDeps } from './uploadSession'

type Row = Record<string, unknown>

class MemoryDb {
  sessions: Row[] = []
  parts: Row[] = []
  failReconciliationReads = false

  async query(text: string, values: unknown[] = []): Promise<{ rows: Row[] }> {
    const sql = text.replace(/\s+/g, ' ').trim()
    if (sql === 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ') return { rows: [] }
    if (sql.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [] }
    if (sql.startsWith('SELECT * FROM gfs_upload_sessions WHERE owner_subject')) {
      const [owner, drive, key] = values.map(String)
      return {
        rows: this.sessions.filter(
          row => row.owner_subject === owner && row.drive === drive && row.idempotency_key === key
        ),
      }
    }
    if (sql.startsWith('SELECT * FROM gfs_upload_sessions WHERE upload_id')) {
      const [id, drive, owner] = values.map(String)
      return {
        rows: this.sessions.filter(
          row => row.upload_id === id && row.drive === drive && row.owner_subject === owner
        ),
      }
    }
    if (sql.startsWith('SELECT session_epoch, state FROM gfs_upload_sessions WHERE upload_id')) {
      const [id, drive, owner] = values.map(String)
      return {
        rows: this.sessions
          .filter(row => row.upload_id === id && row.drive === drive && row.owner_subject === owner)
          .map(row => ({ session_epoch: row.session_epoch, state: row.state })),
      }
    }
    if (
      sql.startsWith('SELECT p.upload_id, p.part_number, p.staging_path FROM gfs_upload_parts p')
    ) {
      return { rows: [] }
    }
    if (
      sql.startsWith(
        "SELECT upload_id FROM gfs_upload_sessions WHERE state IN ('initiated','uploading','paused','finalizing') AND expires_at <= now()"
      )
    ) {
      return { rows: [] }
    }
    if (sql.startsWith('SELECT p.upload_id, p.part_number, p.offset_bytes, p.length_bytes')) {
      return { rows: [] }
    }
    if (
      sql.startsWith(
        "SELECT upload_id, state FROM gfs_upload_sessions WHERE state IN ('aborted', 'expired', 'failed', 'completed') AND cleanup_at IS NULL"
      )
    ) {
      return {
        rows: this.sessions
          .filter(
            row =>
              ['aborted', 'expired', 'failed', 'completed'].includes(String(row.state)) &&
              row.cleanup_at == null
          )
          .map(row => ({ upload_id: row.upload_id, state: row.state })),
      }
    }
    if (
      sql.startsWith(
        "SELECT upload_id FROM gfs_upload_sessions WHERE state = 'completed' AND cleanup_at <= now()"
      )
    ) {
      return { rows: [] }
    }
    if (
      sql.startsWith('SELECT COALESCE(SUM((expected_bytes - committed_bytes) + expected_bytes)')
    ) {
      const drive = String(values[0])
      const reserved = this.sessions
        .filter(
          row =>
            row.drive === drive &&
            ['initiated', 'uploading', 'paused', 'finalizing'].includes(String(row.state))
        )
        .reduce(
          (sum, row) =>
            sum +
            (Number(row.expected_bytes) - Number(row.committed_bytes ?? 0)) +
            Number(row.expected_bytes),
          0
        )
      return { rows: [{ reserved: String(reserved) }] }
    }
    if (
      sql === "SELECT COUNT(*)::bigint AS count FROM gfs_upload_sessions WHERE state = 'finalizing'"
    ) {
      return {
        rows: [{ count: String(this.sessions.filter(row => row.state === 'finalizing').length) }],
      }
    }
    if (sql.startsWith('SELECT COUNT(*)::bigint AS count FROM gfs_upload_sessions')) {
      const [drive, owner] = values.map(value => (value === undefined ? undefined : String(value)))
      const active = this.sessions.filter(
        row =>
          ['initiated', 'uploading', 'paused', 'finalizing'].includes(String(row.state)) &&
          (drive === undefined || row.drive === drive) &&
          (owner === undefined || row.owner_subject === owner)
      ).length
      return { rows: [{ count: String(active) }] }
    }
    if (sql.startsWith('SELECT COUNT(*)::bigint')) {
      if (sql.includes('FROM gfs_upload_parts WHERE upload_id = $1 AND state = \'reserved\'')) {
        const uploadId = String(values[0])
        return {
          rows: [{
            count: String(
              this.parts.filter(part => part.upload_id === uploadId && part.state === 'reserved').length
            ),
          }],
        }
      }
      const drive = String(values[0])
      return {
        rows: [
          {
            count: String(
              this.parts.filter(
                part =>
                  part.state === 'reserved' &&
                  this.sessions.some(
                    session => session.upload_id === part.upload_id && session.drive === drive
                  )
              ).length
            ),
          },
        ],
      }
    }
    if (
      sql.startsWith('SELECT upload_id FROM gfs_upload_sessions') &&
      sql.includes("state = 'finalizing'")
    ) {
      return { rows: [] }
    }
    if (sql.startsWith('INSERT INTO gfs_upload_sessions')) {
      const [
        uploadId,
        key,
        drive,
        owner,
        primary,
        operation,
        fingerprint,
        parent,
        resource,
        name,
        ifMatch,
        expected,
        partBytes,
        partCount,
        sha,
        expiresAt,
      ] = values
      const row: Row = {
        upload_id: String(uploadId),
        idempotency_key: String(key),
        drive: String(drive),
        owner_subject: String(owner),
        primary_subject: String(primary),
        operation: String(operation),
        request_fingerprint: String(fingerprint),
        parent_rid: parent,
        resource_rid: resource,
        resource_name: name,
        if_match: ifMatch,
        expected_bytes: expected,
        part_bytes: partBytes,
        part_count: partCount,
        whole_sha256: sha,
        committed_bytes: 0,
        contiguous_bytes: 0,
        committed_part_count: 0,
        active_part_count: 0,
        session_epoch: 0,
        state: 'initiated',
        result_resource_id: null,
        result_version: null,
        result_sha256: null,
        failure_code: null,
        expires_at: expiresAt,
        completed_at: null,
        finalizing_started_at: null,
        cleanup_at: null,
      }
      this.sessions.push(row)
      return { rows: [row] }
    }
    if (sql.startsWith('SELECT upload_id, part_number')) {
      if (
        this.failReconciliationReads &&
        sql.includes('offset_bytes, length_bytes, sha256, state')
      ) {
        throw new Error('synthetic reconciliation read failure')
      }
      const [uploadId, partNumber] = values
      const rows = this.parts.filter(
        part =>
          part.upload_id === String(uploadId) &&
          (partNumber === undefined || Number(part.part_number) === Number(partNumber)) &&
          (!sql.includes("state = 'committed'") || part.state === 'committed')
      )
      return { rows }
    }
    if (sql.startsWith('SELECT state, lease_epoch FROM gfs_upload_parts')) {
      const [uploadId, partNumber] = values
      return {
        rows: this.parts.filter(
          part =>
            part.upload_id === String(uploadId) && Number(part.part_number) === Number(partNumber)
        ),
      }
    }
    if (sql.startsWith('INSERT INTO gfs_upload_parts')) {
      const [uploadId, partNumber, offset, length, sha, staging, epoch] = values
      const row: Row = {
        upload_id: String(uploadId),
        part_number: partNumber,
        offset_bytes: offset,
        length_bytes: length,
        sha256: sha,
        state: 'reserved',
        staging_path: staging,
        lease_epoch: epoch,
        committed_at: null,
      }
      this.parts.push(row)
      return { rows: [] }
    }
    if (sql.startsWith('UPDATE gfs_upload_parts SET offset_bytes')) {
      const [uploadId, partNumber, offset, length, sha, staging, epoch] = values
      const row = this.parts.find(
        part =>
          part.upload_id === String(uploadId) && Number(part.part_number) === Number(partNumber)
      )!
      Object.assign(row, {
        offset_bytes: offset,
        length_bytes: length,
        sha256: sha,
        state: 'reserved',
        staging_path: staging,
        lease_epoch: epoch,
        committed_at: null,
      })
      return { rows: [] }
    }
    if (sql.startsWith("UPDATE gfs_upload_sessions SET state = 'uploading'")) {
      const row = this.sessions.find(session => session.upload_id === String(values[0]))!
      row.state = 'uploading'
      if (sql.includes('session_epoch = session_epoch + 1')) {
        row.session_epoch = Number(row.session_epoch) + 1
        row.finalizing_started_at = null
        return { rows: [] }
      }
      row.active_part_count = sql.includes('active_part_count = (')
        ? this.parts.filter(part => part.upload_id === row.upload_id && part.state === 'reserved').length
        : Number(row.active_part_count) + 1
      return { rows: [] }
    }
    if (sql.startsWith("UPDATE gfs_upload_parts SET state = 'committed'")) {
      const [uploadId, partNumber, path] = values
      const row = this.parts.find(
        part =>
          part.upload_id === String(uploadId) && Number(part.part_number) === Number(partNumber)
      )!
      Object.assign(row, { state: 'committed', staging_path: path })
      return { rows: [] }
    }
    if (sql.startsWith('UPDATE gfs_upload_sessions SET committed_bytes')) {
      const [uploadId, length] = values
      const row = this.sessions.find(session => session.upload_id === String(uploadId))!
      row.committed_bytes = Number(row.committed_bytes) + Number(length)
      row.committed_part_count = Number(row.committed_part_count) + 1
      row.active_part_count = this.parts.filter(
        part => part.upload_id === row.upload_id && part.state === 'reserved'
      ).length
      let contiguous = 0
      for (let number = 0; number < Number(row.part_count); number += 1) {
        const part = this.parts.find(
          candidate =>
            candidate.upload_id === row.upload_id &&
            Number(candidate.part_number) === number &&
            candidate.state === 'committed'
        )
        if (!part) break
        contiguous += Number(part.length_bytes)
      }
      row.contiguous_bytes = contiguous
      return { rows: [] }
    }
    if (sql.startsWith("UPDATE gfs_upload_parts SET state = 'failed'")) {
      const uploadId = String(values[0])
      const row = this.parts.find(
        part =>
          part.upload_id === uploadId &&
          part.state === 'reserved' &&
          Number(part.part_number) === Number(values[1])
      )
      if (!row) return { rows: [] }
      row.state = 'failed'
      return { rows: [{ updated: 1 }] }
    }
    if (sql.startsWith('UPDATE gfs_upload_sessions SET active_part_count')) {
      const row = this.sessions.find(session => session.upload_id === String(values[0]))!
      row.active_part_count = this.parts.filter(
        part => part.upload_id === row.upload_id && part.state === 'reserved'
      ).length
      return { rows: [] }
    }
    if (sql.startsWith("UPDATE gfs_upload_sessions SET state = 'paused'")) {
      const row = this.sessions.find(session => session.upload_id === String(values[0]))!
      row.state = 'paused'
      return { rows: [] }
    }
    if (sql.startsWith("UPDATE gfs_upload_sessions SET state = 'uploading'")) {
      const row = this.sessions.find(session => session.upload_id === String(values[0]))!
      row.state = 'uploading'
      return { rows: [] }
    }
    if (sql.startsWith("UPDATE gfs_upload_sessions SET state = 'aborted'")) {
      const row = this.sessions.find(session => session.upload_id === String(values[0]))!
      row.state = 'aborted'
      row.session_epoch = Number(row.session_epoch) + 1
      return { rows: [] }
    }
    if (sql.startsWith("UPDATE gfs_upload_sessions SET state = 'finalizing'")) {
      const row = this.sessions.find(session => session.upload_id === String(values[0]))!
      row.state = 'finalizing'
      row.finalizing_started_at = new Date().toISOString()
      const extensionMs = Number(values[2] ?? 0)
      const currentExpiry = Date.parse(String(row.expires_at))
      const finalizerExpiry = Date.now() + extensionMs
      row.expires_at = new Date(Math.max(currentExpiry, finalizerExpiry)).toISOString()
      return { rows: [] }
    }
    if (sql.startsWith("UPDATE gfs_upload_sessions SET state = 'completed'")) {
      const [uploadId, resourceId, version, sha256] = values
      const row = this.sessions.find(session => session.upload_id === String(uploadId))!
      row.state = 'completed'
      row.result_resource_id = resourceId
      row.result_version = version
      row.result_sha256 = sha256
      row.completed_at = new Date().toISOString()
      row.finalizing_started_at = null
      return { rows: [] }
    }
    if (sql.startsWith("UPDATE gfs_upload_sessions SET state = 'failed'")) {
      const row = this.sessions.find(session => session.upload_id === String(values[0]))!
      row.state = 'failed'
      row.failure_code = values[1]
      row.active_part_count = 0
      row.finalizing_started_at = null
      return { rows: [] }
    }
    if (sql.startsWith('UPDATE gfs_upload_sessions SET cleanup_at')) {
      const row = this.sessions.find(session => session.upload_id === String(values[0]))
      if (row) row.cleanup_at = new Date().toISOString()
      return { rows: [] }
    }
    if (sql.startsWith('DELETE FROM gfs_upload_parts')) {
      const uploadId = String(values[0])
      this.parts = this.parts.filter(part => part.upload_id !== uploadId)
      return { rows: [] }
    }
    throw new Error(`unhandled fake SQL: ${sql}`)
  }
}

const CONFIG: GfsUploadConfig = {
  productMaxFileBytes: 209715200,
  protocolMaxFileBytes: 1073741824,
  preferredPartBytes: 8388608,
  maxPartBytes: 16777216,
  maxPartCount: 1024,
  maxConcurrentPartsPerSession: 4,
  maxConcurrentPartStreamsGlobal: 16,
  maxActivePerSubject: 2,
  maxActiveGlobal: 8,
  maxConcurrentFinalizations: 1,
  minFreeBytes: 10 * 1024 * 1024 * 1024,
  instabilityFailureThreshold: 3,
  fallbackConcurrency: 2,
  sessionTtlSeconds: 86400,
  partTimeoutMs: 300000,
  finalizeTimeoutMs: 600000,
  stalePartLeaseMs: 600000,
  receiptRetentionSeconds: 86400,
  enabled: true,
}

const TEST_CONFIG: GfsUploadConfig = {
  ...CONFIG,
  preferredPartBytes: 1048576,
  maxPartBytes: 1048576,
}

const principal = { drive: 'main', ownerSubject: 'user-1', primarySubject: 'user-1' }
const key = '11111111-1111-4111-8111-111111111111'

let tempRoot: string
afterEach(async () => {
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
})

function service(
  db: MemoryDb,
  config: GfsUploadConfig = TEST_CONFIG,
  overrides: Partial<Pick<UploadSessionServiceDeps, 'now' | 'finalize' | 'tx'>> = {}
): GfsUploadSessionService {
  return new GfsUploadSessionService({
    db,
    tx: overrides.tx ?? { transaction: async fn => fn(db) },
    blobs: { availableBytes: async () => 10n ** 12n } as never,
    storageMountPath: tempRoot,
    config,
    ...overrides,
  })
}

class ThrowAfterCommitTransactor implements Transactor {
  private transactionCount = 0

  constructor(
    private readonly delegate: Transactor,
    private readonly afterCommit: () => void
  ) {}

  async transaction<T>(
    fn: (client: TxClient) => Promise<T>,
    options?: TransactionOptions
  ): Promise<T> {
    this.transactionCount += 1
    const result = await this.delegate.transaction(fn, options)
    // create/reservation is the first transaction; the second is the part
    // commit. The callback makes the subsequent reconciliation read fail.
    if (this.transactionCount === 2) {
      this.afterCommit()
      throw new CommitOutcomeUnknownError(new Error('synthetic post-commit response loss'))
    }
    return result
  }
}

class ThrowBeforePartCommitTransactor implements Transactor {
  private transactionCount = 0

  constructor(private readonly delegate: Transactor) {}

  async transaction<T>(
    fn: (client: TxClient) => Promise<T>,
    options?: TransactionOptions
  ): Promise<T> {
    this.transactionCount += 1
    if (this.transactionCount === 2)
      throw new CommitOutcomeUnknownError(new Error('synthetic pre-commit failure'))
    return this.delegate.transaction(fn, options)
  }
}

async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs = 500
): Promise<
  { kind: 'completed'; value: T } | { kind: 'rejected'; error: unknown } | { kind: 'timeout' }
> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise.then(
        value => ({ kind: 'completed' as const, value }),
        error => ({ kind: 'rejected' as const, error })
      ),
      new Promise<{ kind: 'timeout' }>(resolve => {
        timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

describe('GfsUploadSessionService', () => {
  it('accepts exactly 200 MiB, rejects one byte over before allocation, and enforces part-count geometry', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'gfsc-upload-boundary-'))
    const input = {
      ...principal,
      operation: 'create' as const,
      parentRid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      name: 'boundary.bin',
    }

    const exactDb = new MemoryDb()
    const exact = await service(exactDb, CONFIG).create({
      ...input,
      sizeBytes: GFS_UPLOAD_V2_PRODUCT_MAX_BYTES,
      idempotencyKey: '11111111-1111-4111-8111-111111111112',
    })
    expect(exact.created).toBe(true)
    expect(exact.session.expectedBytes).toBe(GFS_UPLOAD_V2_PRODUCT_MAX_BYTES)
    expect(exact.session.partBytes).toBe(8 * 1024 * 1024)
    expect(exact.session.partCount).toBe(25)
    expect(exactDb.sessions).toHaveLength(1)

    const overDb = new MemoryDb()
    await expect(
      service(overDb, CONFIG).create({
        ...input,
        sizeBytes: GFS_UPLOAD_V2_PRODUCT_MAX_BYTES + 1,
        idempotencyKey: '11111111-1111-4111-8111-111111111113',
      })
    ).rejects.toMatchObject({ code: 'payload_too_large' })
    expect(overDb.sessions).toHaveLength(0)

    const partCountDb = new MemoryDb()
    await expect(
      service(partCountDb, { ...CONFIG, maxPartCount: 24 }).create({
        ...input,
        sizeBytes: GFS_UPLOAD_V2_PRODUCT_MAX_BYTES,
        idempotencyKey: '11111111-1111-4111-8111-111111111114',
      })
    ).rejects.toMatchObject({ code: 'payload_too_large' })
    expect(partCountDb.sessions).toHaveLength(0)
  })

  it(
    'creates idempotent sessions and keeps indexed commits separate from contiguous progress',
    { timeout: 15_000 },
    async () => {
      tempRoot = await mkdtemp(join(tmpdir(), 'gfsc-upload-'))
      const db = new MemoryDb()
      const uploads = service(db)
      const created = await uploads.create({
        ...principal,
        operation: 'create',
        parentRid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        name: 'data.bin',
        sizeBytes: 2097152,
        idempotencyKey: key,
      })
      expect(created.created).toBe(true)
      const replay = await uploads.create({
        ...principal,
        operation: 'create',
        parentRid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        name: 'data.bin',
        sizeBytes: 2097152,
        idempotencyKey: key,
      })
      expect(replay.created).toBe(false)
      expect(replay.session.uploadId).toBe(created.session.uploadId)

      const first = Buffer.alloc(1048576, 0x11)
      const second = Buffer.alloc(1048576, 0x22)
      const firstGeometry = partGeometry({ expectedBytes: 2097152, partBytes: 1048576 }, 0)
      const secondGeometry = partGeometry({ expectedBytes: 2097152, partBytes: 1048576 }, 1)
      const checksum = (value: Buffer) => createSha(value)
      const outOfOrder = await uploads.putPart(
        created.session.uploadId,
        secondGeometry,
        checksum(second),
        Readable.from([second]) as never,
        principal
      )
      expect(outOfOrder.session.contiguousBytes).toBe(0)
      const ordered = await uploads.putPart(
        created.session.uploadId,
        firstGeometry,
        checksum(first),
        Readable.from([first]) as never,
        principal
      )
      expect(ordered.session.contiguousBytes).toBe(2097152)
      expect(ordered.session.committedPartCount).toBe(2)
      expect(await readFile(ordered.part.stagingPath)).toEqual(first)
      const duplicate = await uploads.putPart(
        created.session.uploadId,
        firstGeometry,
        checksum(first),
        Readable.from([first]) as never,
        principal
      )
      expect(duplicate.part.sha256).toBe(checksum(first))
    }
  )

  it('does not double-decrement active parts after an unknown commit and failed reconciliation', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'gfsc-upload-'))
    const db = new MemoryDb()
    const created = await service(db).create({
      ...principal,
      operation: 'create',
      parentRid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      name: 'counter-safe.bin',
      sizeBytes: 2 * TEST_CONFIG.preferredPartBytes,
      idempotencyKey: '66666666-6666-4666-8666-666666666666',
    })
    const session = db.sessions[0]!
    session.active_part_count = 1
    db.parts.push({
      upload_id: created.session.uploadId,
      part_number: 1,
      offset_bytes: TEST_CONFIG.preferredPartBytes,
      length_bytes: TEST_CONFIG.preferredPartBytes,
      sha256: 'f'.repeat(64),
      state: 'reserved',
      staging_path: join(tempRoot, 'other.part'),
      lease_epoch: 0,
      committed_at: null,
    })

    const tx = new ThrowAfterCommitTransactor({ transaction: async fn => fn(db) }, () => {
      db.failReconciliationReads = true
    })
    const uploads = service(db, TEST_CONFIG, { tx })
    const first = Buffer.alloc(TEST_CONFIG.preferredPartBytes, 0x31)
    await expect(
      uploads.putPart(
        created.session.uploadId,
        partGeometry(
          {
            expectedBytes: 2 * TEST_CONFIG.preferredPartBytes,
            partBytes: TEST_CONFIG.preferredPartBytes,
          },
          0
        ),
        createSha(first),
        Readable.from([first]) as never,
        principal
      )
    ).rejects.toBeInstanceOf(CommitOutcomeUnknownError)

    expect(session.active_part_count).toBe(1)
    expect(db.parts.find(part => Number(part.part_number) === 0)?.state).toBe('committed')
    expect(db.parts.find(part => Number(part.part_number) === 1)?.state).toBe('reserved')
  })

  it('admits a new part from durable reserved rows when the session counter is stale', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'gfsc-upload-counter-drift-'))
    const db = new MemoryDb()
    const config = { ...TEST_CONFIG, maxConcurrentPartsPerSession: 1 }
    const uploads = service(db, config)
    const created = await uploads.create({
      ...principal,
      operation: 'create',
      parentRid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      name: 'counter-drift.bin',
      sizeBytes: TEST_CONFIG.preferredPartBytes,
      idempotencyKey: '68686868-6868-4686-8686-686868686868',
    })

    // A stale scalar must not deny admission when no durable reserved row
    // exists. This is the inverse of the double-decrement regression: rows,
    // not a receipt field, own the concurrency contract.
    db.sessions[0]!.active_part_count = 99
    const payload = Buffer.alloc(TEST_CONFIG.preferredPartBytes, 0x52)
    const committed = await uploads.putPart(
      created.session.uploadId,
      partGeometry(
        { expectedBytes: TEST_CONFIG.preferredPartBytes, partBytes: TEST_CONFIG.preferredPartBytes },
        0
      ),
      createSha(payload),
      Readable.from([payload]) as never,
      principal
    )

    expect(committed.part.state).toBe('committed')
    expect(committed.session.activePartCount).toBe(0)
    expect(db.sessions[0]).toMatchObject({ active_part_count: 0 })
  })

  it('extends the durable expiry window before entering finalization', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'gfsc-upload-finalizing-ttl-'))
    const db = new MemoryDb()
    const config = { ...TEST_CONFIG, sessionTtlSeconds: 1, finalizeTimeoutMs: 600_000 }
    let finalizerExpiry: number | undefined
    const uploads = service(db, config, {
      finalize: async session => {
        finalizerExpiry = Date.parse(session.expiresAt)
        return { resourceId: 'resource-finalizing-ttl', version: 1, sha256: 'a'.repeat(64) }
      },
    })
    const created = await uploads.create({
      ...principal,
      operation: 'create',
      parentRid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      name: 'finalizing-ttl.bin',
      sizeBytes: 0,
      idempotencyKey: '69696969-6969-4696-8696-696969696969',
    })
    const originalExpiry = Date.parse(created.session.expiresAt)

    await expect(uploads.complete(created.session.uploadId, principal)).resolves.toMatchObject({
      state: 'completed',
    })
    expect(finalizerExpiry).toBeGreaterThan(originalExpiry)
    expect(Date.parse(db.sessions[0]!.expires_at as string)).toBeGreaterThan(originalExpiry)
  })

  it('removes a rename-before-commit orphan while the reserved lease is still locked', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'gfsc-upload-orphan-'))
    const db = new MemoryDb()
    const tx = new ThrowBeforePartCommitTransactor({ transaction: async fn => fn(db) })
    const created = await service(db).create({
      ...principal,
      operation: 'create',
      parentRid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      name: 'orphan.bin',
      sizeBytes: TEST_CONFIG.preferredPartBytes,
      idempotencyKey: '67676767-6767-4676-8676-676767676767',
    })
    const uploads = service(db, TEST_CONFIG, { tx })
    const payload = Buffer.alloc(TEST_CONFIG.preferredPartBytes, 0x41)
    const finalPath = join(tempRoot, '.uploads', created.session.uploadId, 'parts', '0.part')

    await expect(
      uploads.putPart(
        created.session.uploadId,
        partGeometry(
          {
            expectedBytes: TEST_CONFIG.preferredPartBytes,
            partBytes: TEST_CONFIG.preferredPartBytes,
          },
          0
        ),
        createSha(payload),
        Readable.from([payload]) as never,
        principal
      )
    ).rejects.toBeInstanceOf(CommitOutcomeUnknownError)

    await expect(stat(finalPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(db.parts[0]).toMatchObject({ state: 'failed' })
    expect(db.sessions[0]).toMatchObject({ active_part_count: 0 })
  })

  it('cancels terminally and rejects a conflicting idempotency fingerprint', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'gfsc-upload-'))
    const db = new MemoryDb()
    const uploads = service(db)
    await uploads.create({
      ...principal,
      operation: 'create',
      parentRid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      name: 'data.bin',
      sizeBytes: 0,
      idempotencyKey: key,
    })
    await expect(
      uploads.create({
        ...principal,
        operation: 'create',
        parentRid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        name: 'other.bin',
        sizeBytes: 0,
        idempotencyKey: key,
      })
    ).rejects.toMatchObject({ code: 'idempotency_conflict' })
    const session = await uploads.create({
      ...principal,
      operation: 'create',
      parentRid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      name: 'cancel.bin',
      sizeBytes: 0,
      idempotencyKey: '22222222-2222-4222-8222-222222222222',
    })
    await uploads.cancel(session.session.uploadId, principal)
    await expect(uploads.get(session.session.uploadId, principal)).rejects.toMatchObject({
      code: 'upload_aborted',
    })
  })

  it('releases a rejected finalizer before quiescence and cleans the failed upload immediately', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'gfsc-upload-'))
    const db = new MemoryDb()
    let now = 0
    const uploads = service(db, TEST_CONFIG, {
      // Advance beyond the drain deadline on its first condition check. This
      // makes the regression deterministic without waiting for the production
      // five-minute part timeout: the old code still skipped cleanup because
      // the failed finalizer remained registered while it drained itself.
      now: () => (now += TEST_CONFIG.partTimeoutMs + 1),
      finalize: async () => {
        throw new Error('synthetic finalizer rejection')
      },
    })
    const created = await uploads.create({
      ...principal,
      operation: 'create',
      parentRid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      name: 'finalizer-rejection.bin',
      sizeBytes: 0,
      idempotencyKey: '33333333-3333-4333-8333-333333333333',
    })
    const uploadDirectory = join(tempRoot, '.uploads', created.session.uploadId)
    await mkdir(uploadDirectory, { recursive: true })
    await writeFile(join(uploadDirectory, 'finalizer-marker'), 'pending')

    const outcome = await settleWithin(uploads.complete(created.session.uploadId, principal))

    expect(outcome.kind).toBe('rejected')
    if (outcome.kind !== 'rejected')
      throw new Error(`unexpected completion outcome: ${outcome.kind}`)
    expect(outcome.error).toMatchObject({ message: 'synthetic finalizer rejection' })
    expect(db.sessions[0]).toMatchObject({
      state: 'failed',
      failure_code: 'finalization_failed',
      cleanup_at: expect.any(String),
    })
    expect(
      (uploads as unknown as { inFlightFinalizers: Map<string, unknown> }).inFlightFinalizers.size
    ).toBe(0)
    expect(db.parts).toHaveLength(0)
    await expect(stat(uploadDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('releases a timed-out finalizer and preserves the timeout failure code during cleanup', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'gfsc-upload-'))
    const db = new MemoryDb()
    let now = 0
    const config = { ...TEST_CONFIG, finalizeTimeoutMs: 5 }
    const uploads = service(db, config, {
      now: () => (now += config.partTimeoutMs + 1),
      finalize: async (_session, _parts, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        }),
    })
    const created = await uploads.create({
      ...principal,
      operation: 'create',
      parentRid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      name: 'finalizer-timeout.bin',
      sizeBytes: 0,
      idempotencyKey: '44444444-4444-4444-8444-444444444444',
    })
    const uploadDirectory = join(tempRoot, '.uploads', created.session.uploadId)
    await mkdir(uploadDirectory, { recursive: true })
    await writeFile(join(uploadDirectory, 'finalizer-marker'), 'pending')

    const outcome = await settleWithin(uploads.complete(created.session.uploadId, principal))

    expect(outcome.kind).toBe('rejected')
    if (outcome.kind !== 'rejected')
      throw new Error(`unexpected completion outcome: ${outcome.kind}`)
    expect(outcome.error).toMatchObject({ code: 'precondition_failed' })
    expect(db.sessions[0]).toMatchObject({
      state: 'failed',
      failure_code: 'precondition_failed',
      cleanup_at: expect.any(String),
    })
    expect(
      (uploads as unknown as { inFlightFinalizers: Map<string, unknown> }).inFlightFinalizers.size
    ).toBe(0)
    expect(db.parts).toHaveLength(0)
    await expect(stat(uploadDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('leaves a failed finalizer cleanup eligible for the reconciler after the registry is released', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'gfsc-upload-'))
    const db = new MemoryDb()
    let now = 0
    const uploads = service(db, TEST_CONFIG, {
      now: () => (now += TEST_CONFIG.partTimeoutMs + 1),
      finalize: async () => {
        throw new Error('synthetic cleanup retry')
      },
    })
    const created = await uploads.create({
      ...principal,
      operation: 'create',
      parentRid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      name: 'finalizer-cleanup-retry.bin',
      sizeBytes: 0,
      idempotencyKey: '55555555-5555-4555-8555-555555555555',
    })
    const uploadDirectory = join(tempRoot, '.uploads', created.session.uploadId)
    await mkdir(join(tempRoot, '.uploads'), { recursive: true })
    // A non-directory at the private session path makes the strict direct
    // cleanup fail closed. The terminal row must remain retryable.
    await writeFile(uploadDirectory, 'not-a-directory')

    const outcome = await settleWithin(uploads.complete(created.session.uploadId, principal))
    expect(outcome.kind).toBe('rejected')
    expect(db.sessions[0]).toMatchObject({ state: 'failed', cleanup_at: null })
    expect(
      (uploads as unknown as { inFlightFinalizers: Map<string, unknown> }).inFlightFinalizers.size
    ).toBe(0)

    // The first reconciliation attempt must exercise the terminal-session
    // cancellation fence, then release it even though filesystem cleanup is
    // still blocked by the non-directory path. This catches a vacuous
    // assertion before reconcile() and proves the fence is bounded across
    // repeated cleanup cycles.
    await expect(uploads.reconcile()).resolves.toEqual({ staleParts: 0, expiredSessions: 0 })
    expect(
      (uploads as unknown as { canceledUploads: Set<string> }).canceledUploads.has(
        created.session.uploadId
      )
    ).toBe(false)

    await rm(uploadDirectory, { force: true })
    await mkdir(uploadDirectory, { recursive: true })
    await writeFile(join(uploadDirectory, 'finalizer-marker'), 'pending')
    await expect(uploads.reconcile()).resolves.toEqual({ staleParts: 0, expiredSessions: 0 })
    expect(db.sessions[0]).toMatchObject({ state: 'failed', cleanup_at: expect.any(String) })
    await expect(stat(uploadDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

function createSha(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}
