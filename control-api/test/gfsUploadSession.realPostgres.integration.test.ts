import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { Pool } from 'pg'
import type { GfsUploadConfig } from '../../gfs-controller/src/config.js'
import { PgTransactor } from '../../gfs-controller/src/db/writeStore.js'
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
