import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { reconcileExpiredBlobs } from '../../gfs-controller/src/db/blobReconciliation.js'
import { PgBlobStagingStore } from '../../gfs-controller/src/db/blobStaging.js'
import type { GfsMetrics } from '../../gfs-controller/src/metrics.js'
import { BlobStore } from '../../gfs-controller/src/storage/blobStore.js'
import { resolveBlobKeyPath, resolveBlobPath } from '../../gfs-controller/src/storage/paths.js'
import { initDb } from '../src/db.js'

// This suite closes the reconciler's HIGH coverage gap: reconcileExpiredBlobs is
// the sole backstop for the write/copy paths' swallowed cleanup errors, yet its
// orphan-vs-referenced predicate and its real byte deletion were only ever
// exercised against a FakeDb with a stubbed deleteByKey. Here it runs against a
// real Postgres schema + a real on-disk BlobStore, asserting business-truth:
// actual bytes on the PVC and actual manifest rows.
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

// reconcileExpiredBlobs only calls setOrphanCandidates + recordBlobCleanupFailure;
// a minimal recording stub keeps the test off prom-client while still proving the
// failure counter is never touched on the happy paths.
function metricsStub(): { metrics: GfsMetrics; failures: number } {
  const state = { failures: 0 }
  const metrics = {
    setOrphanCandidates: () => undefined,
    recordBlobCleanupFailure: () => {
      state.failures += 1
    },
  } as unknown as GfsMetrics
  return {
    metrics,
    get failures() {
      return state.failures
    },
  }
}

