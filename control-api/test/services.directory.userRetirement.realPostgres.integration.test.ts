import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { initDb, pool } from '../src/db.js'
import { retireDesktopUser } from '../src/services/directory/users.js'

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

describeRealPostgres('retireDesktopUser on real PostgreSQL', () => {
  const database = `desktop_user_retirement_${randomBytes(6).toString('hex')}`
  const actorId = randomUUID()
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  let adminPool: Pool
  let testPool: Pool
  let corePoolConnectSpy: ReturnType<typeof vi.spyOn>

  async function seedDesktopUser(label: string): Promise<string> {
    const id = randomUUID()
    await testPool.query(`INSERT INTO users (id, email, name) VALUES ($1, $2, $3)`, [
      id,
      `${label}-${id}@example.test`,
      label,
    ])
    return id
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
    testPool = new Pool({ connectionString })
    await initDb({ connect: () => testPool.connect() })
    corePoolConnectSpy = vi
      .spyOn(pool, 'connect')
      .mockImplementation((() => testPool.connect()) as typeof pool.connect)
    await testPool.query(
      `INSERT INTO control_admin_users (id, username, password_hash, role, status)
       VALUES ($1, $2, 'real-pg-retirement-test', 'admin', 'active')`,
      [actorId, `retirement-actor-${actorId}`]
    )
  }, 60_000)

  afterAll(async () => {
    corePoolConnectSpy?.mockRestore()
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

  it('persists the legacy deleted outcome and returns it on an identical replay', async () => {
    const userId = await seedDesktopUser('deleted-user')
    const input = [
      { kind: 'control_admin' as const, controlAdminId: actorId },
      userId,
      'no operator-link history',
      'real-pg-delete-replay-v1',
      'retirement-delete-request-v1',
    ] as const

    const first = await retireDesktopUser(...input)
    const replay = await retireDesktopUser(...input)

    expect(first).toMatchObject({
      id: userId,
      outcome: 'deleted',
      lifecycleVersion: null,
      replayed: false,
    })
    expect(replay).toEqual({ ...first, replayed: true })
    const [user, operation] = await Promise.all([
      testPool.query(`SELECT id FROM users WHERE id = $1::uuid`, [userId]),
      testPool.query(
        `SELECT status, outcome, lifecycle_version
           FROM desktop_user_retirement_operations
          WHERE id = $1::uuid`,
        [first.operationId]
      ),
    ])
    expect(user.rowCount).toBe(0)
    expect(operation.rows).toEqual([
      { status: 'completed', outcome: 'deleted', lifecycle_version: null },
    ])
  })

  it('persists a retained linked user as retired and revokes its active generation', async () => {
    const userId = await seedDesktopUser('linked-user')
    await testPool.query(
      `INSERT INTO gfs_desktop_operator_links
         (id, lineage_id, generation, user_id, control_admin_id, state, source, created_by, row_version)
       VALUES (gen_random_uuid(), gen_random_uuid(), 1, $1::uuid, $2::uuid,
               'active', 'initial_setup', $2::uuid, 1)`,
      [userId, actorId]
    )

    const result = await retireDesktopUser(
      { kind: 'control_admin', controlAdminId: actorId },
      userId,
      'operator access revoked with account retirement',
      'real-pg-retire-v1',
      'retirement-retire-request-v1'
    )

    expect(result).toMatchObject({
      id: userId,
      outcome: 'retired',
      lifecycleVersion: 2,
      replayed: false,
    })
    const [user, link, operation] = await Promise.all([
      testPool.query(
        `SELECT lifecycle_state, lifecycle_version, retirement_reason,
                retired_by_type, retired_by_control_admin_id::text AS retired_by_control_admin_id,
                retirement_operation_id::text AS retirement_operation_id
           FROM users WHERE id = $1::uuid`,
        [userId]
      ),
      testPool.query(
        `SELECT state, row_version, revoked_by_type,
                revoked_by_control_admin_id::text AS revoked_by_control_admin_id,
                revocation_reason
           FROM gfs_desktop_operator_links WHERE user_id = $1::uuid`,
        [userId]
      ),
      testPool.query(
        `SELECT status, outcome, lifecycle_version, lifecycle_operation_id::text AS lifecycle_operation_id
           FROM desktop_user_retirement_operations WHERE id = $1::uuid`,
        [result.operationId]
      ),
    ])
    expect(user.rows).toEqual([
      {
        lifecycle_state: 'retired',
        lifecycle_version: '2',
        retirement_reason: 'operator access revoked with account retirement',
        retired_by_type: 'control_admin',
        retired_by_control_admin_id: actorId,
        retirement_operation_id: result.operationId,
      },
    ])
    expect(link.rows).toEqual([
      {
        state: 'revoked',
        row_version: '2',
        revoked_by_type: 'control_admin',
        revoked_by_control_admin_id: actorId,
        revocation_reason: 'operator access revoked with account retirement',
      },
    ])
    expect(operation.rows).toEqual([
      {
        status: 'completed',
        outcome: 'retired',
        lifecycle_version: '2',
        lifecycle_operation_id: result.operationId,
      },
    ])
  })
})
