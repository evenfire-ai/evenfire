import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { DbAuditSink } from '../../gfs-controller/src/authz/permissionClient.js'
import type { PermissionClient } from '../../gfs-controller/src/authz/permissionClient.js'
import { PgBlobStagingStore } from '../../gfs-controller/src/db/blobStaging.js'
import { GfsWriteService, PgTransactor } from '../../gfs-controller/src/db/writeStore.js'
import { BlobStore } from '../../gfs-controller/src/storage/blobStore.js'
import { createGfsUploadFinalizer } from '../../gfs-controller/src/upload/uploadFinalizer.js'
import type {
  UploadPartRow,
  UploadSessionRow,
} from '../../gfs-controller/src/upload/uploadSession.js'
import { initDb } from '../src/db.js'

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
    await pool?.query('DELETE FROM gfs_resources WHERE drive = $1', [drive]).catch(() => undefined)
    await pool
      ?.query('DELETE FROM gfs_upload_sessions WHERE drive = $1', [drive])
      .catch(() => undefined)
    await pool?.end()
    await rm(storageRoot, { recursive: true, force: true }).catch(() => undefined)
    await rm(blobRoot, { recursive: true, force: true }).catch(() => undefined)
    if (!adminPool) return
    await adminPool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [database]
    )
    await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)}`)
    await adminPool.end()
  })

  async function seedUpload(): Promise<{ upload: UploadSessionRow; uploadPart: UploadPartRow }> {
    const uploadId = randomUUID()
    const upload = session(uploadId, drive, parentId)
    const uploadPart = part(uploadId, storageRoot)
    await mkdir(join(storageRoot, '.uploads', uploadId, 'parts'), { recursive: true })
    await writeFile(uploadPart.stagingPath, BODY)
    await pool.query(
      `INSERT INTO gfs_upload_sessions
         (upload_id, idempotency_key, drive, owner_subject, primary_subject, operation,
          request_fingerprint, parent_rid, resource_name, expected_bytes, part_bytes,
          part_count, whole_sha256, committed_bytes, contiguous_bytes,
          committed_part_count, active_part_count, session_epoch, state, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
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
})