describeRealPostgres('GFS blob reconciliation on real PostgreSQL + on-disk BlobStore', () => {
  const database = `gfs_recon_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  let adminPool: Pool
  let pool: Pool
  let blobRoot: string
  let blobs: BlobStore
  let manifests: PgBlobStagingStore

  // Age a just-staged manifest so it clears the reconciler's `updated_at <
  // now() - olderThanMs` gate deterministically (no sleep, no flake).
  async function ageCandidate(blobKey: string): Promise<void> {
    await pool.query(
      `UPDATE gfs_blob_manifests SET updated_at = now() - interval '1 hour' WHERE blob_key = $1`,
      [blobKey]
    )
  }

  async function manifestExists(blobKey: string): Promise<boolean> {
    const res = await pool.query('SELECT 1 FROM gfs_blob_manifests WHERE blob_key = $1', [blobKey])
    return (res.rowCount ?? 0) > 0
  }

  async function manifestState(blobKey: string): Promise<string | null> {
    const res = await pool.query('SELECT state FROM gfs_blob_manifests WHERE blob_key = $1', [
      blobKey,
    ])
    return res.rows[0]?.state ?? null
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
    pool = new Pool({ connectionString })
    await initDb({ connect: () => pool.connect() })
    blobRoot = await mkdtemp(join(tmpdir(), 'gfs-recon-real-pg-'))
    blobs = new BlobStore(blobRoot, 'writer')
    manifests = new PgBlobStagingStore(pool)
  }, 60_000)

  afterEach(async () => {
    // Reconciliation scans the whole table; isolate each case's business-truth by
    // clearing manifests + resources between cases (orphaned bytes with unique
    // UUIDs left on disk cannot collide with the next case's assertions).
    await pool.query('TRUNCATE gfs_blob_manifests, gfs_resources CASCADE')
  })

  afterAll(async () => {
    await pool?.end()
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

  it('reaps an orphaned generation blob: deletes the real bytes AND removes the manifest row', async () => {
    const resourceId = randomUUID()
    const payload = randomBytes(96)
    const written = await blobs.writeImmutable(resourceId, randomUUID(), payload)
    await manifests.recordStaged({
      blobKey: written.blobKey,
      requestId: randomUUID(),
      resourceId,
      candidateKind: 'generation',
      contentSha256: written.contentSha256,
      bytes: written.bytes,
    })
    await ageCandidate(written.blobKey)

    // Precondition: real bytes on disk, manifest row present, NO gfs_resources
    // row references this blob_key (it is a genuine orphan).
    const blobPath = resolveBlobKeyPath(blobRoot, written.blobKey)
    expect(existsSync(blobPath)).toBe(true)
    expect(await manifestExists(written.blobKey)).toBe(true)

    const recorder = metricsStub()
    const result = await reconcileExpiredBlobs(manifests, blobs, recorder.metrics, {
      olderThanMs: 1000,
      limit: 16,
    })

    expect(result.deleted).toBe(1)
    expect(result.failures).toBe(0)
    // Read the recording stub too: the reconciler's failure metric must stay
    // untouched, not just its returned tally.
    expect(recorder.failures).toBe(0)
    // Business-truth: the bytes are gone from the PVC and the manifest row is gone.
    expect(existsSync(blobPath)).toBe(false)
    expect(await manifestExists(written.blobKey)).toBe(false)
  })

  it('never deletes a generation blob still referenced by a live resource', async () => {
    const rootId = randomUUID()
    const fileId = randomUUID()
    const drive = `recon-ref-${randomBytes(4).toString('hex')}`
    const payload = randomBytes(96)
    const written = await blobs.writeImmutable(fileId, randomUUID(), payload)
    await manifests.recordStaged({
      blobKey: written.blobKey,
      requestId: randomUUID(),
      resourceId: fileId,
      candidateKind: 'generation',
      contentSha256: written.contentSha256,
      bytes: written.bytes,
    })
    // A live gfs_resources row references the blob_key — this must protect it.
    await pool.query(
      `INSERT INTO gfs_resources
         (resource_id, drive, parent_resource_id, name, kind, path_cache, version, bytes, blob_key, content_sha256)
       VALUES
         ($1,$3,NULL,'','directory','/',0,0,NULL,NULL),
         ($2,$3,$1,'ref.txt','file','/ref.txt',1,$4,$5,$6)`,
      [rootId, fileId, drive, written.bytes, written.blobKey, written.contentSha256]
    )
    await ageCandidate(written.blobKey)

    const blobPath = resolveBlobKeyPath(blobRoot, written.blobKey)
    const recorder = metricsStub()
    const result = await reconcileExpiredBlobs(manifests, blobs, recorder.metrics, {
      olderThanMs: 1000,
      limit: 16,
    })

    // The real NOT EXISTS predicate must exclude the referenced blob from the
    // delete claim, so no bytes are deleted and the bytes survive on the PVC.
    expect(result.deleted).toBe(0)
    expect(result.failures).toBe(0)
    // Read the recording stub too: the reconciler's failure metric must stay
    // untouched, not just its returned tally.
    expect(recorder.failures).toBe(0)
    // Business-truth that matters: the bytes are protected.
    expect(existsSync(blobPath)).toBe(true)
    // The now-redundant staged manifest IS metadata-GC'd by removeCommittedMetadata
    // (the gfs_resources.blob_key reference is the source of truth) — only the
    // bytes are protected, never re-deleted. This asserts the GC does NOT touch bytes.
    expect(await manifestExists(written.blobKey)).toBe(false)
  })

  it('reaps a legacy_flat orphan through the legacy predicate and deletes the flat bytes', async () => {
    const resourceId = randomUUID()
    const legacyPath = resolveBlobPath(blobRoot, resourceId)
    // A legacy_flat blob's manifest key IS the dash-stripped resource id (the
    // blob_key_valid CHECK: `blob_key = replace(resource_id,'-','')`); legacy
    // candidates carry no committed digest (content_sha256 IS NULL).
    const legacyBlobKey = resourceId.replace(/-/g, '')
    await writeFile(legacyPath, randomBytes(48), { mode: 0o600 })
    await manifests.recordStaged({
      blobKey: legacyBlobKey,
      requestId: randomUUID(),
      resourceId,
      candidateKind: 'legacy_flat',
      contentSha256: null,
      bytes: 48,
    })
    await ageCandidate(legacyBlobKey)

    expect(existsSync(legacyPath)).toBe(true)
    const recorder = metricsStub()
    const result = await reconcileExpiredBlobs(manifests, blobs, recorder.metrics, {
      olderThanMs: 1000,
      limit: 16,
    })

    expect(result.deleted).toBe(1)
    expect(result.failures).toBe(0)
    // Read the recording stub too: the reconciler's failure metric must stay
    // untouched, not just its returned tally.
    expect(recorder.failures).toBe(0)
    // Business-truth: the flat legacy bytes are gone and the manifest row is gone.
    expect(existsSync(legacyPath)).toBe(false)
    expect(await manifestExists(legacyBlobKey)).toBe(false)
    expect(await manifestState(legacyBlobKey)).toBeNull()
  })
})
