import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { Pool } from 'pg'
import type { GfsUploadConfig } from '../../gfs-controller/src/config.js'
import { CommitOutcomeUnknownError, PgTransactor } from '../../gfs-controller/src/db/writeStore.js'
import type {
  TransactionOptions,
  Transactor,
  TxClient,
} from '../../gfs-controller/src/db/writeStore.js'
import { partGeometry } from '../../gfs-controller/src/upload/protocol.js'
import {
  GfsUploadSessionService,
  type UploadSessionServiceDeps,
} from '../../gfs-controller/src/upload/uploadSession.js'
import { initDb } from '../src/db.js'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function checksum(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

class HoldBeforeCommitTransactor implements Transactor {
  private transactionCount = 0
  private readyResolve!: () => void
  private releaseResolve!: () => void
  readonly ready = new Promise<void>(resolve => {
    this.readyResolve = resolve
  })
  private readonly releaseGate = new Promise<void>(resolve => {
    this.releaseResolve = resolve
  })

  constructor(private readonly delegate: Transactor) {}

  release(): void {
    this.releaseResolve()
  }

  async transaction<T>(
    fn: (client: TxClient) => Promise<T>,
    options?: TransactionOptions
  ): Promise<T> {
    this.transactionCount += 1
    // create/reservation use the first transaction. The second is the part
    // commit transaction, and is held before it can acquire the session row.
    if (this.transactionCount === 2) {
      this.readyResolve()
      await this.releaseGate
    }
    return this.delegate.transaction(fn, options)
  }
}

/**
 * Simulates a network/process failure after PostgreSQL has committed. The
 * upload service must reconcile the durable row instead of replaying a
 * state-changing operation blindly.
 */
class ThrowAfterCommitTransactor implements Transactor {
  private transactionCount = 0

  constructor(
    private readonly delegate: Transactor,
    private readonly failOnTransaction: number
  ) {}

  async transaction<T>(
    fn: (client: TxClient) => Promise<T>,
    options?: TransactionOptions
  ): Promise<T> {
    this.transactionCount += 1
    const result = await this.delegate.transaction(fn, options)
    if (this.transactionCount === this.failOnTransaction) {
      throw new CommitOutcomeUnknownError(new Error('synthetic post-commit response loss'))
    }
    return result
  }
}

const CONFIG: GfsUploadConfig = {
  productMaxFileBytes: 209715200,
  protocolMaxFileBytes: 1073741824,
  preferredPartBytes: 1048576,
  maxPartBytes: 1048576,
  maxPartCount: 1024,
  maxConcurrentPartsPerSession: 4,
  maxConcurrentPartStreamsGlobal: 16,
  maxActivePerSubject: 8,
  maxActiveGlobal: 32,
  maxConcurrentFinalizations: 1,
  minFreeBytes: 0,
  instabilityFailureThreshold: 3,
  fallbackConcurrency: 2,
  sessionTtlSeconds: 86400,
  partTimeoutMs: 300000,
  finalizeTimeoutMs: 600000,
  stalePartLeaseMs: 600000,
  receiptRetentionSeconds: 86400,
  enabled: true,
}

describeRealPostgres('GFS Upload v2 session engine on real PostgreSQL', () => {
  const database = `gfs_upload_session_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  const drive = `upload-t1-${randomBytes(4).toString('hex')}`
  const owner = `user-${randomBytes(4).toString('hex')}`
  let adminPool: Pool
  let pool: Pool
  let tempRoot: string
  let uploads: GfsUploadSessionService

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
    pool = new Pool({ connectionString })
    await initDb({ connect: () => pool.connect() })
    tempRoot = await mkdtemp(join(tmpdir(), 'gfs-upload-t1-'))
    const deps: UploadSessionServiceDeps = {
      db: pool,
      tx: new PgTransactor(pool),
      blobs: { availableBytes: async () => 10n ** 12n } as never,
      storageMountPath: tempRoot,
      config: CONFIG,
    }
    uploads = new GfsUploadSessionService(deps)
  }, 60_000)

  afterAll(async () => {
    await pool
      ?.query('DELETE FROM gfs_upload_sessions WHERE drive = $1', [drive])
      .catch(() => undefined)
    await pool?.end()
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined)
    if (!adminPool) return
    await adminPool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [database]
    )
    await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)}`)
    await adminPool.end()
  })

  it('serializes concurrent idempotent creates to one session and rejects a changed fingerprint', async () => {
    const idempotencyKey = randomUUID()
    const base = {
      drive,
      ownerSubject: owner,
      primarySubject: owner,
      operation: 'create' as const,
      parentRid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      name: 'concurrent.bin',
      sizeBytes: 2 * CONFIG.preferredPartBytes,
      idempotencyKey,
    }
    const results = await Promise.all([uploads.create({ ...base }), uploads.create({ ...base })])
    expect(results.filter(result => result.created)).toHaveLength(1)
    expect(new Set(results.map(result => result.session.uploadId)).size).toBe(1)
    await expect(uploads.create({ ...base, name: 'different.bin' })).rejects.toMatchObject({
      code: 'idempotency_conflict',
    })
    const count = await pool.query(
      `SELECT count(*)::int AS count FROM gfs_upload_sessions WHERE drive = $1 AND idempotency_key = $2`,
      [drive, idempotencyKey]
    )
    expect(count.rows[0]?.count).toBe(1)
  })

  it('commits indexed parts out of order, paginates status, and deduplicates replay bytes', async () => {
    const created = await uploads.create({
      drive,
      ownerSubject: owner,
      primarySubject: owner,
      operation: 'create',
      parentRid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      name: 'out-of-order.bin',
      sizeBytes: 2 * CONFIG.preferredPartBytes,
      idempotencyKey: randomUUID(),
    })
    const part0 = Buffer.alloc(CONFIG.preferredPartBytes, 0x10)
    const part1 = Buffer.alloc(CONFIG.preferredPartBytes, 0x20)
    const g0 = partGeometry(
      { expectedBytes: 2 * CONFIG.preferredPartBytes, partBytes: CONFIG.preferredPartBytes },
      0
    )
    const g1 = partGeometry(
      { expectedBytes: 2 * CONFIG.preferredPartBytes, partBytes: CONFIG.preferredPartBytes },
      1
    )
    const first = await uploads.putPart(
      created.session.uploadId,
      g1,
      checksum(part1),
      Readable.from([part1]) as never,
      { drive, ownerSubject: owner, primarySubject: owner }
    )
    expect(first.session.contiguousBytes).toBe(0)
    const page = await uploads.status(
      created.session.uploadId,
      { drive, ownerSubject: owner, primarySubject: owner },
      { limit: 1 }
    )
    expect(page.parts).toHaveLength(1)
    expect(page.parts[0]?.partNumber).toBe(1)
    expect(page.nextCursor).toBeNull()
    const second = await uploads.putPart(
      created.session.uploadId,
      g0,
      checksum(part0),
      Readable.from([part0]) as never,
      { drive, ownerSubject: owner, primarySubject: owner }
    )
    expect(second.session.contiguousBytes).toBe(2 * CONFIG.preferredPartBytes)
    expect(second.session.committedPartCount).toBe(2)

    const replay = await uploads.putPart(
      created.session.uploadId,
      g1,
      checksum(part1),
      Readable.from([part1]) as never,
      { drive, ownerSubject: owner, primarySubject: owner }
    )
    expect(replay.part.partNumber).toBe(1)
    const rows = await pool.query(
      `SELECT state, count(*)::int AS count FROM gfs_upload_parts WHERE upload_id = $1 GROUP BY state`,
      [created.session.uploadId]
    )
    expect(rows.rows).toEqual(expect.arrayContaining([{ state: 'committed', count: 2 }]))
  })

  it('reports the exact reserved part set while sibling streams are active', async () => {
    const created = await uploads.create({
      drive,
      ownerSubject: owner,
      primarySubject: owner,
      operation: 'create',
      parentRid: 'c'.repeat(32),
      name: 'active-part-set.bin',
      sizeBytes: 2 * CONFIG.preferredPartBytes,
      idempotencyKey: randomUUID(),
    })
    await pool.query(
      `UPDATE gfs_upload_sessions SET state = 'uploading', active_part_count = 99 WHERE upload_id = $1`,
      [created.session.uploadId]
    )
    await pool.query(
      `INSERT INTO gfs_upload_parts
        (upload_id, part_number, offset_bytes, length_bytes, sha256, state, staging_path, lease_epoch, lease_started_at)
       VALUES
        ($1, 0, 0, $2, $3, 'reserved', $4, 1, now()),
        ($1, 1, $2, $2, $3, 'reserved', $5, 1, now())`,
      [
        created.session.uploadId,
        CONFIG.preferredPartBytes,
        'a'.repeat(64),
        join(tempRoot, '.uploads', created.session.uploadId, 'parts', '0.part.tmp-test'),
        join(tempRoot, '.uploads', created.session.uploadId, 'parts', '1.part.tmp-test'),
      ]
    )
    const status = await uploads.status(created.session.uploadId, {
      drive,
      ownerSubject: owner,
      primarySubject: owner,
    })
    expect(status.session.activePartCount).toBe(2)
    expect(status.session.activePartNumbers).toEqual([0, 1])
  })

  it('admits a part from durable reserved rows when the scalar counter is stale', async () => {
    const created = await uploads.create({
      drive,
      ownerSubject: owner,
      primarySubject: owner,
      operation: 'create',
      parentRid: 'd'.repeat(32),
      name: 'counter-drift-admission.bin',
      sizeBytes: CONFIG.preferredPartBytes,
      idempotencyKey: randomUUID(),
    })
    const principal = { drive, ownerSubject: owner, primarySubject: owner }
    await pool.query(
      `UPDATE gfs_upload_sessions SET state = 'uploading', active_part_count = 99 WHERE upload_id = $1`,
      [created.session.uploadId]
    )
    const bytes = Buffer.alloc(CONFIG.preferredPartBytes, 0x44)
    const result = await uploads.putPart(
      created.session.uploadId,
      partGeometry({ expectedBytes: bytes.length, partBytes: CONFIG.preferredPartBytes }, 0),
      checksum(bytes),
      Readable.from([bytes]) as never,
      principal
    )
    expect(result.part.state).toBe('committed')
    expect(result.session.activePartCount).toBe(0)
    expect(
      (
        await pool.query(`SELECT active_part_count FROM gfs_upload_sessions WHERE upload_id = $1`, [
          created.session.uploadId,
        ])
      ).rows[0]?.active_part_count
    ).toBe(0)
  })

  it('serializes concurrent indexed part reservations without losing either commit', async () => {
    const bytes = [
      Buffer.alloc(CONFIG.preferredPartBytes, 0x31),
      Buffer.alloc(CONFIG.preferredPartBytes, 0x32),
    ]
    const created = await uploads.create({
      drive,
      ownerSubject: owner,
      primarySubject: owner,
      operation: 'create',
      parentRid: '7'.repeat(32),
      name: 'concurrent-parts.bin',
      sizeBytes: bytes.length * CONFIG.preferredPartBytes,
      idempotencyKey: randomUUID(),
    })
    const principal = { drive, ownerSubject: owner, primarySubject: owner }
    const results = await Promise.all(
      bytes.map((value, partNumber) =>
        uploads.putPart(
          created.session.uploadId,
          partGeometry(
            { expectedBytes: value.length * bytes.length, partBytes: CONFIG.preferredPartBytes },
            partNumber
          ),
          checksum(value),
          Readable.from([value]) as never,
          principal
        )
      )
    )
    expect(results.map(result => result.part.state)).toEqual(['committed', 'committed'])
    const count = await pool.query(
      `SELECT count(*)::int AS count FROM gfs_upload_parts WHERE upload_id = $1 AND state = 'committed'`,
      [created.session.uploadId]
    )
    expect(count.rows[0]?.count).toBe(2)
  })

  it('completes non-zero parts and replays complete idempotently', async () => {
    const bytes0 = Buffer.alloc(CONFIG.preferredPartBytes, 0x61)
    const bytes1 = Buffer.alloc(CONFIG.preferredPartBytes, 0x62)
    const uploadsWithFinalizer = new GfsUploadSessionService({
      db: pool,
      tx: new PgTransactor(pool),
      blobs: { availableBytes: async () => 10n ** 12n } as never,
      storageMountPath: tempRoot,
      config: CONFIG,
      finalize: async session => ({
        resourceId: session.uploadId,
        version: 1,
        sha256: checksum(Buffer.concat([bytes0, bytes1])),
      }),
    })
    const created = await uploadsWithFinalizer.create({
      drive,
      ownerSubject: owner,
      primarySubject: owner,
      operation: 'create',
      parentRid: 'f'.repeat(32),
      name: 'complete-non-zero.bin',
      sizeBytes: bytes0.length + bytes1.length,
      idempotencyKey: randomUUID(),
    })
    const principal = { drive, ownerSubject: owner, primarySubject: owner }
    for (const [partNumber, bytes] of [bytes0, bytes1].entries()) {
      await uploadsWithFinalizer.putPart(
        created.session.uploadId,
        partGeometry(
          { expectedBytes: bytes0.length + bytes1.length, partBytes: CONFIG.preferredPartBytes },
          partNumber
        ),
        checksum(bytes),
        Readable.from([bytes]) as never,
        principal
      )
    }

    const completed = await uploadsWithFinalizer.complete(created.session.uploadId, principal)
    expect(completed).toMatchObject({
      uploadId: created.session.uploadId,
      state: 'completed',
      committedBytes: bytes0.length + bytes1.length,
      resultVersion: 1,
    })
    await expect(
      uploadsWithFinalizer.complete(created.session.uploadId, principal)
    ).resolves.toEqual(completed)
  })

  it('reconciles an ambiguous committed part response without duplicating the part', async () => {
    const base = new GfsUploadSessionService({
      db: pool,
      tx: new PgTransactor(pool),
      blobs: { availableBytes: async () => 10n ** 12n } as never,
      storageMountPath: tempRoot,
      config: CONFIG,
    })
    const created = await base.create({
      drive,
      ownerSubject: owner,
      primarySubject: owner,
      operation: 'create',
      parentRid: '1'.repeat(32),
      name: 'ambiguous-part.bin',
      sizeBytes: CONFIG.preferredPartBytes,
      idempotencyKey: randomUUID(),
    })
    const uploadsWithUnknownCommit = new GfsUploadSessionService({
      db: pool,
      // The reservation transaction commits first; the second transaction is
      // the indexed-part commit whose response is intentionally lost.
      tx: new ThrowAfterCommitTransactor(new PgTransactor(pool), 2),
      blobs: { availableBytes: async () => 10n ** 12n } as never,
      storageMountPath: tempRoot,
      config: CONFIG,
    })
    const bytes = Buffer.alloc(CONFIG.preferredPartBytes, 0x73)
    const principal = { drive, ownerSubject: owner, primarySubject: owner }
    const result = await uploadsWithUnknownCommit.putPart(
      created.session.uploadId,
      partGeometry({ expectedBytes: bytes.length, partBytes: CONFIG.preferredPartBytes }, 0),
      checksum(bytes),
      Readable.from([bytes]) as never,
      principal
    )
    expect(result.part.state).toBe('committed')
    const count = await pool.query(
      `SELECT count(*)::int AS count FROM gfs_upload_parts WHERE upload_id = $1 AND state = 'committed'`,
      [created.session.uploadId]
    )
    expect(count.rows[0]?.count).toBe(1)
  })

  it('reconciles an ambiguous complete response from the committed session row', async () => {
    const bytes = Buffer.alloc(CONFIG.preferredPartBytes, 0x84)
    const base = new GfsUploadSessionService({
      db: pool,
      tx: new PgTransactor(pool),
      blobs: { availableBytes: async () => 10n ** 12n } as never,
      storageMountPath: tempRoot,
      config: CONFIG,
    })
    const created = await base.create({
      drive,
      ownerSubject: owner,
      primarySubject: owner,
      operation: 'create',
      parentRid: '2'.repeat(32),
      name: 'ambiguous-complete.bin',
      sizeBytes: bytes.length,
      idempotencyKey: randomUUID(),
    })
    const principal = { drive, ownerSubject: owner, primarySubject: owner }
    await base.putPart(
      created.session.uploadId,
      partGeometry({ expectedBytes: bytes.length, partBytes: CONFIG.preferredPartBytes }, 0),
      checksum(bytes),
      Readable.from([bytes]) as never,
      principal
    )
    const uploadsWithFinalizer = new GfsUploadSessionService({
      db: pool,
      tx: new ThrowAfterCommitTransactor(new PgTransactor(pool), 2),
      blobs: { availableBytes: async () => 10n ** 12n } as never,
      storageMountPath: tempRoot,
      config: CONFIG,
      finalize: async session => ({
        resourceId: session.uploadId,
        version: 2,
        sha256: checksum(bytes),
      }),
    })
    await expect(
      uploadsWithFinalizer.complete(created.session.uploadId, principal)
    ).resolves.toMatchObject({
      state: 'completed',
      resultVersion: 2,
    })
  })

  it('fences and cleans a stale reserved lease while its row lock is held', async () => {
    const created = await uploads.create({
      drive,
      ownerSubject: owner,
      primarySubject: owner,
      operation: 'create',
      parentRid: '3'.repeat(32),
      name: 'stale-reserved.bin',
      sizeBytes: CONFIG.preferredPartBytes,
      idempotencyKey: randomUUID(),
    })
    const partsDir = join(tempRoot, '.uploads', created.session.uploadId, 'parts')
    await mkdir(partsDir, { recursive: true })
    const staleSuffix = `part.tmp-${randomUUID()}`
    const stagingPath = join(partsDir, `0.${staleSuffix}`)
    const finalPath = join(partsDir, '0.part')
    await writeFile(stagingPath, Buffer.from('stale-temp'))
    await writeFile(finalPath, Buffer.from('stale-final'))
    await pool.query(
      `UPDATE gfs_upload_sessions SET state = 'uploading', active_part_count = 1 WHERE upload_id = $1`,
      [created.session.uploadId]
    )
    await pool.query(
      `INSERT INTO gfs_upload_parts
        (upload_id, part_number, offset_bytes, length_bytes, sha256, state, staging_path, lease_epoch, lease_started_at)
       VALUES ($1, 0, 0, $2, $3, 'reserved', $4, 1, now() - interval '1 hour')`,
      [
        created.session.uploadId,
        CONFIG.preferredPartBytes,
        checksum(Buffer.from('stale')),
        stagingPath,
      ]
    )

    const result = await uploads.reconcile()

    expect(result.staleParts).toBeGreaterThanOrEqual(1)
    expect(
      await pool.query('SELECT state FROM gfs_upload_parts WHERE upload_id = $1', [
        created.session.uploadId,
      ])
    ).toMatchObject({
      rows: [{ state: 'failed' }],
    })
    expect(
      (
        await pool.query('SELECT active_part_count FROM gfs_upload_sessions WHERE upload_id = $1', [
          created.session.uploadId,
        ])
      ).rows[0]?.active_part_count
    ).toBe(0)
    await expect(stat(stagingPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(finalPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not disclose a session to another owner and makes cancel terminal', async () => {
    const created = await uploads.create({
      drive,
      ownerSubject: owner,
      primarySubject: owner,
      operation: 'create',
      parentRid: 'cccccccccccccccccccccccccccccccc',
      name: 'cancel.bin',
      sizeBytes: CONFIG.preferredPartBytes,
      idempotencyKey: randomUUID(),
    })
    const foreign = { drive, ownerSubject: `${owner}-foreign`, primarySubject: `${owner}-foreign` }
    await expect(uploads.get(created.session.uploadId, foreign)).rejects.toMatchObject({
      code: 'not_found',
    })
    await uploads.cancel(created.session.uploadId, {
      drive,
      ownerSubject: owner,
      primarySubject: owner,
    })
    await expect(
      uploads.get(created.session.uploadId, { drive, ownerSubject: owner, primarySubject: owner })
    ).rejects.toMatchObject({ code: 'upload_aborted' })
    const row = await pool.query(
      `SELECT state, active_part_count FROM gfs_upload_sessions WHERE upload_id = $1`,
      [created.session.uploadId]
    )
    expect(row.rows[0]).toEqual({ state: 'aborted', active_part_count: 0 })
    const parts = await pool.query(
      `SELECT count(*)::int AS count FROM gfs_upload_parts WHERE upload_id = $1`,
      [created.session.uploadId]
    )
    expect(parts.rows[0]?.count).toBe(0)
  })

  it('fences a part commit that races with cancel before the commit transaction starts', async () => {
    const base = new GfsUploadSessionService({
      db: pool,
      tx: new PgTransactor(pool),
      blobs: { availableBytes: async () => 10n ** 12n } as never,
      storageMountPath: tempRoot,
      config: CONFIG,
    })
    const created = await base.create({
      drive,
      ownerSubject: owner,
      primarySubject: owner,
      operation: 'create',
      parentRid: 'dddddddddddddddddddddddddddddddd',
      name: 'cancel-race.bin',
      sizeBytes: CONFIG.preferredPartBytes,
      idempotencyKey: randomUUID(),
    })
    const gate = new HoldBeforeCommitTransactor(new PgTransactor(pool))
    const uploadsWithGate = new GfsUploadSessionService({
      db: pool,
      tx: gate,
      blobs: { availableBytes: async () => 10n ** 12n } as never,
      storageMountPath: tempRoot,
      config: CONFIG,
    })
    const bytes = Buffer.alloc(CONFIG.preferredPartBytes, 0x44)
    const put = uploadsWithGate.putPart(
      created.session.uploadId,
      partGeometry(
        { expectedBytes: CONFIG.preferredPartBytes, partBytes: CONFIG.preferredPartBytes },
        0
      ),
      checksum(bytes),
      Readable.from([bytes]) as never,
      { drive, ownerSubject: owner, primarySubject: owner }
    )
    await gate.ready

    const cancel = uploadsWithGate.cancel(created.session.uploadId, {
      drive,
      ownerSubject: owner,
      primarySubject: owner,
    })
    const deadline = Date.now() + 2000
    while (Date.now() < deadline) {
      const state = await pool.query(`SELECT state FROM gfs_upload_sessions WHERE upload_id = $1`, [
        created.session.uploadId,
      ])
      if (state.rows[0]?.state === 'aborted') break
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    const state = await pool.query(`SELECT state FROM gfs_upload_sessions WHERE upload_id = $1`, [
      created.session.uploadId,
    ])
    expect(state.rows[0]?.state).toBe('aborted')
    gate.release()
    await expect(put).rejects.toMatchObject({ code: 'upload_aborted' })
    await expect(cancel).resolves.toBeUndefined()
    const parts = await pool.query(
      `SELECT count(*)::int AS count FROM gfs_upload_parts WHERE upload_id = $1`,
      [created.session.uploadId]
    )
    expect(parts.rows[0]?.count).toBe(0)
  })

  it('reconciles expired sessions and detects a committed part whose file is missing', async () => {
    const expired = await uploads.create({
      drive,
      ownerSubject: owner,
      primarySubject: owner,
      operation: 'create',
      parentRid: '9'.repeat(32),
      name: 'expired-reconcile.bin',
      sizeBytes: CONFIG.preferredPartBytes,
      idempotencyKey: randomUUID(),
    })
    await pool.query(
      `UPDATE gfs_upload_sessions SET expires_at = now() - interval '1 second' WHERE upload_id = $1`,
      [expired.session.uploadId]
    )

    const expiredResult = await uploads.reconcile()
    expect(expiredResult.expiredSessions).toBeGreaterThanOrEqual(1)
    await expect(
      pool.query(`SELECT state FROM gfs_upload_sessions WHERE upload_id = $1`, [
        expired.session.uploadId,
      ])
    ).resolves.toMatchObject({ rows: [{ state: 'expired' }] })

    const bytes = Buffer.alloc(CONFIG.preferredPartBytes, 0x5a)
    const committed = await uploads.create({
      drive,
      ownerSubject: owner,
      primarySubject: owner,
      operation: 'create',
      parentRid: '8'.repeat(32),
      name: 'missing-reconcile.bin',
      sizeBytes: bytes.length,
      idempotencyKey: randomUUID(),
    })
    await uploads.putPart(
      committed.session.uploadId,
      partGeometry({ expectedBytes: bytes.length, partBytes: CONFIG.preferredPartBytes }, 0),
      checksum(bytes),
      Readable.from([bytes]) as never,
      { drive, ownerSubject: owner, primarySubject: owner }
    )
    const partRow = await pool.query<{ staging_path: string }>(
      `SELECT staging_path FROM gfs_upload_parts WHERE upload_id = $1 AND state = 'committed'`,
      [committed.session.uploadId]
    )
    await rm(String(partRow.rows[0]?.staging_path), { force: true })

    const corruptResult = await uploads.reconcile()
    expect(corruptResult).toMatchObject({ staleParts: 0 })
    const corruptRow = await pool.query<{ state: string; failure_code: string }>(
      `SELECT state, failure_code FROM gfs_upload_sessions WHERE upload_id = $1`,
      [committed.session.uploadId]
    )
    expect(corruptRow.rows[0]).toEqual({ state: 'failed', failure_code: 'corrupt_part_missing' })
  })

  it('reopens an orphaned finalizing session after the durable finalizer lease expires', async () => {
    const created = await uploads.create({
      drive,
      ownerSubject: owner,
      primarySubject: owner,
      operation: 'create',
      parentRid: 'a'.repeat(32),
      name: 'orphan-finalizer.bin',
      sizeBytes: 0,
      idempotencyKey: randomUUID(),
    })
    const before = await pool.query(
      `SELECT session_epoch FROM gfs_upload_sessions WHERE upload_id = $1`,
      [created.session.uploadId]
    )
    await pool.query(
      `UPDATE gfs_upload_sessions
          SET state = 'finalizing', finalizing_started_at = now() - interval '1 hour'
        WHERE upload_id = $1`,
      [created.session.uploadId]
    )
    await uploads.reconcile()
    const row = await pool.query(
      `SELECT state, session_epoch, finalizing_started_at FROM gfs_upload_sessions WHERE upload_id = $1`,
      [created.session.uploadId]
    )
    expect(row.rows[0]).toMatchObject({
      state: 'uploading',
      finalizing_started_at: null,
    })
    expect(Number(row.rows[0]?.session_epoch)).toBe(Number(before.rows[0]?.session_epoch) + 1)
  })

  it('rejects cancel during finalization and leaves one completed receipt', async () => {
    let finalizerStarted!: () => void
    let releaseFinalizer!: () => void
    const started = new Promise<void>(resolve => {
      finalizerStarted = resolve
    })
    const release = new Promise<void>(resolve => {
      releaseFinalizer = resolve
    })
    const uploadsWithFinalizer = new GfsUploadSessionService({
      db: pool,
      tx: new PgTransactor(pool),
      blobs: { availableBytes: async () => 10n ** 12n } as never,
      storageMountPath: tempRoot,
      config: CONFIG,
      finalize: async session => {
        finalizerStarted()
        await release
        return {
          resourceId: session.uploadId,
          version: 0,
          sha256: 'a'.repeat(64),
        }
      },
    })
    const created = await uploadsWithFinalizer.create({
      drive,
      ownerSubject: owner,
      primarySubject: owner,
      operation: 'create',
      parentRid: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      name: 'finalize-race.bin',
      sizeBytes: 0,
      idempotencyKey: randomUUID(),
    })
    const complete = uploadsWithFinalizer.complete(created.session.uploadId, {
      drive,
      ownerSubject: owner,
      primarySubject: owner,
    })
    await started
    await expect(
      uploadsWithFinalizer.cancel(created.session.uploadId, {
        drive,
        ownerSubject: owner,
        primarySubject: owner,
      })
    ).rejects.toMatchObject({ code: 'upload_finalizing' })
    releaseFinalizer()
    const receipt = await complete
    expect(receipt.state).toBe('completed')
    const row = await pool.query(
      `SELECT state, result_resource_id, result_version FROM gfs_upload_sessions WHERE upload_id = $1`,
      [created.session.uploadId]
    )
    expect(row.rows[0]).toMatchObject({
      state: 'completed',
      result_resource_id: created.session.uploadId,
      result_version: '0',
    })
  })
})
