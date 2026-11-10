import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { DecisionCache } from '../../gfs-controller/src/authz/cache.js'
import { DbAuditSink, PermissionClient } from '../../gfs-controller/src/authz/permissionClient.js'
import { GfsSubjectResolutionDeniedError } from '../../gfs-controller/src/authz/subjectResolver.js'
import { PgBlobStagingStore } from '../../gfs-controller/src/db/blobStaging.js'
import { GfsWriteService, PgTransactor } from '../../gfs-controller/src/db/writeStore.js'
import { BlobStore } from '../../gfs-controller/src/storage/blobStore.js'
import { createGfsUploadFinalizer } from '../../gfs-controller/src/upload/uploadFinalizer.js'
import type {
  UploadPartRow,
  UploadPrincipal,
  UploadSessionRow,
} from '../../gfs-controller/src/upload/uploadSession.js'
import { initDb } from '../src/db.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip
const BODY = Buffer.alloc(1024 * 1024, 0x42)
const BODY_SHA256 = createHash('sha256').update(BODY).digest('hex')
const HOST_SUBJECT = 'host:1st:gfs-test/upload-finalizer'

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function session(uploadId: string, drive: string, parentRid: string): UploadSessionRow {
  return {
    uploadId,
    idempotencyKey: randomUUID(),
    drive,
    ownerSubject: HOST_SUBJECT,
    primarySubject: HOST_SUBJECT,
    operation: 'create',
    requestFingerprint: 'real-finalizer-test',
    parentRid,
    resourceRid: null,
    resourceName: `payload-${uploadId}.bin`,
    ifMatch: null,
    expectedBytes: BODY.length,
    partBytes: BODY.length,
    partCount: 1,
    wholeSha256: BODY_SHA256,
    committedBytes: BODY.length,
    contiguousBytes: BODY.length,
    committedPartCount: 1,
    activePartCount: 0,
    sessionEpoch: 0,
    state: 'finalizing',
    resultResourceId: null,
    resultVersion: null,
    resultSha256: null,
    failureCode: null,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }
}

function part(uploadId: string, root: string): UploadPartRow {
  return {
    uploadId,
    partNumber: 0,
    offsetBytes: 0,
    lengthBytes: BODY.length,
    sha256: BODY_SHA256,
    state: 'committed',
    stagingPath: join(root, '.uploads', uploadId, 'parts', '0.part'),
    leaseEpoch: 0,
  }
}

function permissions(allowed: () => boolean): PermissionClient {
  return {
    permissionEpoch: () => ({ generation: 0, bypassed: false }),
    authorize: async () => ({ allowed: allowed() }),
    authorizeWithin: async (_db: unknown, _ctx: unknown, requests: readonly unknown[]) =>
      requests.map(() => ({ allowed: allowed() })),
  } as unknown as PermissionClient
}

