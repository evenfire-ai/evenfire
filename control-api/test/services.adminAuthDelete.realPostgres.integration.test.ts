import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { initDb, pool } from '../src/db.js'
import { deleteControlAdmin } from '../src/services/adminAuthService.js'

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

describeRealPostgres('deleteControlAdmin on real PostgreSQL', () => {
  const database = `admin_auth_delete_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  let adminPool: Pool
  let testPool: Pool
  let connectSpy: ReturnType<typeof vi.spyOn>
  let querySpy: ReturnType<typeof vi.spyOn>

  async function seedAdmin(label: string): Promise<{ id: string; username: string }> {
    const id = randomUUID()
    const username = `${label}-${id.slice(0, 8)}`
    await testPool.query(
      `INSERT INTO control_admin_users (id, username, email, password_hash, role, status, session_version)
       VALUES ($1, $2, $3, 'real-pg-admin-delete-test', 'admin', 'active', 1)`,
      [id, username, `${username}@example.test`]
    )
    return { id, username }
  }

  async function seedOperatorLink(controlAdminId: string): Promise<string> {
    const userId = randomUUID()
    await testPool.query(`INSERT INTO users (id, email, name) VALUES ($1, $2, $3)`, [
      userId,
      `${controlAdminId}@example.test`,
      'operator-linked-desktop-user',
    ])
    await testPool.query(
      `INSERT INTO gfs_desktop_operator_links
         (id, lineage_id, generation, user_id, control_admin_id, state, source, created_by, row_version)
       VALUES (gen_random_uuid(), gen_random_uuid(), 1, $1::uuid, $2::uuid,
               'active', 'initial_setup', $2::uuid, 1)`,
      [userId, controlAdminId]
    )
    return userId
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
    testPool = new Pool({ connectionString })
    await initDb({ connect: () => testPool.connect() })
    connectSpy = vi
      .spyOn(pool, 'connect')
      .mockImplementation((() => testPool.connect()) as typeof pool.connect)
    querySpy = vi
      .spyOn(pool, 'query')
      .mockImplementation(((text: string, values?: unknown[]) =>
        testPool.query(text, values)) as unknown as typeof pool.query)
  }, 60_000)

  afterAll(async () => {
    querySpy?.mockRestore()
    connectSpy?.mockRestore()
    await testPool?.end()
    if (!adminPool) return
    await adminPool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [database]
    )
    await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)}`)
    await adminPool.end()
  })

  // Regression for the plain DELETE /admin/control-admins/:id path (replaceInviter
  // not involved): deleting a control admin who has real gfs_desktop_operator_links
  // history used to throw UnsafeTracingInputError because the parent-retired
  // permission event embedded the target admin id in the 'operator' principal ref,
  // which append.ts's canonical-prefix check and the administrative_events CHECK
  // constraint both reject (they require the literal 'operator:').
  it('retires a control admin with operator-link history and appends its permission-revoke event', async () => {
    const actor = await seedAdmin('delete-actor')
    const target = await seedAdmin('delete-target')
    await seedOperatorLink(target.id)

    await expect(deleteControlAdmin(actor.id, target.id)).resolves.toEqual({ deleted: true })

    const admin = await testPool.query(
      `SELECT status, session_version FROM control_admin_users WHERE id = $1::uuid`,
      [target.id]
    )
    expect(admin.rows).toEqual([{ status: 'disabled', session_version: 2 }])

    const link = await testPool.query(
      `SELECT state FROM gfs_desktop_operator_links WHERE control_admin_id = $1::uuid`,
      [target.id]
    )
    expect(link.rows).toEqual([{ state: 'revoked' }])

    const audit = await testPool.query(
      `SELECT actor_admin_id::text AS actor, target_admin_id::text AS target
         FROM control_admin_deletion_audit WHERE target_admin_id = $1::uuid`,
      [target.id]
    )
    expect(audit.rows).toEqual([{ actor: actor.id, target: target.id }])

    const permissionEvent = await testPool.query(
      `SELECT action,
              payload_metadata->>'target_principal_kind' AS target_principal_kind,
              payload_metadata->>'target_principal_ref' AS target_principal_ref
         FROM administrative_events
        WHERE target_ref = $1
          AND action = 'permission_revoke'
        ORDER BY ingest_sequence ASC`,
      [`control_admin:${target.id}`]
    )
    expect(permissionEvent.rows).toEqual([
      {
        action: 'permission_revoke',
        target_principal_kind: 'operator',
        target_principal_ref: 'operator:',
      },
    ])
  })
})
