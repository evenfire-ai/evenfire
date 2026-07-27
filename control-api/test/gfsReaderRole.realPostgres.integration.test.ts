import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { CONTROL_API_MIGRATIONS, initDb } from '../src/db.js'
import { createPermissionStoreProbe } from '../../gfs-controller/src/authz/storeProbe.js'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

function databaseUrl(baseUrl: string, database: string, user?: string, password?: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  if (user !== undefined) url.username = user
  if (password !== undefined) url.password = password
  return url.toString()
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

describeRealPostgres('GFS reader and writer login isolation', () => {
  const database = `gfs_reader_role_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  const writerPassword = randomBytes(24).toString('hex')
  const readerPassword = randomBytes(24).toString('hex')
  const inheritedRole = `gfs_drift_${randomBytes(6).toString('hex')}`
  const writerUrl = databaseUrl(connectionString, database, 'gfs_controller', writerPassword)
  const readerUrl = databaseUrl(connectionString, database, 'gfs_controller_reader', readerPassword)
  let adminPool: Pool
  let pool: Pool
  let writerPool: Pool
  let readerPool: Pool

  const readiness = (runtimePool: Pool, dsn: string, storageRole: 'writer' | 'reader') =>
    createPermissionStoreProbe({
      pool: runtimePool,
      connectionString: dsn,
      intervalMs: 0,
      storageRole,
      connectTimeoutMs: 2_000,
    })

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
    pool = new Pool({ connectionString })
    await initDb({ connect: () => pool.connect() })

    // Match the production provisioning contract: the two runtime identities
    // authenticate directly with independent secrets. NOINHERIT prevents an
    // accidental membership from widening either direct-login envelope.
    await pool.query(`ALTER ROLE gfs_controller LOGIN NOINHERIT PASSWORD '${writerPassword}'`)
    await pool.query(`ALTER ROLE gfs_controller_reader LOGIN NOINHERIT PASSWORD '${readerPassword}'`)
    writerPool = new Pool({ connectionString: writerUrl })
    readerPool = new Pool({ connectionString: readerUrl })
  }, 60_000)

  afterAll(async () => {
    await readerPool?.end()
    await writerPool?.end()
    await pool?.query('ALTER ROLE gfs_controller NOLOGIN NOINHERIT').catch(() => undefined)
    await pool?.query('ALTER ROLE gfs_controller_reader NOLOGIN NOINHERIT').catch(() => undefined)
    await pool?.query(`DROP ROLE IF EXISTS ${quoteIdent(inheritedRole)}`).catch(() => undefined)
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

  it('authenticates distinct DSNs as the exact NOINHERIT runtime identities', async () => {
    expect(readerPassword).not.toBe(writerPassword)
    const [writerIdentity, readerIdentity, attributes] = await Promise.all([
      writerPool.query('SELECT current_user'),
      readerPool.query('SELECT current_user'),
      pool.query(
        `SELECT rolname, rolcanlogin, rolinherit
           FROM pg_roles
          WHERE rolname = ANY($1::text[])
          ORDER BY rolname`,
        [['gfs_controller', 'gfs_controller_reader']]
      ),
    ])
    expect(writerIdentity.rows[0]?.current_user).toBe('gfs_controller')
    expect(readerIdentity.rows[0]?.current_user).toBe('gfs_controller_reader')
    expect(attributes.rows).toEqual([
      { rolname: 'gfs_controller', rolcanlogin: true, rolinherit: false },
      { rolname: 'gfs_controller_reader', rolcanlogin: true, rolinherit: false },
    ])
  })

  it('repairs existing-role drift without changing LOGIN or passwords', async () => {
    await pool.query(`CREATE ROLE ${quoteIdent(inheritedRole)} NOLOGIN`)
    await pool.query(`GRANT ${quoteIdent(inheritedRole)} TO gfs_controller, gfs_controller_reader`)
    await pool.query('ALTER ROLE gfs_controller INHERIT')
    await pool.query('ALTER ROLE gfs_controller_reader INHERIT')
    await pool.query('GRANT DELETE ON gfs_resources TO gfs_controller')
    await pool.query('GRANT SELECT ON gfs_blob_manifests TO gfs_controller_reader')
    await pool.query('GRANT SELECT (email), UPDATE ON control_admin_users TO gfs_controller')
    await pool.query('GRANT SELECT (role), UPDATE ON team_members TO gfs_controller_reader')
    await pool.query('GRANT UPDATE ON SEQUENCE gfs_audit_sequence_no_seq TO gfs_controller_reader')

    const migration = CONTROL_API_MIGRATIONS.find(
      candidate => candidate.version === '0074_gfs_runtime_role_exact_contract'
    )
    expect(migration).toBeDefined()
    await migration!.apply(pool)

    const attributes = await pool.query(
      `SELECT rolname, rolcanlogin, rolinherit, rolsuper, rolcreatedb, rolcreaterole,
              rolreplication, rolbypassrls
         FROM pg_roles
        WHERE rolname = ANY($1::text[])
        ORDER BY rolname`,
      [['gfs_controller', 'gfs_controller_reader']]
    )
    expect(attributes.rows).toEqual([
      {
        rolname: 'gfs_controller',
        rolcanlogin: true,
        rolinherit: false,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        rolbypassrls: false,
      },
      {
        rolname: 'gfs_controller_reader',
        rolcanlogin: true,
        rolinherit: false,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        rolbypassrls: false,
      },
    ])
    const memberships = await pool.query(
      `SELECT member_role.rolname
         FROM pg_auth_members membership
         JOIN pg_roles member_role ON member_role.oid = membership.member
        WHERE member_role.rolname = ANY($1::text[])`,
      [['gfs_controller', 'gfs_controller_reader']]
    )
    expect(memberships.rows).toEqual([])

    const [freshWriter, freshReader] = [
      new Pool({ connectionString: writerUrl }),
      new Pool({ connectionString: readerUrl }),
    ]
    try {
      await expect(freshWriter.query('SELECT current_user')).resolves.toMatchObject({
        rows: [{ current_user: 'gfs_controller' }],
      })
      await expect(freshReader.query('SELECT current_user')).resolves.toMatchObject({
        rows: [{ current_user: 'gfs_controller_reader' }],
      })
    } finally {
      await Promise.all([freshWriter.end(), freshReader.end()])
    }
  })

  it('passes reader readiness without any manifest privilege and passes writer readiness with it', async () => {
    await expect(readerPool.query('SELECT 1 FROM gfs_blob_manifests')).rejects.toMatchObject({ code: '42501' })
    await expect(readiness(readerPool, readerUrl, 'reader')()).resolves.toBeUndefined()
    await expect(readiness(writerPool, writerUrl, 'writer')()).resolves.toBeUndefined()
  })

  it.each([
    ['SELECT on resources', 'REVOKE SELECT ON gfs_resources FROM gfs_controller_reader', 'GRANT SELECT ON gfs_resources TO gfs_controller_reader'],
    ['INSERT on audit', 'REVOKE INSERT ON gfs_audit FROM gfs_controller_reader', 'GRANT INSERT ON gfs_audit TO gfs_controller_reader'],
  ])('fails reader readiness after revoking %s', async (_label, revokeSql, restoreSql) => {
    await pool.query(revokeSql)
    try {
      await expect(readiness(readerPool, readerUrl, 'reader')()).rejects.toThrow(
        /coherence check failed|permission denied/i
      )
    } finally {
      await pool.query(restoreSql)
    }
  })

  it('cannot mutate metadata, inherit the writer, or read manifests', async () => {
    const membership = await pool.query(
      `SELECT pg_has_role('gfs_controller_reader', 'gfs_controller', 'MEMBER') AS member`
    )
    expect(membership.rows[0]?.member).toBe(false)

    const privileges = await readerPool.query(`
      SELECT
        has_table_privilege(current_user, 'gfs_resources', 'SELECT') AS can_read_resources,
        has_table_privilege(current_user, 'gfs_audit', 'INSERT') AS can_insert_audit,
        has_table_privilege(current_user, 'gfs_resources', 'INSERT') AS can_insert_resources,
        has_table_privilege(current_user, 'gfs_resources', 'UPDATE') AS can_update_resources,
        has_table_privilege(current_user, 'gfs_grants', 'INSERT') AS can_insert_grants,
        has_table_privilege(current_user, 'gfs_shares', 'INSERT') AS can_insert_shares,
        has_table_privilege(current_user, 'gfs_blob_manifests', 'SELECT') AS can_read_manifests
    `)
    expect(privileges.rows[0]).toEqual({
      can_read_resources: true,
      can_insert_audit: true,
      can_insert_resources: false,
      can_update_resources: false,
      can_insert_grants: false,
      can_insert_shares: false,
      can_read_manifests: false,
    })
    await expect(
      readerPool.query('UPDATE gfs_resources SET bytes = bytes WHERE false')
    ).rejects.toMatchObject({ code: '42501' })
  })

  it.each([
    ['writer', () => writerPool],
    ['reader', () => readerPool],
  ] as const)('%s has only the approved subject-table columns', async (_kind, runtimePool) => {
    await expect(
      runtimePool().query('SELECT id, status FROM control_admin_users WHERE false')
    ).resolves.toMatchObject({ rowCount: 0 })
    await expect(
      runtimePool().query('SELECT team_id, user_id, status FROM team_members WHERE false')
    ).resolves.toMatchObject({ rowCount: 0 })
    await expect(
      runtimePool().query('SELECT email FROM control_admin_users WHERE false')
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      runtimePool().query('SELECT role FROM team_members WHERE false')
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      runtimePool().query('UPDATE control_admin_users SET status = status WHERE false')
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      runtimePool().query('DELETE FROM team_members WHERE false')
    ).rejects.toMatchObject({ code: '42501' })
  })

  it('preserves required writer mutation privileges but denies hard deletion', async () => {
    await expect(
      writerPool.query('UPDATE gfs_resources SET bytes = bytes WHERE false')
    ).resolves.toMatchObject({ rowCount: 0 })
    await expect(
      writerPool.query('DELETE FROM gfs_resources WHERE false')
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      writerPool.query('UPDATE gfs_blob_manifests SET updated_at = updated_at WHERE false')
    ).resolves.toMatchObject({ rowCount: 0 })
  })
})
