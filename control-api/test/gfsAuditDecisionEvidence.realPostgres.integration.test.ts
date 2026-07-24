import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { CONTROL_API_MIGRATIONS, initDb } from '../src/db.js'

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

async function asRole<T>(pool: Pool, role: string, run: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`SET LOCAL ROLE ${quoteIdent(role)}`)
    const result = await run(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

describeRealPostgres('GFS typed audit decision evidence', () => {
  const database = `gfs_audit_evidence_${randomBytes(6).toString('hex')}`
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
    await initDb({ connect: () => pool.connect() })
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

  it('is additive, idempotent, and constrains the evidence vocabulary', async () => {
    const migration = CONTROL_API_MIGRATIONS.find(
      candidate => candidate.version === '0073_gfs_audit_decision_evidence'
    )
    expect(migration).toBeDefined()
    await migration!.apply(pool)

    const columns = await pool.query(
      `SELECT column_name, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'gfs_audit'
          AND column_name = ANY($1::text[])
        ORDER BY column_name`,
      [
        [
          'record_type',
          'matched_subject',
          'authorization_source',
          'cached_authorization_source',
          'mutation_outcome',
        ],
      ]
    )
    expect(columns.rows).toHaveLength(5)
    expect(columns.rows.find(row => row.column_name === 'record_type')).toMatchObject({
      is_nullable: 'NO',
      column_default: "'legacy'::text",
    })

    const constraints = await pool.query(
      `SELECT conname
         FROM pg_constraint
        WHERE conrelid = 'gfs_audit'::regclass
          AND conname LIKE 'gfs_audit_%_valid'`
    )
    expect(new Set(constraints.rows.map(row => row.conname))).toEqual(
      new Set([
        'gfs_audit_record_type_valid',
        'gfs_audit_authorization_source_valid',
        'gfs_audit_cached_authorization_source_valid',
        'gfs_audit_mutation_outcome_valid',
        'gfs_audit_record_type_fields_valid',
      ])
    )

    await pool.query(
      `INSERT INTO gfs_audit (subject, op, outcome, row_hash)
       VALUES ('host:legacy', 'read', 'allow', 'legacy-hash')`
    )
    const legacy = await pool.query(
      `SELECT record_type, matched_subject, authorization_source,
              cached_authorization_source, mutation_outcome
         FROM gfs_audit WHERE row_hash = 'legacy-hash'`
    )
    expect(legacy.rows[0]).toEqual({
      record_type: 'legacy',
      matched_subject: null,
      authorization_source: null,
      cached_authorization_source: null,
      mutation_outcome: null,
    })

    await expect(
      pool.query(
        `INSERT INTO gfs_audit
          (subject, op, outcome, row_hash, record_type, authorization_source)
         VALUES ('host:bad', 'read', 'allow', 'bad-source',
                 'authorization_decision', 'standalone')`
      )
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      pool.query(
        `INSERT INTO gfs_audit
          (subject, op, outcome, row_hash, record_type, authorization_source)
         VALUES ('host:bad', 'read', 'allow', 'cache-without-source',
                 'authorization_decision', 'cache')`
      )
    ).rejects.toMatchObject({ code: '23514' })
  })

  it.each(['gfs_controller', 'gfs_controller_reader'])(
    '%s can append typed evidence but cannot update or delete it',
    async role => {
      const rowHash = `${role}-decision-${randomBytes(4).toString('hex')}`
      await asRole(pool, role, client =>
        client.query(
          `INSERT INTO gfs_audit
            (subject, op, outcome, row_hash, record_type, matched_subject,
             authorization_source, cached_authorization_source)
           VALUES ('host:actor', 'read', 'allow', $1, 'authorization_decision',
                   'host:actor', 'cache', 'direct_grant')`,
          [rowHash]
        )
      )

      await expect(
        asRole(pool, role, client =>
          client.query(`UPDATE gfs_audit SET outcome = 'deny' WHERE false`)
        )
      ).rejects.toMatchObject({ code: '42501' })
      await expect(
        asRole(pool, role, client => client.query(`DELETE FROM gfs_audit WHERE false`))
      ).rejects.toMatchObject({ code: '42501' })
    }
  )

  it('records actual mutation outcome separately from the authorization decision', async () => {
    await asRole(pool, 'gfs_controller', client =>
      client.query(
        `INSERT INTO gfs_audit
          (subject, op, outcome, row_hash, record_type, matched_subject,
           authorization_source, mutation_outcome)
         VALUES ('host:actor', 'copy', 'error', 'mutation-failed', 'mutation_outcome',
                 'host:actor', 'direct_grant', 'failed')`
      )
    )
    await expect(
      pool.query(
        `INSERT INTO gfs_audit
          (subject, op, outcome, row_hash, record_type, mutation_outcome)
         VALUES ('host:bad', 'copy', 'allow', 'decision-with-mutation',
                 'authorization_decision', 'succeeded')`
      )
    ).rejects.toMatchObject({ code: '23514' })
  })
})
