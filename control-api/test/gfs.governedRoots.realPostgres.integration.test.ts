import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { initDb } from '../src/db.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function databaseUrl(base: string, database: string, user?: string, password?: string): string {
  const url = new URL(base)
  url.pathname = `/${database}`
  if (user !== undefined) url.username = user
  if (password !== undefined) url.password = password
  return url.toString()
}

type Tree = {
  drive: string
  userId: string
  rootId: string
  usersId: string
  homeId: string
  otherId: string
  fileId: string
}

describeRealPostgres('GFS governed roots on real PostgreSQL', () => {
  const suffix = randomBytes(6).toString('hex')
  const database = `gfs_homes_${suffix}`
  const runtimeLogin = `gfs_homes_runtime_${suffix}`
  const insertLogin = `gfs_homes_insert_${suffix}`
  const runtimePassword = randomBytes(24).toString('hex')
  const insertPassword = randomBytes(24).toString('hex')
  const createdRoles: string[] = []
  let databaseCreated = false
  let adminPool: Pool
  let pool: Pool
  let runtimePool: Pool
  let insertPool: Pool
  let runtime: PoolClient

  beforeAll(async () => {
    if (!adminUrl) throw new Error('CONTROL_API_REAL_PG_ADMIN_URL is required')
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
    databaseCreated = true
    const connectionString = databaseUrl(adminUrl, database)
    pool = new Pool({ connectionString })
    await initDb({ connect: () => pool.connect() })

    await pool.query(
      `CREATE ROLE ${quoteIdent(runtimeLogin)} LOGIN NOINHERIT PASSWORD '${runtimePassword}'`
    )
    createdRoles.push(runtimeLogin)
    await pool.query(`GRANT control_api_runtime TO ${quoteIdent(runtimeLogin)}`)
    await pool.query(
      `CREATE ROLE ${quoteIdent(insertLogin)} LOGIN NOINHERIT PASSWORD '${insertPassword}'`
    )
    createdRoles.push(insertLogin)
    await pool.query(`GRANT USAGE ON SCHEMA public TO ${quoteIdent(insertLogin)}`)
    await pool.query(`GRANT INSERT ON TABLE public.users TO ${quoteIdent(insertLogin)}`)
    // The pre-existing invoker-rights trigger password_credential_generation_fence
    // (services/auth/passwordAdmissionSchema.ts) updates password_identifier_state on
    // every users INSERT, so the inserting role needs exactly that. It still gets no
    // privilege on gfs_user_homes or the enrollment function.
    await pool.query(
      `GRANT SELECT, UPDATE ON TABLE public.password_identifier_state TO ${quoteIdent(insertLogin)}`
    )

    runtimePool = new Pool({
      connectionString: databaseUrl(adminUrl, database, runtimeLogin, runtimePassword),
    })
    insertPool = new Pool({
      connectionString: databaseUrl(adminUrl, database, insertLogin, insertPassword),
    })
    runtime = await runtimePool.connect()
    await runtime.query('SET ROLE control_api_runtime')
    const identity = await runtime.query('SELECT current_user, session_user')
    expect(identity.rows[0]).toEqual({
      current_user: 'control_api_runtime',
      session_user: runtimeLogin,
    })
  }, 60_000)

  afterAll(async () => {
    try {
      runtime?.release()
      await endPoolAndWaitForClients(runtimePool)
      await endPoolAndWaitForClients(insertPool)
      await endPoolAndWaitForClients(pool)
      if (!adminPool) return
      if (databaseCreated) {
        await adminPool.query(
          'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
          [database]
        )
        await adminPool.query(`DROP DATABASE ${quoteIdent(database)}`)
      }
      for (const role of createdRoles) await adminPool.query(`DROP ROLE ${quoteIdent(role)}`)
    } finally {
      await adminPool?.end()
    }
  }, 60_000)

  async function seedTree(options: { empty?: boolean; revoked?: boolean } = {}): Promise<Tree> {
    const tree: Tree = {
      drive: `homes-${randomUUID()}`,
      userId: randomUUID(),
      rootId: randomUUID(),
      usersId: randomUUID(),
      homeId: randomUUID(),
      otherId: randomUUID(),
      fileId: randomUUID(),
    }
    await pool.query('INSERT INTO users (id, email) VALUES ($1, $2)', [
      tree.userId,
      `${tree.userId}@example.test`,
    ])
    await pool.query(
      `INSERT INTO gfs_resources (resource_id, drive, parent_resource_id, name, kind, path_cache)
       VALUES ($1, $5, NULL, '', 'directory', '/'),
              ($2, $5, $1, 'Users', 'directory', '/Users'),
              ($3, $5, $2, 'owner', 'directory', '/Users/owner'),
              ($4, $5, $1, 'other', 'directory', '/other')`,
      [tree.rootId, tree.usersId, tree.homeId, tree.otherId, tree.drive]
    )
    await pool.query(
      `UPDATE gfs_user_homes SET drive = $2, storage_username = 'owner', resource_id = $3, state = 'ready'
       WHERE user_id = $1`,
      [tree.userId, tree.drive, tree.homeId]
    )
    await pool.query(
      `INSERT INTO gfs_grants (drive, resource_id, subject_type, subject_id, permissions, inherit)
       VALUES ($1, $2, 'user', $3, ARRAY['read','write','delete','share','manage_acl'], true)`,
      [tree.drive, tree.homeId, tree.userId]
    )
    if (options.revoked) {
      const revoked = await pool.query('DELETE FROM gfs_grants WHERE resource_id = $1', [
        tree.homeId,
      ])
      expect(revoked.rowCount).toBe(1)
    }
    if (!options.empty) await insertFile(pool, tree)
    return tree
  }

  async function insertFile(client: Pool | PoolClient, tree: Tree): Promise<void> {
    const result = await client.query(
      `INSERT INTO gfs_resources (resource_id, drive, parent_resource_id, name, kind, path_cache)
       VALUES ($1, $2, $3, 'file.txt', 'file', '/Users/owner/file.txt')`,
      [tree.fileId, tree.drive, tree.homeId]
    )
    expect(result.rowCount).toBe(1)
  }

  const targets: Array<{
    label: string
    field: 'usersId' | 'homeId'
    options: { empty?: boolean; revoked?: boolean }
  }> = [
    { label: '/Users', field: 'usersId' as const, options: {} },
    { label: 'bound home with owner grant', field: 'homeId' as const, options: {} },
    { label: 'empty bound home', field: 'homeId' as const, options: { empty: true } },
    {
      label: 'bound home with revoked owner grant',
      field: 'homeId' as const,
      options: { revoked: true },
    },
  ]
  const mutations: Array<{ label: string; sql: string; value?: (tree: Tree) => string }> = [
    {
      label: 'rename',
      sql: 'UPDATE gfs_resources SET name = $2 WHERE resource_id = $1',
      value: (_tree: Tree) => 'renamed',
    },
    {
      label: 'move',
      sql: 'UPDATE gfs_resources SET parent_resource_id = $2 WHERE resource_id = $1',
      value: (tree: Tree) => tree.otherId,
    },
    {
      label: 'soft-delete',
      sql: 'UPDATE gfs_resources SET deleted_at = now() WHERE resource_id = $1',
    },
    { label: 'delete', sql: 'DELETE FROM gfs_resources WHERE resource_id = $1' },
  ]

  for (const target of targets) {
    for (const mutation of mutations) {
      it(`rejects ${mutation.label} of ${target.label} while a descendant can be changed`, async () => {
        const tree = await seedTree(target.options)
        const targetId = tree[target.field]
        if (target.options.empty) {
          const children = await pool.query(
            'SELECT resource_id FROM gfs_resources WHERE parent_resource_id = $1',
            [tree.homeId]
          )
          expect(children.rowCount).toBe(0)
        }
        const before = await runtime.query(
          'SELECT parent_resource_id, name, deleted_at FROM gfs_resources WHERE resource_id = $1',
          [targetId]
        )
        expect(before.rowCount).toBe(1)
        const values = mutation.value ? [targetId, mutation.value(tree)] : [targetId]
        await expect(runtime.query(mutation.sql, values)).rejects.toMatchObject({
          code: '23514',
          constraint: 'gfs_governed_root_immutable',
        })
        const after = await runtime.query(
          'SELECT parent_resource_id, name, deleted_at FROM gfs_resources WHERE resource_id = $1',
          [targetId]
        )
        expect(after.rows).toEqual(before.rows)

        if (target.options.empty) await insertFile(runtime, tree)
        const renamed = await runtime.query(
          "UPDATE gfs_resources SET name = 'renamed.txt' WHERE resource_id = $1 RETURNING name",
          [tree.fileId]
        )
        expect(renamed.rows).toEqual([{ name: 'renamed.txt' }])
        const deleted = await runtime.query('DELETE FROM gfs_resources WHERE resource_id = $1', [
          tree.fileId,
        ])
        expect(deleted.rowCount).toBe(1)
      })
    }
  }

  it.each(['usersId', 'homeId'] as const)(
    'allows non-structural metadata changes on %s',
    async field => {
      const tree = await seedTree()
      const result = await runtime.query(
        `UPDATE gfs_resources
            SET version = version + 1, bytes = bytes + 1, path_cache = path_cache || '-metadata', updated_at = now()
          WHERE resource_id = $1 RETURNING version, bytes, path_cache`,
        [tree[field]]
      )
      expect(result.rows).toEqual([
        {
          version: 1,
          bytes: '1',
          path_cache: field === 'usersId' ? '/Users-metadata' : '/Users/owner-metadata',
        },
      ])
    }
  )

  it('enrolls a user inserted by a role that cannot read homes or execute the trigger function', async () => {
    const identity = await insertPool.query('SELECT current_user')
    expect(identity.rows[0]?.current_user).toBe(insertLogin)
    const privileges = await insertPool.query(`
      SELECT has_table_privilege(current_user, 'public.users', 'INSERT') AS insert_users,
             has_table_privilege(current_user, 'public.users', 'SELECT') AS select_users,
             has_table_privilege(current_user, 'public.users', 'UPDATE') AS update_users,
             has_table_privilege(current_user, 'public.users', 'DELETE') AS delete_users,
             has_table_privilege(current_user, 'public.gfs_user_homes', 'SELECT') AS select_homes,
             has_table_privilege(current_user, 'public.gfs_user_homes', 'INSERT') AS insert_homes,
             has_table_privilege(current_user, 'public.gfs_user_homes', 'UPDATE') AS update_homes,
             has_table_privilege(current_user, 'public.gfs_user_homes', 'DELETE') AS delete_homes,
             has_function_privilege(current_user, 'public.gfs_user_home_enroll()', 'EXECUTE') AS execute_enroll
    `)
    expect(privileges.rows[0]).toEqual({
      insert_users: true,
      select_users: false,
      update_users: false,
      delete_users: false,
      select_homes: false,
      insert_homes: false,
      update_homes: false,
      delete_homes: false,
      execute_enroll: false,
    })
    const userId = randomUUID()
    const inserted = await insertPool.query('INSERT INTO users (id, email) VALUES ($1, $2)', [
      userId,
      `${userId}@example.test`,
    ])
    expect(inserted.rowCount).toBe(1)
    await expect(
      insertPool.query('SELECT user_id FROM gfs_user_homes WHERE user_id = $1', [userId])
    ).rejects.toMatchObject({ code: '42501' })
    const homes = await pool.query(
      'SELECT user_id, state, drive, resource_id FROM gfs_user_homes WHERE user_id = $1',
      [userId]
    )
    expect(homes.rows).toEqual([
      { user_id: userId, state: 'pending', drive: null, resource_id: null },
    ])

    const functions = await pool.query(`
      SELECT proname, prosecdef, proconfig
        FROM pg_proc JOIN pg_namespace n ON n.oid = pronamespace
       WHERE n.nspname = 'public'
         AND proname IN ('gfs_user_home_enroll', 'gfs_governed_root_guard')
       ORDER BY proname
    `)
    expect(functions.rows).toEqual([
      {
        proname: 'gfs_governed_root_guard',
        prosecdef: true,
        proconfig: ['search_path=pg_catalog, pg_temp'],
      },
      {
        proname: 'gfs_user_home_enroll',
        prosecdef: true,
        proconfig: ['search_path=pg_catalog, pg_temp'],
      },
    ])
  })

  it('grants the runtime role only the home upsert privileges', async () => {
    const tree = await seedTree()
    const privileges = await runtime.query(`
      SELECT has_table_privilege(current_user, 'public.gfs_user_homes', 'SELECT') AS can_select,
             has_table_privilege(current_user, 'public.gfs_user_homes', 'INSERT') AS can_insert,
             has_table_privilege(current_user, 'public.gfs_user_homes', 'UPDATE') AS can_update,
             has_table_privilege(current_user, 'public.gfs_user_homes', 'DELETE') AS can_delete,
             has_table_privilege(current_user, 'public.gfs_user_homes', 'TRUNCATE') AS can_truncate,
             has_table_privilege(current_user, 'public.gfs_user_homes', 'REFERENCES') AS can_reference,
             has_table_privilege(current_user, 'public.gfs_user_homes', 'TRIGGER') AS can_trigger,
             has_function_privilege(current_user, 'public.gfs_governed_root_guard()', 'EXECUTE') AS execute_guard
    `)
    expect(privileges.rows[0]).toEqual({
      can_select: true,
      can_insert: true,
      can_update: true,
      can_delete: false,
      can_truncate: false,
      can_reference: false,
      can_trigger: false,
      execute_guard: false,
    })
    const updated = await runtime.query(
      'UPDATE gfs_user_homes SET attempts = attempts + 1 WHERE user_id = $1 RETURNING attempts',
      [tree.userId]
    )
    expect(updated.rows).toEqual([{ attempts: 1 }])
    await expect(
      runtime.query('DELETE FROM gfs_user_homes WHERE user_id = $1', [tree.userId])
    ).rejects.toMatchObject({ code: '42501' })
  })

  it('keeps a pending home tombstone after its user is hard-deleted', async () => {
    const userId = randomUUID()
    await runtime.query('INSERT INTO users (id, email) VALUES ($1, $2)', [
      userId,
      `${userId}@example.test`,
    ])
    const before = await runtime.query('SELECT state FROM gfs_user_homes WHERE user_id = $1', [
      userId,
    ])
    expect(before.rows).toEqual([{ state: 'pending' }])
    const removed = await runtime.query('DELETE FROM users WHERE id = $1', [userId])
    expect(removed.rowCount).toBe(1)
    const after = await runtime.query('SELECT state FROM gfs_user_homes WHERE user_id = $1', [
      userId,
    ])
    expect(after.rows).toEqual([{ state: 'pending' }])
  })

  it('enforces home state shapes while allowing retirement with no drive', async () => {
    const userId = randomUUID()
    await runtime.query('INSERT INTO users (id, email) VALUES ($1, $2)', [
      userId,
      `${userId}@example.test`,
    ])
    await expect(
      runtime.query("UPDATE gfs_user_homes SET state = 'ready' WHERE user_id = $1", [userId])
    ).rejects.toMatchObject({ code: '23514' })
    const retired = await runtime.query(
      "UPDATE gfs_user_homes SET state = 'retired' WHERE user_id = $1 RETURNING state, drive",
      [userId]
    )
    expect(retired.rows).toEqual([{ state: 'retired', drive: null }])
    const drive = `homes-${randomUUID()}`
    await expect(
      runtime.query("UPDATE gfs_user_homes SET state = 'conflict', drive = $2 WHERE user_id = $1", [
        userId,
        drive,
      ])
    ).rejects.toMatchObject({ code: '23514', constraint: 'gfs_user_homes_conflict_shape' })
    const conflict = await runtime.query(
      "UPDATE gfs_user_homes SET state = 'conflict', drive = $2, conflict_code = 'path_conflict' WHERE user_id = $1 RETURNING state, conflict_code",
      [userId, drive]
    )
    expect(conflict.rows).toEqual([{ state: 'conflict', conflict_code: 'path_conflict' }])
  })

  it('enforces case-insensitive name reservations per drive', async () => {
    const first = randomUUID()
    const second = randomUUID()
    const drive = `homes-${randomUUID()}`
    await runtime.query('INSERT INTO users (id, email) VALUES ($1, $2), ($3, $4)', [
      first,
      `${first}@example.test`,
      second,
      `${second}@example.test`,
    ])
    const reserved = await runtime.query(
      "UPDATE gfs_user_homes SET drive = $2, storage_username = 'Owner' WHERE user_id = $1",
      [first, drive]
    )
    expect(reserved.rowCount).toBe(1)
    await expect(
      runtime.query(
        "UPDATE gfs_user_homes SET drive = $2, storage_username = 'owner' WHERE user_id = $1",
        [second, drive]
      )
    ).rejects.toMatchObject({ code: '23505', constraint: 'gfs_user_homes_name_uniq' })
    const otherDrive = await runtime.query(
      "UPDATE gfs_user_homes SET drive = $2, storage_username = 'owner' WHERE user_id = $1",
      [second, `${drive}-other`]
    )
    expect(otherDrive.rowCount).toBe(1)
  })
})
