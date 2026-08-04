import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { preflightCopy } from '../../gfs-controller/src/api/copy.js'
import { DbAuditSink } from '../../gfs-controller/src/authz/audit.js'
import { PgBlobStagingStore } from '../../gfs-controller/src/db/blobStaging.js'
import { PgResourceStore } from '../../gfs-controller/src/db/resourceStore.js'
import { GfsWriteService, PgTransactor } from '../../gfs-controller/src/db/writeStore.js'
import { BlobStore } from '../../gfs-controller/src/storage/blobStore.js'
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

function compact(id: string): string {
  return id.replaceAll('-', '').toLowerCase()
}

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks)
}

interface SeededTree {
  drive: string
  rootId: string
  sourceId: string
  nestedId: string
  firstFileId: string
  secondFileId: string
  destinationId: string
  files: Map<string, Buffer>
}

describeRealPostgres('GFS Copy publication on real PostgreSQL and filesystem blobs', () => {
  const database = `gfs_copy_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  let adminPool: Pool
  let pool: Pool
  let blobRoot: string
  let blobs: BlobStore
  let resources: PgResourceStore
  let writes: GfsWriteService
  let audit: DbAuditSink

  async function seedTree(label: string): Promise<SeededTree> {
    const tree: SeededTree = {
      drive: `copy-${label}-${randomBytes(4).toString('hex')}`,
      rootId: randomUUID(),
      sourceId: randomUUID(),
      nestedId: randomUUID(),
      firstFileId: randomUUID(),
      secondFileId: randomUUID(),
      destinationId: randomUUID(),
      files: new Map([
        ['first', Buffer.from(`first-${label}`)],
        ['second', Buffer.from(`second-${label}-payload`)],
      ]),
    }
    const firstBlob = await blobs.writeImmutable(
      tree.firstFileId,
      randomUUID(),
      tree.files.get('first')!
    )
    const secondBlob = await blobs.writeImmutable(
      tree.secondFileId,
      randomUUID(),
      tree.files.get('second')!
    )
    await pool.query(
      `INSERT INTO gfs_resources
         (resource_id, drive, parent_resource_id, name, kind, path_cache, version,
          bytes, blob_key, content_sha256)
       VALUES
         ($1,$7,NULL,'','directory','/',0,0,NULL,NULL),
         ($2,$7,$1,'source','directory','/source',3,0,NULL,NULL),
         ($3,$7,$2,'nested','directory','/source/nested',0,0,NULL,NULL),
         ($4,$7,$2,'first.txt','file','/source/first.txt',1,$8,$9,$10),
         ($5,$7,$3,'second.txt','file','/source/nested/second.txt',2,$11,$12,$13),
         ($6,$7,$1,'archive','directory','/archive',0,0,NULL,NULL)`,
      [
        tree.rootId,
        tree.sourceId,
        tree.nestedId,
        tree.firstFileId,
        tree.secondFileId,
        tree.destinationId,
        tree.drive,
        firstBlob.bytes,
        firstBlob.blobKey,
        firstBlob.contentSha256,
        secondBlob.bytes,
        secondBlob.blobKey,
        secondBlob.contentSha256,
      ]
    )
    return tree
  }

  async function planFor(tree: SeededTree, newName?: string) {
    const snapshot = await resources.loadCopySnapshot(tree.drive, tree.sourceId, 1_001n)
    const rootName = newName ?? snapshot.find(node => node.depth === 0)!.name
    const destination = await resources.loadCopyDestination(
      tree.drive,
      tree.destinationId,
      rootName
    )
    return {
      snapshot,
      destination,
      plan: preflightCopy({
        drive: tree.drive,
        sourceResourceId: tree.sourceId,
        destinationParentId: tree.destinationId,
        newName,
        ifMatch: 3,
        snapshot,
        destination,
        maxObjects: 1_000,
        maxBytes: 1_073_741_824,
        deadlineAtMs: Date.now() + 30_000,
        nowMs: Date.now(),
      }),
    }
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
    pool = new Pool({ connectionString })
    await initDb({ connect: () => pool.connect() })
    blobRoot = await mkdtemp(join(tmpdir(), 'gfs-copy-real-pg-'))
    blobs = new BlobStore(blobRoot, 'writer')
    resources = new PgResourceStore(pool)
    audit = new DbAuditSink(pool)
    writes = new GfsWriteService(new PgTransactor(pool), blobs, new PgBlobStagingStore(pool))
  }, 60_000)

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

  it('publishes a recursive copy atomically, preserves the source, and records success in the publication transaction', async () => {
    const tree = await seedTree('success')
    const before = await pool.query(
      `SELECT resource_id, parent_resource_id, path_cache, version, bytes, blob_key, content_sha256
         FROM gfs_resources WHERE drive=$1 ORDER BY resource_id`,
      [tree.drive]
    )
    const frozen = await planFor(tree, 'source-copy')
    const requestId = randomUUID()
    const result = await writes.copy({
      requestId,
      subject: 'host:sandbox-recipes/copy-real-pg',
      audit,
      drive: tree.drive,
      destinationParentId: tree.destinationId,
      plan: frozen.plan,
      destination: frozen.destination,
      deadlineAtMs: Date.now() + 30_000,
    })

    expect(result).toMatchObject({ objectCount: 4, fileCount: 2, folderCount: 2 })
    expect(result.totalBytes).toBe(
      BigInt(tree.files.get('first')!.length + tree.files.get('second')!.length)
    )
    const sourceAfter = await pool.query(
      `SELECT resource_id, parent_resource_id, path_cache, version, bytes, blob_key, content_sha256
         FROM gfs_resources WHERE drive=$1 AND path_cache NOT LIKE '/archive/source-copy%' ORDER BY resource_id`,
      [tree.drive]
    )
    expect(sourceAfter.rows).toEqual(before.rows)

    const copied = await pool.query(
      `SELECT resource_id, parent_resource_id, path_cache, kind, bytes, blob_key, content_sha256, xmin::text AS txid
         FROM gfs_resources WHERE drive=$1 AND path_cache LIKE '/archive/source-copy%'
         ORDER BY path_cache`,
      [tree.drive]
    )
    expect(copied.rows.map(row => row.path_cache)).toEqual([
      '/archive/source-copy',
      '/archive/source-copy/first.txt',
      '/archive/source-copy/nested',
      '/archive/source-copy/nested/second.txt',
    ])
    const sourceIds = new Set(
      [tree.sourceId, tree.nestedId, tree.firstFileId, tree.secondFileId].map(compact)
    )
    expect(copied.rows.every(row => !sourceIds.has(compact(String(row.resource_id))))).toBe(true)
    expect(
      copied.rows
        .filter(row => row.kind === 'file')
        .map(row => Number(row.bytes))
        .sort((a, b) => a - b)
    ).toEqual([...tree.files.values()].map(value => value.length).sort((a, b) => a - b))

    const copiedFiles = copied.rows.filter(row => row.kind === 'file')
    const copiedPayloads = await Promise.all(
      copiedFiles.map(async row =>
        readAll(await blobs.read(String(row.resource_id), String(row.blob_key)))
      )
    )
    expect(copiedPayloads.map(value => value.toString()).sort()).toEqual(
      [...tree.files.values()].map(value => value.toString()).sort()
    )

    const outcome = await pool.query(
      `SELECT op, record_type, mutation_outcome, request_id, xmin::text AS txid
         FROM gfs_audit WHERE request_id=$1`,
      [requestId]
    )
    expect(outcome.rows).toHaveLength(1)
    expect(outcome.rows[0]).toMatchObject({
      op: 'copy',
      record_type: 'mutation_outcome',
      mutation_outcome: 'succeeded',
      request_id: requestId,
    })
    expect(new Set(copied.rows.map(row => row.txid))).toEqual(new Set([outcome.rows[0]?.txid]))
  })

  it('rejects a destination collision before staging or publishing any node', async () => {
    const tree = await seedTree('collision')
    await pool.query(
      `INSERT INTO gfs_resources(resource_id,drive,parent_resource_id,name,kind,path_cache,version,bytes)
       VALUES ($1,$2,$3,'source','directory','/archive/source',0,0)`,
      [randomUUID(), tree.drive, tree.destinationId]
    )
    const before = await pool.query(
      `SELECT count(*)::integer AS count FROM gfs_resources WHERE drive=$1`,
      [tree.drive]
    )
    const snapshot = await resources.loadCopySnapshot(tree.drive, tree.sourceId, 1_001n)
    const destination = await resources.loadCopyDestination(
      tree.drive,
      tree.destinationId,
      'source'
    )
    expect(() =>
      preflightCopy({
        drive: tree.drive,
        sourceResourceId: tree.sourceId,
        destinationParentId: tree.destinationId,
        ifMatch: 3,
        snapshot,
        destination,
        maxObjects: 1_000,
        maxBytes: 1_073_741_824,
        deadlineAtMs: Date.now() + 30_000,
        nowMs: Date.now(),
      })
    ).toThrow(expect.objectContaining({ code: 'already_exists' }))
    const after = await pool.query(
      `SELECT count(*)::integer AS count FROM gfs_resources WHERE drive=$1`,
      [tree.drive]
    )
    const manifests = await pool.query(
      `SELECT count(*)::integer AS count FROM gfs_blob_manifests WHERE resource_id IN
       (SELECT resource_id FROM gfs_resources WHERE drive=$1)`,
      [tree.drive]
    )
    expect(after.rows).toEqual(before.rows)
    expect(manifests.rows[0]?.count).toBe(0)
  })

  it('fails on a changed source version and leaves no copied metadata or staged blobs', async () => {
    const tree = await seedTree('version-change')
    const frozen = await planFor(tree, 'stale-copy')
    const requestId = randomUUID()
    await pool.query('UPDATE gfs_resources SET version=version+1 WHERE resource_id=$1', [
      tree.secondFileId,
    ])

    await expect(
      writes.copy({
        requestId,
        subject: 'host:sandbox-recipes/copy-real-pg',
        audit,
        drive: tree.drive,
        destinationParentId: tree.destinationId,
        plan: frozen.plan,
        destination: frozen.destination,
        deadlineAtMs: Date.now() + 30_000,
      })
    ).rejects.toMatchObject({ code: 'precondition_failed' })

    const copied = await pool.query(
      `SELECT count(*)::integer AS count FROM gfs_resources
        WHERE drive=$1 AND path_cache LIKE '/archive/stale-copy%'`,
      [tree.drive]
    )
    const manifests = await pool.query(
      `SELECT count(*)::integer AS count FROM gfs_blob_manifests WHERE request_id=$1`,
      [requestId]
    )
    const outcome = await pool.query(`SELECT mutation_outcome FROM gfs_audit WHERE request_id=$1`, [
      requestId,
    ])
    expect(copied.rows[0]?.count).toBe(0)
    expect(manifests.rows[0]?.count).toBe(0)
    expect(outcome.rows).toEqual([{ mutation_outcome: 'failed' }])
  })

  // Concurrency — the optimistic If-Match path. replace() locks the row and
  // re-checks the version inside the writer transaction; two replaces of the
  // same file racing with the SAME If-Match can only be adjudicated by real row
  // locks, so this belongs in the real-PG suite, not the scripted-client unit.
  it('serializes two concurrent replaces of the same file: one version bump, the loser is precondition_failed', async () => {
    const tree = await seedTree('race-replace')
    // first.txt was seeded at version 1. Each replace runs on its own pooled
    // connection: the writer that locks the row first bumps version 1->2 and
    // commits; the other then sees version 2 != If-Match 1 and must fail.
    const fileId = tree.firstFileId
    const contentA = Buffer.from('replacement-A-payload')
    const contentB = Buffer.from('replacement-B-different-length')
    const attempt = (content: Buffer) =>
      writes.replace({ drive: tree.drive, resourceId: fileId, ifMatch: 1, content })

    const results = await Promise.allSettled([attempt(contentA), attempt(contentB)])
    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof writes.replace>>> =>
        r.status === 'fulfilled'
    )
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]!.reason).toMatchObject({ code: 'precondition_failed' })

    // Business truth: version bumped exactly once (1->2), and the bytes served
    // from the real blob store are the winner's — never a torn blend.
    const row = await pool.query(
      `SELECT version, bytes, blob_key FROM gfs_resources WHERE drive=$1 AND resource_id=$2`,
      [tree.drive, fileId]
    )
    expect(Number(row.rows[0]?.version)).toBe(2)
    const served = await readAll(await blobs.read(fileId, String(row.rows[0]?.blob_key)))
    expect([contentA, contentB].some(candidate => candidate.equals(served))).toBe(true)
    expect(Number(row.rows[0]?.bytes)).toBe(served.length)
  })

  // Concurrency — the per-drive advisory lock + destination re-check. Two copies
  // into the SAME destination name, both passing preflight before either
  // publishes, must not both land.
  it('serializes two concurrent copies into the same destination name: one wins, the loser is already_exists', async () => {
    const tree = await seedTree('race-copy')
    // Independent frozen plans for the same '/archive/dup' name. Under the
    // per-drive advisory lock the first copy inserts the subtree; the second
    // re-checks the destination name inside the writer txn, finds it taken, and
    // fails already_exists — the loser inserts nothing.
    const planA = await planFor(tree, 'dup')
    const planB = await planFor(tree, 'dup')
    const attempt = (plan: Awaited<ReturnType<typeof planFor>>, tag: string) =>
      writes.copy({
        requestId: randomUUID(),
        subject: `host:sandbox-recipes/copy-race-${tag}`,
        audit,
        drive: tree.drive,
        destinationParentId: tree.destinationId,
        plan: plan.plan,
        destination: plan.destination,
        deadlineAtMs: Date.now() + 30_000,
      })

    const results = await Promise.allSettled([attempt(planA, 'a'), attempt(planB, 'b')])
    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof writes.copy>>> =>
        r.status === 'fulfilled'
    )
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]!.reason).toMatchObject({ code: 'already_exists' })

    // Business truth: exactly ONE copied subtree root exists at the contended
    // destination name.
    const roots = await pool.query(
      `SELECT count(*)::integer AS n FROM gfs_resources WHERE drive=$1 AND path_cache='/archive/dup'`,
      [tree.drive]
    )
    expect(roots.rows[0]?.n).toBe(1)
  })
})
