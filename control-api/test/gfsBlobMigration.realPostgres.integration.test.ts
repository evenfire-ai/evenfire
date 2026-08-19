import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
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

describeRealPostgres('GFS immutable blob migration on real PostgreSQL', () => {
  const database = `gfs_blob_migration_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  let adminPool: Pool
  let pool: Pool

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
    pool = new Pool({ connectionString })
    const connector = { connect: () => pool.connect() }
    await initDb(connector)
    await initDb(connector)
  }, 60_000)

  afterAll(async () => {
    await pool?.end()
    if (!adminPool) return
    await adminPool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [database]
    )
    await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)}`)
    await adminPool.end()
  })

  it('applies 0068 exactly once with named constraints, indexes, and writer ACL', async () => {
    const versions = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM schema_migrations
        WHERE version = '0071_gfs_immutable_blob_generations'`
    )
    expect(versions.rows).toEqual([{ count: '1' }])

    const columns = await pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name,is_nullable FROM information_schema.columns
        WHERE table_schema='public' AND table_name='gfs_blob_manifests'
        ORDER BY ordinal_position`
    )
    expect(columns.rows.map(row => row.column_name)).toEqual([
      'blob_key',
      'request_id',
      'resource_id',
      'candidate_kind',
      'content_sha256',
      'bytes',
      'state',
      'created_at',
      'updated_at',
    ])
    expect(columns.rows.find(row => row.column_name === 'content_sha256')?.is_nullable).toBe('YES')

    const constraints = await pool.query<{ conname: string; definition: string }>(
      `SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid IN ('gfs_resources'::regclass,'gfs_blob_manifests'::regclass)
          AND conname IN ('gfs_resources_blob_metadata_pair','gfs_blob_manifests_blob_key_valid')
        ORDER BY conname`
    )
    expect(constraints.rows.map(row => row.conname)).toEqual([
      'gfs_blob_manifests_blob_key_valid',
      'gfs_resources_blob_metadata_pair',
    ])
    expect(constraints.rows.map(row => row.definition).join(' ')).toMatch(
      /generation.*legacy_flat.*content_sha256 IS NULL/s
    )

    const indexes = await pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public'
        AND indexname IN ('gfs_resources_blob_key_uniq','gfs_blob_manifests_cleanup_idx')
        ORDER BY indexname`
    )
    expect(indexes.rows.map(row => row.indexname)).toEqual([
      'gfs_blob_manifests_cleanup_idx',
      'gfs_resources_blob_key_uniq',
    ])
    expect(indexes.rows[0]?.indexdef).toContain('(state, updated_at, blob_key)')
    expect(indexes.rows[1]?.indexdef).toContain('WHERE (blob_key IS NOT NULL)')

    const acl = await pool.query<Record<string, boolean>>(`
      SELECT has_table_privilege('gfs_controller','gfs_resources','SELECT') AS resource_read,
             has_table_privilege('gfs_controller','gfs_resources','INSERT') AS resource_insert,
             has_table_privilege('gfs_controller','gfs_resources','UPDATE') AS resource_update,
             has_table_privilege('gfs_controller','gfs_resources','DELETE') AS resource_delete,
             has_table_privilege('gfs_controller','gfs_blob_manifests','SELECT') AS manifest_read,
             has_table_privilege('gfs_controller','gfs_blob_manifests','INSERT') AS manifest_insert,
             has_table_privilege('gfs_controller','gfs_blob_manifests','UPDATE') AS manifest_update,
             has_table_privilege('gfs_controller','gfs_blob_manifests','DELETE') AS manifest_delete`)
    expect(acl.rows[0]).toEqual({
      resource_read: true,
      resource_insert: true,
      resource_update: true,
      resource_delete: false,
      manifest_read: true,
      manifest_insert: true,
      manifest_update: true,
      manifest_delete: true,
    })
  })

  it('enforces generation ownership and permits only typed legacy cleanup candidates', async () => {
    const rootId = randomUUID()
    const resourceId = randomUUID()
    const drive = `blob-shape-${randomBytes(4).toString('hex')}`
    await pool.query(
      `INSERT INTO gfs_resources(resource_id,drive,parent_resource_id,name,kind,path_cache)
       VALUES ($1,$3,NULL,'','directory','/'),($2,$3,$1,'file.txt','file','/file.txt')`,
      [rootId, resourceId, drive]
    )
    const compactId = resourceId.replaceAll('-', '')
    const generationKey = `${compactId}/${randomUUID()}`
    await pool.query(
      `UPDATE gfs_resources SET blob_key=$2,content_sha256=$3 WHERE resource_id=$1`,
      [resourceId, generationKey, 'a'.repeat(64)]
    )
    await expect(
      pool.query(`UPDATE gfs_resources SET blob_key=$2,content_sha256=$3 WHERE resource_id=$1`, [
        resourceId,
        `${rootId.replaceAll('-', '')}/${randomUUID()}`,
        'a'.repeat(64),
      ])
    ).rejects.toMatchObject({ code: '23514' })
    await pool.query(
      `INSERT INTO gfs_blob_manifests
         (blob_key,request_id,resource_id,candidate_kind,content_sha256,bytes,state)
       VALUES ($1,$2,$3,'generation',$4,1,'staged'),
              ($5,$6,$3,'legacy_flat',NULL,1,'deleting')`,
      [generationKey, randomUUID(), resourceId, 'a'.repeat(64), compactId, randomUUID()]
    )
    await expect(
      pool.query(
        `INSERT INTO gfs_blob_manifests
         (blob_key,request_id,resource_id,candidate_kind,content_sha256,bytes,state)
       VALUES ($1,$2,$3,'legacy_flat',$4,1,'deleting')`,
        [rootId.replaceAll('-', ''), randomUUID(), rootId, 'b'.repeat(64)]
      )
    ).rejects.toMatchObject({ code: '23514' })
  })
})