describeRealPostgres('GFS upload finalizer on real PostgreSQL + BlobStore', () => {
  const database = `gfs_upload_finalizer_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  const drive = `finalizer-${randomBytes(4).toString('hex')}`
  let adminPool: Pool
  let pool: Pool
  let storageRoot: string
  let blobRoot: string
  let parentId: string

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
    pool = new Pool({ connectionString })
    await initDb({ connect: () => pool.connect() })
    storageRoot = await mkdtemp(join(tmpdir(), 'gfs-upload-finalizer-parts-'))
    blobRoot = await mkdtemp(join(tmpdir(), 'gfs-upload-finalizer-blobs-'))
    parentId = randomUUID()
    await pool.query(
      `INSERT INTO gfs_resources
         (resource_id, drive, parent_resource_id, name, kind, path_cache, version, bytes)
       VALUES ($1, $2, NULL, '', 'directory', '/', 0, 0)`,
      [parentId, drive]
    )
  }, 60_000)

  afterAll(async () => {
    try {
      await pool
        ?.query('DELETE FROM gfs_resources WHERE drive = $1', [drive])
        .catch(() => undefined)
      await pool
        ?.query('DELETE FROM gfs_upload_sessions WHERE drive = $1', [drive])
        .catch(() => undefined)
      await endPoolAndWaitForClients(pool)
      await rm(storageRoot, { recursive: true, force: true }).catch(() => undefined)
      await rm(blobRoot, { recursive: true, force: true }).catch(() => undefined)
      if (!adminPool) return
      await adminPool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [database]
      )
      await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)}`)
    } finally {
      await adminPool?.end()
    }
  })

  async function seedUpload(
    options: { subject?: string; replaceRid?: string } = {}
  ): Promise<{ upload: UploadSessionRow; uploadPart: UploadPartRow }> {
    const uploadId = randomUUID()
    const base = session(uploadId, drive, parentId)
    const upload: UploadSessionRow = {
      ...base,
      ...(options.subject
        ? { ownerSubject: options.subject, primarySubject: options.subject }
        : {}),
      ...(options.replaceRid
        ? {
            operation: 'replace' as const,
            parentRid: null,
            resourceRid: options.replaceRid,
            resourceName: null,
            ifMatch: 0,
          }
        : {}),
    }
    const uploadPart = part(uploadId, storageRoot)
    await mkdir(join(storageRoot, '.uploads', uploadId, 'parts'), { recursive: true })
    await writeFile(uploadPart.stagingPath, BODY)
    await pool.query(
      `INSERT INTO gfs_upload_sessions
         (upload_id, idempotency_key, drive, owner_subject, primary_subject, operation,
          request_fingerprint, parent_rid, resource_name, expected_bytes, part_bytes,
          part_count, whole_sha256, committed_bytes, contiguous_bytes,
          committed_part_count, active_part_count, session_epoch, state, expires_at,
          resource_rid, if_match)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
      [
        upload.uploadId,
        upload.idempotencyKey,
        upload.drive,
        upload.ownerSubject,
        upload.primarySubject,
        upload.operation,
        upload.requestFingerprint,
        upload.parentRid,
        upload.resourceName,
        upload.expectedBytes,
        upload.partBytes,
        upload.partCount,
        upload.wholeSha256,
        upload.committedBytes,
        upload.contiguousBytes,
        upload.committedPartCount,
        upload.activePartCount,
        upload.sessionEpoch,
        upload.state,
        upload.expiresAt,
        upload.resourceRid,
        upload.ifMatch,
      ]
    )
    await pool.query(
      `INSERT INTO gfs_upload_parts
         (upload_id, part_number, offset_bytes, length_bytes, sha256, state,
          staging_path, lease_epoch, committed_at)
       VALUES ($1, 0, 0, $2, $3, 'committed', $4, 0, now())`,
      [upload.uploadId, BODY.length, BODY_SHA256, uploadPart.stagingPath]
    )
    return { upload, uploadPart }
  }

  function finalizer(allow: () => boolean): ReturnType<typeof createGfsUploadFinalizer> {
    const blobs = new BlobStore(blobRoot, 'writer')
    const writes = new GfsWriteService(new PgTransactor(pool), blobs, new PgBlobStagingStore(pool))
    return createGfsUploadFinalizer({
      pool,
      storageMountPath: storageRoot,
      permissions: permissions(allow),
      writeService: writes,
      audit: new DbAuditSink(pool),
    })
  }

  it('publishes the resource and receipt atomically through the real writer', async () => {
    const { upload, uploadPart } = await seedUpload()
    const result = await finalizer(() => true)(upload, [uploadPart])
    expect(result.sha256).toBe(BODY_SHA256)
    const receipt = await pool.query(
      `SELECT state, result_resource_id, result_version, result_sha256
         FROM gfs_upload_sessions WHERE upload_id = $1`,
      [upload.uploadId]
    )
    expect(receipt.rows[0]).toMatchObject({
      state: 'completed',
      result_resource_id: result.resourceId,
      result_version: String(result.version),
      result_sha256: BODY_SHA256,
    })
    const resource = await pool.query(
      `SELECT drive, parent_resource_id, bytes, content_sha256
         FROM gfs_resources WHERE resource_id = $1`,
      [result.resourceId]
    )
    expect(resource.rows[0]).toMatchObject({
      drive,
      parent_resource_id: parentId,
      bytes: String(BODY.length),
      content_sha256: BODY_SHA256,
    })
    const manifests = await pool.query(
      `SELECT count(*)::int AS count FROM gfs_blob_manifests WHERE resource_id = $1`,
      [result.resourceId]
    )
    expect(manifests.rows[0]?.count).toBe(0)
  }, 30_000)

  it('finalizes on a one-client pool: no second client is checked out during publication', async () => {
    // Issue #1398: the re-authorization reads and audits on the pool. Inside the
    // publication transaction that needs a second client; with one client the
    // checkout times out and the finalization fails as not_mounted.
    const { upload, uploadPart } = await seedUpload()
    await pool.query(
      `INSERT INTO gfs_grants (drive, resource_id, subject_type, subject_id, permissions)
       VALUES ($1, $2, 'host', $3, ARRAY['write'])`,
      [drive, parentId, HOST_SUBJECT.slice('host:'.length)]
    )
    const singleClientPool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 3_000 })
    try {
      const audit = new DbAuditSink(singleClientPool)
      const realPermissions = new PermissionClient(
        singleClientPool,
        audit,
        new DecisionCache({ ttlMs: 60_000 })
      )
      const writes = new GfsWriteService(
        new PgTransactor(singleClientPool),
        new BlobStore(blobRoot, 'writer'),
        new PgBlobStagingStore(singleClientPool)
      )
      const finalize = createGfsUploadFinalizer({
        pool: singleClientPool,
        storageMountPath: storageRoot,
        permissions: realPermissions,
        writeService: writes,
        audit,
      })

      const result = await finalize(upload, [uploadPart])

      expect(result).toMatchObject({ resourceId: upload.uploadId, sha256: BODY_SHA256 })
      const receipt = await pool.query(
        `SELECT state, result_resource_id FROM gfs_upload_sessions WHERE upload_id = $1`,
        [upload.uploadId]
      )
      expect(receipt.rows[0]).toEqual({ state: 'completed', result_resource_id: upload.uploadId })
      const resource = await pool.query(
        `SELECT count(*)::int AS count FROM gfs_resources WHERE resource_id = $1`,
        [upload.uploadId]
      )
      expect(resource.rows[0]?.count).toBe(1)
      // Liveness: the re-authorization ran against the real permission store.
      const decisions = await pool.query(
        `SELECT outcome, authorization_source, matched_subject, cached_authorization_source
           FROM gfs_audit
          WHERE record_type = 'authorization_decision' AND gfs_uri = $1 AND subject = $2`,
        [`gfs://${drive}/${parentId}`, HOST_SUBJECT]
      )
      expect(decisions.rows).toEqual([
        {
          outcome: 'allow',
          authorization_source: 'direct_grant',
          matched_subject: HOST_SUBJECT,
          cached_authorization_source: null,
        },
      ])
    } finally {
      await endPoolAndWaitForClients(singleClientPool)
      await pool.query(`DELETE FROM gfs_grants WHERE drive = $1`, [drive])
    }
  }, 30_000)

  it('fences an old finalizer after reclaim so it cannot publish a resource or receipt', async () => {
    const { upload, uploadPart } = await seedUpload()
    await pool.query(
      `UPDATE gfs_upload_sessions
          SET session_epoch = session_epoch + 1,
              finalizing_started_at = now() - interval '1 hour'
        WHERE upload_id = $1`,
      [upload.uploadId]
    )

    await expect(finalizer(() => true)(upload, [uploadPart])).rejects.toMatchObject({
      code: 'upload_aborted',
    })

    const sessionRow = await pool.query(
      `SELECT state, session_epoch, result_resource_id, result_version, result_sha256
         FROM gfs_upload_sessions WHERE upload_id = $1`,
      [upload.uploadId]
    )
    expect(sessionRow.rows[0]).toMatchObject({
      state: 'finalizing',
      session_epoch: '1',
      result_resource_id: null,
      result_version: null,
      result_sha256: null,
    })

    const resource = await pool.query(
      `SELECT count(*)::int AS count FROM gfs_resources WHERE resource_id = $1`,
      [upload.uploadId]
    )
    expect(resource.rows[0]?.count).toBe(0)
    const manifests = await pool.query(
      `SELECT count(*)::int AS count FROM gfs_blob_manifests WHERE resource_id = $1`,
      [upload.uploadId]
    )
    expect(manifests.rows[0]?.count).toBe(0)
  }, 30_000)

  it('rolls back the real resource and receipt when authorization is denied', async () => {
    const { upload, uploadPart } = await seedUpload()
    await expect(finalizer(() => false)(upload, [uploadPart])).rejects.toMatchObject({
      code: 'forbidden',
    })
    const receipt = await pool.query(
      `SELECT state, result_resource_id FROM gfs_upload_sessions WHERE upload_id = $1`,
      [upload.uploadId]
    )
    expect(receipt.rows[0]).toEqual({ state: 'finalizing', result_resource_id: null })
    const resource = await pool.query(
      `SELECT count(*)::int AS count FROM gfs_resources WHERE resource_id = $1`,
      [upload.uploadId]
    )
    expect(resource.rows[0]?.count).toBe(0)
    const manifests = await pool.query(
      `SELECT count(*)::int AS count FROM gfs_blob_manifests WHERE resource_id = $1`,
      [upload.uploadId]
    )
    expect(manifests.rows[0]?.count).toBe(0)
  }, 30_000)

  // ── Authority re-check inside the publication transaction ────────────────
  // Each case seeds its own user and team, so grants and audit rows are
  // filtered by that subject (the drive and its root are shared).

  async function seedUser(options: { member?: boolean } = {}): Promise<{
    userId: string
    teamId: string
    principal: UploadPrincipal
  }> {
    const userId = randomUUID()
    const teamId = randomUUID()
    await pool.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [
      userId,
      `${userId}@finalizer.test`,
    ])
    await pool.query(`INSERT INTO teams (id, name) VALUES ($1, 'Finalizer re-check team')`, [
      teamId,
    ])
    if (options.member !== false) {
      await pool.query(
        `INSERT INTO team_members (team_id, user_id, role, status) VALUES ($1, $2, 'member', 'active')`,
        [teamId, userId]
      )
    }
    return {
      userId,
      teamId,
      principal: {
        drive,
        ownerSubject: userId,
        primarySubject: userId,
        principalType: 'user',
        authGeneration: 1,
      },
    }
  }

  async function grantWrite(
    resourceId: string,
    subjectType: 'user' | 'team',
    subjectId: string
  ): Promise<void> {
    await pool.query(
      `INSERT INTO gfs_grants (drive, resource_id, subject_type, subject_id, permissions)
       VALUES ($1, $2, $3, $4, ARRAY['write'])`,
      [drive, resourceId, subjectType, subjectId]
    )
  }

  /** Holds a lock on its own client until `release`; reports its backend pid. */
  async function holdLock(
    sql: string,
    values: unknown[]
  ): Promise<{ pid: number; release: () => Promise<void> }> {
    const holder = await pool.connect()
    await holder.query('BEGIN')
    await holder.query(sql, values)
    const pid = Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
    let released = false
    return {
      pid,
      release: async () => {
        if (released) return
        released = true
        try {
          await holder.query('COMMIT')
        } finally {
          holder.release()
        }
      },
    }
  }

  const holdStructureLock = () =>
    holdLock(`SELECT pg_advisory_xact_lock(hashtext('gfs:structure:' || $1)::bigint)`, [drive])
  const holdRowLock = (resourceId: string) =>
    holdLock(`SELECT resource_id FROM gfs_resources WHERE resource_id = $1 FOR UPDATE`, [
      resourceId,
    ])

  /** Waits until another backend of this database waits on one of `events`. */
  async function waitForLockWait(holderPid: number, events: readonly string[]): Promise<void> {
    const deadline = Date.now() + 10_000
    for (;;) {
      const waiting = await pool.query(
        `SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE datname = $1 AND wait_event_type = 'Lock' AND wait_event = ANY($2::text[]) AND pid <> $3`,
        [database, events, holderPid]
      )
      if (waiting.rows[0]?.count > 0) return
      if (Date.now() >= deadline)
        throw new Error(`no backend waited on ${events.join('/')} within 10 s`)
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }

  function realFinalizer(target: Pool, cache = new DecisionCache({ ttlMs: 60_000 })) {
    const audit = new DbAuditSink(target)
    const finalize = createGfsUploadFinalizer({
      pool: target,
      storageMountPath: storageRoot,
      permissions: new PermissionClient(target, audit, cache),
      writeService: new GfsWriteService(
        new PgTransactor(target),
        new BlobStore(blobRoot, 'writer'),
        new PgBlobStagingStore(target)
      ),
      audit,
    })
    return { finalize, cache }
  }

  async function decisions(subject: string, resourceId: string) {
    const rows = await pool.query(
      `SELECT outcome, matched_subject FROM gfs_audit
        WHERE record_type = 'authorization_decision' AND subject = $1 AND gfs_uri = $2
        ORDER BY sequence_no`,
      [subject, `gfs://${drive}/${resourceId}`]
    )
    return rows.rows
  }

  async function outcomes(subject: string, resourceId: string) {
    const rows = await pool.query(
      `SELECT op, outcome, mutation_outcome FROM gfs_audit
        WHERE record_type = 'mutation_outcome' AND subject = $1 AND gfs_uri = $2
        ORDER BY sequence_no`,
      [subject, `gfs://${drive}/${resourceId.replaceAll('-', '')}`]
    )
    return rows.rows
  }

  async function expectNotPublished(uploadId: string): Promise<void> {
    const resource = await pool.query(
      `SELECT count(*)::int AS count FROM gfs_resources WHERE resource_id = $1`,
      [uploadId]
    )
    expect(resource.rows[0]?.count).toBe(0)
    const receipt = await pool.query(
      `SELECT state, result_resource_id FROM gfs_upload_sessions WHERE upload_id = $1`,
      [uploadId]
    )
    expect(receipt.rows[0]).toEqual({ state: 'finalizing', result_resource_id: null })
    const manifests = await pool.query(
      `SELECT count(*)::int AS count FROM gfs_blob_manifests WHERE resource_id = $1`,
      [uploadId]
    )
    expect(manifests.rows[0]?.count).toBe(0)
  }

  async function expectPublished(uploadId: string): Promise<void> {
    const receipt = await pool.query(
      `SELECT state, result_resource_id FROM gfs_upload_sessions WHERE upload_id = $1`,
      [uploadId]
    )
    expect(receipt.rows[0]).toEqual({ state: 'completed', result_resource_id: uploadId })
  }

  /**
   * Runs `finalize` while `lock` is held, applies `change` once the
   * publication transaction waits for it, then releases the lock. The result is
   * observed from the start, so a rejection is never unhandled.
   */
  async function duringLockWait<T>(
    lock: { pid: number; release: () => Promise<void> },
    events: readonly string[],
    run: () => Promise<T>,
    change: () => Promise<void>
  ): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
    try {
      const settled = run().then(
        value => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error })
      )
      await waitForLockWait(lock.pid, events)
      await change()
      await lock.release()
      return await settled
    } finally {
      await lock.release()
    }
  }

  it('RP1: finalizes a replace on a one-client pool with a user principal', async () => {
    const { userId, principal } = await seedUser()
    const seeded = await new GfsWriteService(
      new PgTransactor(pool),
      new BlobStore(blobRoot, 'writer'),
      new PgBlobStagingStore(pool)
    ).create({
      drive,
      parentId,
      name: `replace-${userId}.bin`,
      kind: 'file',
      content: Buffer.from('seed'),
    })
    await grantWrite(seeded.resourceId, 'user', userId)
    const { upload, uploadPart } = await seedUpload({
      subject: userId,
      replaceRid: seeded.resourceId,
    })
    const singleClientPool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 3_000 })
    try {
      const result = await realFinalizer(singleClientPool).finalize(
        upload,
        [uploadPart],
        undefined,
        undefined,
        principal
      )

      expect(result).toEqual({ resourceId: seeded.resourceId, version: 1, sha256: BODY_SHA256 })
      const receipt = await pool.query(
        `SELECT state, result_version FROM gfs_upload_sessions WHERE upload_id = $1`,
        [upload.uploadId]
      )
      expect(receipt.rows[0]).toEqual({ state: 'completed', result_version: '1' })
      const resource = await pool.query(
        `SELECT version, content_sha256 FROM gfs_resources WHERE resource_id = $1`,
        [seeded.resourceId]
      )
      expect(resource.rows[0]).toEqual({ version: 1, content_sha256: BODY_SHA256 })
      // Liveness and target: the decision was made for the replaced file.
      const rows = await pool.query(
        `SELECT outcome, authorization_source FROM gfs_audit
          WHERE record_type = 'authorization_decision' AND subject = $1 AND gfs_uri = $2`,
        [userId, `gfs://${drive}/${seeded.resourceId}`]
      )
      expect(rows.rows).toEqual([{ outcome: 'allow', authorization_source: 'direct_grant' }])
    } finally {
      await endPoolAndWaitForClients(singleClientPool)
    }
  }, 30_000)

  it('RP2a: a team removed during the structure-lock wait leaves no authority and rejects', async () => {
    const { userId, teamId, principal } = await seedUser()
    await grantWrite(parentId, 'team', teamId)
    const { upload, uploadPart } = await seedUpload({ subject: userId })
    const { finalize } = realFinalizer(pool)

    const result = await duringLockWait(
      await holdStructureLock(),
      ['advisory'],
      () => finalize(upload, [uploadPart], undefined, undefined, principal),
      async () => {
        await pool.query(
          `UPDATE team_members SET status = 'deleted' WHERE team_id = $1 AND user_id = $2`,
          [teamId, userId]
        )
      }
    )

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'forbidden', message: 'upload authorization was revoked before publication' },
    })
    await expectNotPublished(upload.uploadId)
    // The pre-BEGIN allow is durable; the in-transaction deny rolled back.
    expect(await decisions(userId, parentId)).toEqual([
      { outcome: 'allow', matched_subject: `team:${teamId}` },
    ])
    expect(await outcomes(userId, upload.uploadId)).toEqual([
      { op: 'create', outcome: 'error', mutation_outcome: 'failed' },
    ])
  }, 30_000)

  it('RP2b: a user generation moved during the structure-lock wait rejects with the subject denial', async () => {
    const { userId, teamId, principal } = await seedUser()
    await grantWrite(parentId, 'team', teamId)
    const { upload, uploadPart } = await seedUpload({ subject: userId })
    const { finalize } = realFinalizer(pool)

    const result = await duringLockWait(
      await holdStructureLock(),
      ['advisory'],
      () => finalize(upload, [uploadPart], undefined, undefined, principal),
      async () => {
        await pool.query(
          `UPDATE users SET lifecycle_version = lifecycle_version + 1 WHERE id = $1`,
          [userId]
        )
      }
    )

    expect(result.ok).toBe(false)
    expect((result as { error: unknown }).error).toBeInstanceOf(GfsSubjectResolutionDeniedError)
    await expectNotPublished(upload.uploadId)
    expect(await decisions(userId, parentId)).toEqual([
      { outcome: 'allow', matched_subject: `team:${teamId}` },
    ])
  }, 30_000)

  it('RP2c: a team removed during the wait with an overlapping user grant publishes and audits the remaining authority', async () => {
    const { userId, teamId, principal } = await seedUser()
    await grantWrite(parentId, 'team', teamId)
    await grantWrite(parentId, 'user', userId)
    const { upload, uploadPart } = await seedUpload({ subject: userId })
    const { finalize } = realFinalizer(pool)

    const result = await duringLockWait(
      await holdStructureLock(),
      ['advisory'],
      () => finalize(upload, [uploadPart], undefined, undefined, principal),
      async () => {
        await pool.query(
          `UPDATE team_members SET status = 'deleted' WHERE team_id = $1 AND user_id = $2`,
          [teamId, userId]
        )
      }
    )

    expect(result).toMatchObject({ ok: true, value: { resourceId: upload.uploadId } })
    await expectPublished(upload.uploadId)
    expect(await decisions(userId, parentId)).toEqual([
      { outcome: 'allow', matched_subject: `team:${teamId}` },
      { outcome: 'allow', matched_subject: `user:${userId}` },
    ])
  }, 30_000)

  it('RP2d: the overlap re-decision runs on the transaction client of a one-client pool', async () => {
    const { userId, teamId, principal } = await seedUser()
    await grantWrite(parentId, 'team', teamId)
    await grantWrite(parentId, 'user', userId)
    const { upload, uploadPart } = await seedUpload({ subject: userId })
    const singleClientPool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 3_000 })
    try {
      const { finalize } = realFinalizer(singleClientPool)
      const result = await duringLockWait(
        await holdStructureLock(),
        ['advisory'],
        () => finalize(upload, [uploadPart], undefined, undefined, principal),
        async () => {
          await pool.query(
            `UPDATE team_members SET status = 'deleted' WHERE team_id = $1 AND user_id = $2`,
            [teamId, userId]
          )
        }
      )
      expect(result).toMatchObject({ ok: true, value: { resourceId: upload.uploadId } })
      await expectPublished(upload.uploadId)
      expect(await decisions(userId, parentId)).toHaveLength(2)
    } finally {
      await endPoolAndWaitForClients(singleClientPool)
    }
  }, 30_000)

  it('RP3: a user generation moved during the row-lock wait rejects a replace', async () => {
    const { userId, principal } = await seedUser()
    const seeded = await new GfsWriteService(
      new PgTransactor(pool),
      new BlobStore(blobRoot, 'writer'),
      new PgBlobStagingStore(pool)
    ).create({
      drive,
      parentId,
      name: `row-lock-${userId}.bin`,
      kind: 'file',
      content: Buffer.from('seed'),
    })
    await grantWrite(seeded.resourceId, 'user', userId)
    const { upload, uploadPart } = await seedUpload({
      subject: userId,
      replaceRid: seeded.resourceId,
    })
    const { finalize } = realFinalizer(pool)

    const result = await duringLockWait(
      await holdRowLock(seeded.resourceId),
      ['transactionid', 'tuple'],
      () => finalize(upload, [uploadPart], undefined, undefined, principal),
      async () => {
        await pool.query(
          `UPDATE users SET lifecycle_version = lifecycle_version + 1 WHERE id = $1`,
          [userId]
        )
      }
    )

    expect(result.ok).toBe(false)
    expect((result as { error: unknown }).error).toBeInstanceOf(GfsSubjectResolutionDeniedError)
    const resource = await pool.query(`SELECT version FROM gfs_resources WHERE resource_id = $1`, [
      seeded.resourceId,
    ])
    expect(resource.rows[0]).toEqual({ version: 0 })
    expect(await decisions(userId, seeded.resourceId)).toEqual([
      { outcome: 'allow', matched_subject: `user:${userId}` },
    ])
  }, 30_000)

  it('RP-O2a: an unrelated grant change during the wait re-decides and publishes', async () => {
    const { userId, principal } = await seedUser()
    await grantWrite(parentId, 'user', userId)
    const unrelated = randomUUID()
    await pool.query(
      `INSERT INTO gfs_resources (resource_id, drive, parent_resource_id, name, kind, path_cache, version, bytes)
       VALUES ($1, $2, $3, $4, 'directory', $5, 0, 0)`,
      [unrelated, drive, parentId, `unrelated-${userId}`, `/unrelated-${userId}`]
    )
    const { upload, uploadPart } = await seedUpload({ subject: userId })
    const { finalize, cache } = realFinalizer(pool)

    const result = await duringLockWait(
      await holdStructureLock(),
      ['advisory'],
      () => finalize(upload, [uploadPart], undefined, undefined, principal),
      async () => {
        await grantWrite(unrelated, 'user', randomUUID())
        cache.flushAll()
      }
    )

    expect(result).toMatchObject({ ok: true, value: { resourceId: upload.uploadId } })
    await expectPublished(upload.uploadId)
    expect(await decisions(userId, parentId)).toEqual([
      { outcome: 'allow', matched_subject: `user:${userId}` },
      { outcome: 'allow', matched_subject: `user:${userId}` },
    ])
  }, 30_000)

  it('RP-O2b: the only grant revoked during the wait re-decides and rejects', async () => {
    const { userId, principal } = await seedUser()
    await grantWrite(parentId, 'user', userId)
    const { upload, uploadPart } = await seedUpload({ subject: userId })
    const { finalize, cache } = realFinalizer(pool)

    const result = await duringLockWait(
      await holdStructureLock(),
      ['advisory'],
      () => finalize(upload, [uploadPart], undefined, undefined, principal),
      async () => {
        await pool.query(
          `DELETE FROM gfs_grants WHERE drive = $1 AND resource_id = $2 AND subject_type = 'user' AND subject_id = $3`,
          [drive, parentId, userId]
        )
        cache.flushAll()
      }
    )

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'forbidden', message: 'upload authorization was revoked before publication' },
    })
    await expectNotPublished(upload.uploadId)
    expect(await decisions(userId, parentId)).toEqual([
      { outcome: 'allow', matched_subject: `user:${userId}` },
    ])
    expect(await outcomes(userId, upload.uploadId)).toEqual([
      { op: 'create', outcome: 'error', mutation_outcome: 'failed' },
    ])
  }, 30_000)

  it('RP-O2c: a pre-BEGIN denial is re-decided when a team membership is gained during the wait', async () => {
    const { userId, teamId, principal } = await seedUser({ member: false })
    await grantWrite(parentId, 'team', teamId)
    const { upload, uploadPart } = await seedUpload({ subject: userId })
    const { finalize } = realFinalizer(pool)

    const result = await duringLockWait(
      await holdStructureLock(),
      ['advisory'],
      () => finalize(upload, [uploadPart], undefined, undefined, principal),
      async () => {
        await pool.query(
          `INSERT INTO team_members (team_id, user_id, role, status) VALUES ($1, $2, 'member', 'active')`,
          [teamId, userId]
        )
      }
    )

    expect(result).toMatchObject({ ok: true, value: { resourceId: upload.uploadId } })
    await expectPublished(upload.uploadId)
    expect(await decisions(userId, parentId)).toEqual([
      { outcome: 'deny', matched_subject: null },
      { outcome: 'allow', matched_subject: `team:${teamId}` },
    ])
  }, 30_000)
})
