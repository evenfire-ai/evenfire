import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Client, Pool, type PoolClient } from 'pg'
import type { AuthzKey, SessionHint } from '../src/services/gfsWatch/notifySchemas.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'
import './realPostgres.requirement.ts'

// Every payload asserted here is emitted by the triggers the real migrations
// install, in response to a committed write. The expected key of each write is
// computed from the stored row with SQL, independently of the TypeScript
// parsers, and every received payload must parse (I47).
//
// Writes run as control_api_runtime, the role control-api's writers use, so a
// function the trigger body calls without EXECUTE for that role would abort
// them here. The user retirement and hard delete go through the real
// retireDesktopUser writer.

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

const AUTHZ = 'gfs_authz_changed'
const SESSION = 'gfs_watch_session'
const FENCE_CHANNEL = 'gfs_watch_test_fence'
const RUNTIME_ROLE = 'control_api_runtime'
const WATCH_TRIGGER_MIGRATIONS = [
  '0140_gfs_authz_grants_notify',
  '0141_gfs_authz_shares_notify',
  '0142_gfs_authz_operator_links_notify',
  '0143_gfs_authz_control_admins_notify',
  '0144_gfs_authz_team_members_notify',
  '0145_gfs_watch_session_users_notify',
] as const
const USERS_MIGRATION = '0145_gfs_watch_session_users_notify'

const TRIGGER_FUNCTIONS = [
  'gfs_authz_admin_notify',
  'gfs_authz_subject_notify',
  'gfs_authz_user_notify',
  'gfs_watch_session_notify',
] as const

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

type Received = { authz: string[]; session: string[] }

describeRealPostgres('GFS watch authorization and session triggers against real writes', () => {
  const database = `control_api_gfs_watch_authz_${randomBytes(6).toString('hex')}`
  const envKeys = ['CONTROL_API_PG_CONNECTION_STRING'] as const
  const previousEnv = new Map<string, string | undefined>()
  let adminPool: Pool
  let pool: Pool
  let listener: Client
  let schemas: typeof import('../src/services/gfsWatch/notifySchemas.js')
  let dbMod: typeof import('../src/db.js')
  let users: typeof import('../src/services/directory/users.js')
  let applySchema: typeof import('../src/services/gfsWatch/authzChangedSchema.js')
  let links: typeof import('../src/services/gfsDesktopOperatorLinkService.js')
  let adminAuth: typeof import('../src/services/adminAuthService.js')
  const received: { channel: string; payload: string | undefined }[] = []
  let drive: string
  let resourceId: string

  beforeAll(async () => {
    const connectionString = databaseUrl(adminUrl!, database)
    for (const key of envKeys) {
      previousEnv.set(key, process.env[key])
      delete process.env[key]
    }
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
    process.env.CONTROL_API_PG_CONNECTION_STRING = connectionString
    // Loaded after the env is set: db.ts binds its core pool at import time.
    dbMod = await import('../src/db.js')
    ;(dbMod.pool as unknown as Pool).on('error', () => {})
    schemas = await import('../src/services/gfsWatch/notifySchemas.js')
    users = await import('../src/services/directory/users.js')
    applySchema = await import('../src/services/gfsWatch/authzChangedSchema.js')
    links = await import('../src/services/gfsDesktopOperatorLinkService.js')
    adminAuth = await import('../src/services/adminAuthService.js')
    pool = new Pool({ connectionString })
    await dbMod.initDb({ connect: () => pool.connect() })
    listener = new Client({ connectionString })
    listener.on('error', () => {})
    await listener.connect()
    listener.on('notification', message => {
      received.push({ channel: message.channel, payload: message.payload })
    })
    await listener.query(`LISTEN ${AUTHZ}; LISTEN ${SESSION}; LISTEN ${FENCE_CHANNEL}`)

    drive = `watch-${randomUUID()}`
    resourceId = randomUUID()
    await pool.query(
      `INSERT INTO gfs_resources (resource_id, drive, parent_resource_id, name, kind, path_cache)
       VALUES ($1, $2, NULL, 'root', 'directory', '/')`,
      [resourceId, drive]
    )
  }, 120_000)

  afterAll(async () => {
    try {
      for (const key of envKeys) {
        const value = previousEnv.get(key)
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await listener?.end().catch(() => {})
      if (dbMod) await endPoolAndWaitForClients(dbMod.pool as unknown as Pool).catch(() => {})
      if (pool) await endPoolAndWaitForClients(pool)
      if (adminPool) {
        await adminPool.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
            WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [database]
        )
        await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)}`)
      }
    } finally {
      await adminPool?.end()
    }
  })

  async function inTransaction<T>(
    work: (client: PoolClient) => Promise<T>,
    role: string | null = RUNTIME_ROLE
  ): Promise<T> {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      if (role) await client.query(`SET LOCAL ROLE ${role}`)
      const result = await work(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  const sql = (text: string, values: unknown[] = []) =>
    inTransaction(async client => {
      await client.query(text, values)
    })

  async function fence(): Promise<number> {
    const token = randomUUID()
    await pool.query('SELECT pg_notify($1, $2)', [FENCE_CHANNEL, token])
    const deadline = Date.now() + 5_000
    for (;;) {
      const index = received.findIndex(n => n.channel === FENCE_CHANNEL && n.payload === token)
      if (index >= 0) return index + 1
      if (Date.now() > deadline) throw new Error('fence notification never arrived')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }

  /**
   * Notifications of `write`, exactly, in delivery order. A listener receives
   * them in commit order, so fences before and after close the window. Every
   * payload must parse under its channel's schema.
   */
  async function notificationsOf(write: () => Promise<unknown>): Promise<Received> {
    const start = await fence()
    await write()
    const end = await fence()
    const window = received.slice(start, end)
    const out: Received = {
      authz: window.filter(n => n.channel === AUTHZ).map(n => n.payload ?? ''),
      session: window.filter(n => n.channel === SESSION).map(n => n.payload ?? ''),
    }
    for (const payload of out.authz) {
      expect(schemas.parseAuthzKey(payload), `authz payload ${payload}`).not.toBeNull()
    }
    for (const payload of out.session) {
      expect(schemas.parseSessionHint(payload), `session payload ${payload}`).not.toBeNull()
    }
    return out
  }

  async function createUser(): Promise<string> {
    const row = await pool.query<{ id: string }>(
      'INSERT INTO users (email) VALUES ($1) RETURNING id::text AS id',
      [`watch-${randomUUID()}@example.invalid`]
    )
    return row.rows[0]!.id
  }

  async function createAdmin(): Promise<string> {
    const row = await pool.query<{ id: string }>(
      `INSERT INTO control_admin_users (username, password_hash)
       VALUES ($1, 'x') RETURNING id::text AS id`,
      [`watch-${randomUUID()}`]
    )
    return row.rows[0]!.id
  }

  async function createTeam(): Promise<string> {
    const row = await pool.query<{ id: string }>(
      `INSERT INTO teams (name) VALUES ($1) RETURNING id::text AS id`,
      [`watch-${randomUUID()}`]
    )
    return row.rows[0]!.id
  }

  /** The key a grant/share row maps to, computed by SQL from the stored row. */
  async function subjectKeyOf(table: 'gfs_grants' | 'gfs_shares', id: string): Promise<string> {
    const row = await pool.query<{ key: string }>(
      `SELECT 's:' || subject_type || ':' ||
              CASE WHEN subject_type IN ('user', 'team') THEN subject_id ELSE '' END AS key
         FROM ${table} WHERE id = $1`,
      [id]
    )
    return row.rows[0]!.key
  }

  async function lifecycleOf(userId: string): Promise<{ state: string; version: string }> {
    const row = await pool.query<{ state: string; version: string }>(
      `SELECT lifecycle_state AS state, lifecycle_version::text AS version
         FROM users WHERE id = $1`,
      [userId]
    )
    return row.rows[0]!
  }

  async function insertSubjectRow(
    table: 'gfs_grants' | 'gfs_shares',
    subjectType: string,
    subjectId: string
  ): Promise<string> {
    const id = randomUUID()
    await sql(
      table === 'gfs_grants'
        ? `INSERT INTO gfs_grants (id, drive, resource_id, subject_type, subject_id, permissions)
           VALUES ($1, $2, $3, $4, $5, ARRAY['read'])`
        : `INSERT INTO gfs_shares (id, drive, resource_id, subject_type, subject_id, permissions)
           VALUES ($1, $2, $3, $4, $5, ARRAY['read'])`,
      [id, drive, resourceId, subjectType, subjectId]
    )
    return id
  }

  it('installs pinned, non-PUBLIC trigger functions and re-applies in place', async () => {
    const fns = await pool.query<{
      name: string
      config: string[] | null
      public_execute: boolean
    }>(
      `SELECT p.proname AS name, p.proconfig AS config,
              EXISTS (
                SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
                 WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
              ) AS public_execute
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = ANY($1::text[])
        ORDER BY 1`,
      [[...TRIGGER_FUNCTIONS, 'gfs_authz_subject_key']]
    )
    expect(fns.rows.map(row => row.name)).toEqual(
      [...TRIGGER_FUNCTIONS, 'gfs_authz_subject_key'].sort()
    )
    for (const row of fns.rows) {
      expect(row.config, row.name).toEqual(['search_path=pg_catalog, public, pg_temp'])
      // Called from the trigger body, so it is checked against the writer.
      expect(row.public_execute, row.name).toBe(row.name === 'gfs_authz_subject_key')
    }
    const migrations = await pool.query<{ version: string }>(
      `SELECT version FROM schema_migrations WHERE version = ANY($1::text[]) ORDER BY 1`,
      [[...WATCH_TRIGGER_MIGRATIONS]]
    )
    expect(migrations.rows.map(row => row.version)).toEqual([...WATCH_TRIGGER_MIGRATIONS])

    await applySchema.applyGfsAuthzGrantsSchema(pool)
    await applySchema.applyGfsAuthzSharesSchema(pool)
    await applySchema.applyGfsAuthzOperatorLinksSchema(pool)
    await applySchema.applyGfsAuthzControlAdminsSchema(pool)
    await applySchema.applyGfsAuthzTeamMembersSchema(pool)
    await applySchema.applyGfsWatchSessionUsersSchema(pool)
    const triggers = await pool.query<{ table: string; name: string }>(
      `SELECT c.relname AS table, t.tgname AS name
         FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE NOT t.tgisinternal
          AND (t.tgname LIKE 'gfs\\_authz\\_%' OR t.tgname LIKE 'gfs\\_watch\\_session\\_%')
        ORDER BY 1, 2`
    )
    expect(triggers.rows).toEqual([
      { table: 'control_admin_users', name: 'gfs_authz_changed_notify' },
      { table: 'control_admin_users', name: 'gfs_authz_changed_update_notify' },
      { table: 'gfs_desktop_operator_links', name: 'gfs_authz_changed_notify' },
      { table: 'gfs_grants', name: 'gfs_authz_changed_notify' },
      { table: 'gfs_shares', name: 'gfs_authz_changed_notify' },
      { table: 'team_members', name: 'gfs_authz_changed_notify' },
      { table: 'team_members', name: 'gfs_authz_changed_update_notify' },
      { table: 'users', name: 'gfs_watch_session_delete_notify' },
      { table: 'users', name: 'gfs_watch_session_update_notify' },
    ])
  })

  for (const table of ['gfs_grants', 'gfs_shares'] as const) {
    describe(table, () => {
      it('emits one key per write for every subject type, with an id only for user and team', async () => {
        const userId = await createUser()
        const teamId = await createTeam()
        const cases = [
          { type: 'user', id: userId },
          { type: 'team', id: teamId },
          { type: 'operator', id: '' },
          { type: 'host', id: `host-${randomUUID()}` },
          { type: 'context', id: `ctx:${randomUUID()}` },
        ]
        for (const { type, id } of cases) {
          let rowId = ''
          const inserted = await notificationsOf(async () => {
            rowId = await insertSubjectRow(table, type, id)
          })
          const key = await subjectKeyOf(table, rowId)
          expect(inserted, type).toEqual({ authz: [key], session: [] })

          const updated = await notificationsOf(() =>
            sql(`UPDATE ${table} SET permissions = ARRAY['read', 'write'] WHERE id = $1`, [rowId])
          )
          expect(updated, type).toEqual({ authz: [key], session: [] })

          const deleted = await notificationsOf(() =>
            sql(`DELETE FROM ${table} WHERE id = $1`, [rowId])
          )
          expect(deleted, type).toEqual({ authz: [key], session: [] })
        }

        expect(schemas.parseAuthzKey(`s:user:${userId}`)).toEqual({
          kind: 's',
          t: 'user',
          id: userId,
        } satisfies AuthzKey)
        expect(schemas.parseAuthzKey('s:context:')).toEqual({ kind: 's', t: 'context' })
      })

      it('emits two keys, old then new, when an UPDATE changes the subject', async () => {
        const before = await createUser()
        const after = await createTeam()
        const rowId = await insertSubjectRow(table, 'user', before)
        const oldKey = await subjectKeyOf(table, rowId)

        const moved = await notificationsOf(() =>
          sql(`UPDATE ${table} SET subject_type = 'team', subject_id = $2 WHERE id = $1`, [
            rowId,
            after,
          ])
        )
        const newKey = await subjectKeyOf(table, rowId)
        expect(oldKey).not.toBe(newKey)
        expect(moved).toEqual({ authz: [oldKey, newKey], session: [] })
        expect(moved.authz.map(p => schemas.parseAuthzKey(p))).toEqual([
          { kind: 's', t: 'user', id: before },
          { kind: 's', t: 'team', id: after },
        ])

        // Two context ids share the empty-id key: one NOTIFY.
        const ctxRow = await insertSubjectRow(table, 'context', `ctx-a-${randomUUID()}`)
        const ctxMoved = await notificationsOf(() =>
          sql(`UPDATE ${table} SET subject_id = $2 WHERE id = $1`, [
            ctxRow,
            `ctx-b-${randomUUID()}`,
          ])
        )
        expect(ctxMoved).toEqual({ authz: ['s:context:'], session: [] })
      })

      it('keeps a user subject that is not a uuid as a valid key that names nobody', async () => {
        let rowId = ''
        const payloads = await notificationsOf(async () => {
          rowId = await insertSubjectRow(table, 'user', 'not-a-uuid')
        })
        expect(payloads.authz).toEqual([await subjectKeyOf(table, rowId)])
        expect(schemas.parseAuthzKey(payloads.authz[0])).toEqual({ kind: 's', t: 'user', id: null })
      })

      it('never aborts a write with a 9000-byte context or host subject id', async () => {
        for (const type of ['context', 'host'] as const) {
          const longId = `${type}-${'x'.repeat(9000)}`
          let rowId = ''
          const inserted = await notificationsOf(async () => {
            rowId = await insertSubjectRow(table, type, longId)
          })
          expect(inserted, type).toEqual({ authz: [`s:${type}:`], session: [] })

          const updated = await notificationsOf(() =>
            sql(`UPDATE ${table} SET subject_id = $2 WHERE id = $1`, [rowId, `${longId}-2`])
          )
          expect(updated, type).toEqual({ authz: [`s:${type}:`], session: [] })

          const deleted = await notificationsOf(() =>
            sql(`DELETE FROM ${table} WHERE id = $1`, [rowId])
          )
          expect(deleted, type).toEqual({ authz: [`s:${type}:`], session: [] })
          expect(schemas.parseAuthzKey(deleted.authz[0])).toEqual({ kind: 's', t: type })
        }
      })

      it('drops a user or team id longer than a uuid instead of aborting the write', async () => {
        for (const type of ['user', 'team'] as const) {
          // Direct SQL, bypassing the routes' uuid check on user/team subjects.
          const longId = `${type}-${'y'.repeat(9000)}`
          let rowId = ''
          const inserted = await notificationsOf(async () => {
            rowId = await insertSubjectRow(table, type, longId)
          })
          expect(inserted, type).toEqual({ authz: [`s:${type}:`], session: [] })

          const updated = await notificationsOf(() =>
            sql(`UPDATE ${table} SET permissions = ARRAY['read', 'write'] WHERE id = $1`, [rowId])
          )
          expect(updated, type).toEqual({ authz: [`s:${type}:`], session: [] })

          const deleted = await notificationsOf(() =>
            sql(`DELETE FROM ${table} WHERE id = $1`, [rowId])
          )
          expect(deleted, type).toEqual({ authz: [`s:${type}:`], session: [] })
          expect(schemas.parseAuthzKey(deleted.authz[0])).toEqual({ kind: 's', t: type, id: null })
        }
      })
    })
  }

  it('team_members: membership insert, status change and delete name the user; a role change does not', async () => {
    const teamId = await createTeam()
    const userId = await createUser()
    const other = await createUser()

    const inserted = await notificationsOf(() =>
      sql(
        `INSERT INTO team_members (team_id, user_id, role, status)
         VALUES ($1, $2, 'member', 'active'), ($1, $3, 'member', 'active')`,
        [teamId, userId, other]
      )
    )
    expect(inserted).toEqual({ authz: [`u:${userId}`, `u:${other}`], session: [] })
    expect(schemas.parseAuthzKey(inserted.authz[0])).toEqual({ kind: 'u', id: userId })

    const roleOnly = await notificationsOf(() =>
      sql(`UPDATE team_members SET role = 'admin' WHERE team_id = $1 AND user_id = $2`, [
        teamId,
        userId,
      ])
    )
    expect(roleOnly).toEqual({ authz: [], session: [] })

    const status = await notificationsOf(() =>
      sql(`UPDATE team_members SET status = 'deleted' WHERE team_id = $1 AND user_id = $2`, [
        teamId,
        userId,
      ])
    )
    expect(status).toEqual({ authz: [`u:${userId}`], session: [] })

    const sameStatus = await notificationsOf(() =>
      sql(`UPDATE team_members SET status = 'deleted' WHERE team_id = $1 AND user_id = $2`, [
        teamId,
        userId,
      ])
    )
    expect(sameStatus).toEqual({ authz: [], session: [] })

    // Moving a membership to another user names both, old then new, even
    // with status absent from the SET list.
    const target = await createUser()
    const moved = await notificationsOf(() =>
      sql(`UPDATE team_members SET user_id = $3 WHERE team_id = $1 AND user_id = $2`, [
        teamId,
        userId,
        target,
      ])
    )
    expect(moved).toEqual({ authz: [`u:${userId}`, `u:${target}`], session: [] })

    // Deleting the team cascades row by row onto its memberships.
    const cascade = await notificationsOf(() => sql(`DELETE FROM teams WHERE id = $1`, [teamId]))
    expect([...cascade.authz].sort()).toEqual([`u:${other}`, `u:${target}`].sort())
    expect(cascade.session).toEqual([])
  })

  it('gfs_desktop_operator_links: link, revoke and delete name the linked user', async () => {
    const userId = await createUser()
    const adminId = await createAdmin()
    const service = new links.GfsDesktopOperatorLinkService({
      transaction: work => inTransaction(work),
    })

    let linkId = ''
    const linked = await notificationsOf(async () => {
      const result = await service.link({
        desktopUserId: userId,
        controlAdminId: adminId,
        source: 'initial_setup',
        operatorSub: adminId,
        requestId: `watch-${randomUUID()}`,
      })
      expect(result.created).toBe(true)
      linkId = result.link.id
    })
    expect(linked).toEqual({ authz: [`u:${userId}`], session: [] })

    const revoked = await notificationsOf(async () => {
      const result = await service.unlink({
        desktopUserId: userId,
        controlAdminId: adminId,
        operatorSub: adminId,
        reason: 'watch trigger test',
        requestId: `watch-${randomUUID()}`,
      })
      expect(result.unlinked).toBe(true)
    })
    expect(revoked).toEqual({ authz: [`u:${userId}`], session: [] })

    // No production writer deletes a link (history is retained); the DELETE
    // branch of the trigger is pinned for a future one.
    const deleted = await notificationsOf(() =>
      inTransaction(
        client => client.query(`DELETE FROM gfs_desktop_operator_links WHERE id = $1`, [linkId]),
        null
      )
    )
    expect(deleted).toEqual({ authz: [`u:${userId}`], session: [] })
  })

  it('control_admin_users: status, session_version and delete name the admin; other columns do not', async () => {
    let adminId = ''
    const created = await notificationsOf(async () => {
      adminId = await createAdmin()
    })
    expect(created).toEqual({ authz: [], session: [] })
    const actorId = await createAdmin()

    const logins = await notificationsOf(async () => {
      await adminAuth.registerAdminFailedLogin(adminId, 15, 5)
      await adminAuth.registerAdminSuccessfulLogin(adminId)
    })
    expect(logins).toEqual({ authz: [], session: [] })

    const passwordChanged = await notificationsOf(() =>
      adminAuth.updateAdminPassword(adminId, 'x2')
    )
    expect(passwordChanged).toEqual({ authz: [`a:${adminId}`], session: [] })

    // A statement that names the columns but changes neither emits nothing.
    const unchanged = await notificationsOf(() =>
      sql(
        `UPDATE control_admin_users
            SET status = status, session_version = session_version WHERE id = $1`,
        [adminId]
      )
    )
    expect(unchanged).toEqual({ authz: [], session: [] })

    const retired = await notificationsOf(() =>
      inTransaction(
        client =>
          adminAuth.retireControlAdminInTransaction(client, {
            actorAdminId: actorId,
            adminId,
            reason: 'control_admin_retired',
          }),
        null
      )
    )
    const row = await pool.query<{ status: string }>(
      `SELECT status FROM control_admin_users WHERE id = $1`,
      [adminId]
    )
    expect(row.rows[0]!.status).toBe('disabled')
    expect(retired).toEqual({ authz: [`a:${adminId}`], session: [] })
    expect(schemas.parseAuthzKey(retired.authz[0])).toEqual({ kind: 'a', id: adminId })

    // Every production status change also bumps session_version; a status-only
    // change and a changed id are pinned so a future writer inherits them.
    const reenabled = await notificationsOf(() =>
      sql(`UPDATE control_admin_users SET status = 'active' WHERE id = $1`, [adminId])
    )
    expect(reenabled).toEqual({ authz: [`a:${adminId}`], session: [] })

    const replacementId = randomUUID()
    const renamed = await notificationsOf(() =>
      sql(`UPDATE control_admin_users SET id = $2 WHERE id = $1`, [adminId, replacementId])
    )
    expect(renamed).toEqual({ authz: [`a:${adminId}`, `a:${replacementId}`], session: [] })

    // No production writer deletes an admin row; the DELETE trigger is pinned.
    const deleted = await notificationsOf(() =>
      sql(`DELETE FROM control_admin_users WHERE id = $1`, [replacementId])
    )
    expect(deleted).toEqual({ authz: [`a:${replacementId}`], session: [] })
  })

  describe('users lifecycle', () => {
    const hintOf = (userId: string, state: string, version: string) =>
      `${userId}:${state}:${version}`

    it('emits nothing for an UPDATE that leaves lifecycle_state and lifecycle_version as they were', async () => {
      const userId = await createUser()
      const payloads = await notificationsOf(() =>
        sql(
          `UPDATE users
              SET name = 'renamed', updated_at = now(),
                  lifecycle_state = lifecycle_state, lifecycle_version = lifecycle_version
            WHERE id = $1`,
          [userId]
        )
      )
      expect(payloads).toEqual({ authz: [], session: [] })
    })

    it('emits <id>:active:<v> when the version moves', async () => {
      const userId = await createUser()
      const payloads = await notificationsOf(() =>
        sql(`UPDATE users SET lifecycle_version = lifecycle_version + 1 WHERE id = $1`, [userId])
      )
      const now = await lifecycleOf(userId)
      expect(now.state).toBe('active')
      expect(payloads).toEqual({
        authz: [],
        session: [hintOf(userId, now.state, now.version)],
      })
      expect(schemas.parseSessionHint(payloads.session[0])).toEqual({
        uid: userId,
        state: 'active',
        version: Number(now.version),
      } satisfies SessionHint)
    })

    it('retiring a user with a membership and an operator link emits retired and names the user', async () => {
      const actor = await createUser()
      const userId = await createUser()
      const adminId = await createAdmin()
      const teamId = await createTeam()
      await pool.query(
        `INSERT INTO team_members (team_id, user_id, role, status) VALUES ($1, $2, 'member', 'active')`,
        [teamId, userId]
      )
      await new links.GfsDesktopOperatorLinkService({
        transaction: work => inTransaction(work),
      }).link({
        desktopUserId: userId,
        controlAdminId: adminId,
        source: 'initial_setup',
        operatorSub: adminId,
      })

      const payloads = await notificationsOf(() =>
        inTransaction(
          client =>
            users.retireDesktopUser(
              { kind: 'platform_user', desktopUserId: actor },
              userId,
              'watch trigger test',
              `watch-${randomUUID()}`,
              `watch-${randomUUID()}`,
              { db: client }
            ),
          null
        )
      )
      const now = await lifecycleOf(userId)
      expect(now.state).toBe('retired')
      expect(payloads.session).toEqual([hintOf(userId, 'retired', now.version)])
      expect(payloads.authz).toContain(`u:${userId}`)
      expect(new Set(payloads.authz)).toEqual(new Set([`u:${userId}`]))
    })

    it('hard-deleting a user emits deleted with the last version, and its memberships name it', async () => {
      const actor = await createUser()
      const userId = await createUser()
      const teamId = await createTeam()
      await pool.query(
        `INSERT INTO team_members (team_id, user_id, role, status) VALUES ($1, $2, 'member', 'active')`,
        [teamId, userId]
      )
      await pool.query(`UPDATE users SET lifecycle_version = 7 WHERE id = $1`, [userId])
      const last = await lifecycleOf(userId)

      const payloads = await notificationsOf(() =>
        inTransaction(
          client =>
            users.retireDesktopUser(
              { kind: 'platform_user', desktopUserId: actor },
              userId,
              'watch trigger test',
              `watch-${randomUUID()}`,
              `watch-${randomUUID()}`,
              { db: client }
            ),
          null
        )
      )
      const gone = await pool.query(`SELECT 1 FROM users WHERE id = $1`, [userId])
      expect(gone.rowCount).toBe(0)
      expect(payloads).toEqual({
        authz: [`u:${userId}`],
        session: [hintOf(userId, 'deleted', last.version)],
      })
      expect(schemas.parseSessionHint(payloads.session[0])).toEqual({
        uid: userId,
        state: 'deleted',
        version: 7,
      })

      // A user with no dependencies at all.
      const bare = await createUser()
      const bareLast = await lifecycleOf(bare)
      const bareDelete = await notificationsOf(() => sql(`DELETE FROM users WHERE id = $1`, [bare]))
      expect(bareDelete).toEqual({
        authz: [],
        session: [hintOf(bare, 'deleted', bareLast.version)],
      })
    })

    it('emits one hint per row of a multi-row UPDATE', async () => {
      const a = await createUser()
      const b = await createUser()
      const payloads = await notificationsOf(() =>
        sql(
          `UPDATE users SET lifecycle_version = lifecycle_version + 1 WHERE id = ANY($1::uuid[])`,
          [[a, b]]
        )
      )
      const va = await lifecycleOf(a)
      const vb = await lifecycleOf(b)
      expect([...payloads.session].sort()).toEqual(
        [hintOf(a, 'active', va.version), hintOf(b, 'active', vb.version)].sort()
      )
    })
  })

  it('lets a slow login that writes users and then team_members finish while the migrations wait on users', async () => {
    const { CONTROL_API_MIGRATIONS } = dbMod
    const { applyPendingPr1Migrations } = await import('../src/migrations/migrationRunner.js')
    const { googleLoginData } = await import('../src/services/directory/login.js')
    const email = `watch-login-${randomUUID()}@example.invalid`
    await pool.query('INSERT INTO users (email) VALUES ($1)', [email])
    // Every migration after the resource trigger, so a single-transaction
    // version of them is exercised the same way.
    await pool.query(
      `DELETE FROM schema_migrations WHERE version > '0139_gfs_resource_changed_notify'`
    )

    // Hold the real login between its UPDATE users and its INSERT INTO
    // team_members, the window in which it holds users and still needs
    // team_members.
    let reachedGate!: () => void
    const reached = new Promise<void>(resolve => {
      reachedGate = resolve
    })
    let openGate!: () => void
    const gate = new Promise<void>(resolve => {
      openGate = resolve
    })
    const corePool = dbMod.pool as unknown as Pool
    const gated = new WeakSet<object>()
    const onAcquire = (client: PoolClient) => {
      if (gated.has(client)) return
      gated.add(client)
      const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>
      ;(client as unknown as { query: unknown }).query = async (...args: unknown[]) => {
        if (typeof args[0] === 'string' && args[0].includes('INSERT INTO team_members')) {
          reachedGate()
          await gate
        }
        return query(...args)
      }
    }
    corePool.on('acquire', onAcquire)

    const migrator = await pool.connect()
    try {
      const login = googleLoginData({ email, name: 'slow login' }).then(
        result => ({ ok: true as const, result }),
        (error: unknown) => ({ ok: false as const, error })
      )
      await reached

      const migratorPid = Number(
        (await migrator.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      )
      const applied = await migrator.query<{ version: string }>(
        'SELECT version FROM schema_migrations'
      )
      const migrations = applyPendingPr1Migrations({
        db: migrator,
        migrations: CONTROL_API_MIGRATIONS,
        appliedVersions: new Set(applied.rows.map(row => row.version)),
        recordMigration: async (db, version) => {
          await db.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version])
        },
        sleep: async () => {},
      }).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error })
      )

      // The migration run is now blocked on users behind the login.
      const deadline = Date.now() + 8_000
      for (;;) {
        const waiting = await pool.query(
          `SELECT 1 FROM pg_locks
            WHERE pid = $1 AND NOT granted AND relation = 'users'::regclass`,
          [migratorPid]
        )
        if (waiting.rowCount) break
        if (Date.now() > deadline) throw new Error('the migrations never waited on users')
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      // A deadlock is resolved by aborting the backend whose deadlock_timeout
      // check finds the cycle. A login slower than that timeout arrives after
      // the migration's own check has passed, so the login is the one checked
      // and aborted when the two do form a cycle.
      const timeout = await pool.query<{ ms: string }>(
        `SELECT setting AS ms FROM pg_settings WHERE name = 'deadlock_timeout'`
      )
      await new Promise(resolve => setTimeout(resolve, Number(timeout.rows[0]!.ms) + 500))
      openGate()

      const loginOutcome = await login
      expect(
        loginOutcome.ok ? null : (loginOutcome.error as { code?: string }).code,
        'login transaction'
      ).toBeNull()
      expect(await migrations).toEqual({ ok: true })
    } finally {
      corePool.off('acquire', onAcquire)
      openGate()
      migrator.release()
    }

    const recorded = await pool.query<{ version: string }>(
      `SELECT version FROM schema_migrations WHERE version = ANY($1::text[]) ORDER BY 1`,
      [[...WATCH_TRIGGER_MIGRATIONS]]
    )
    expect(recorded.rows.map(row => row.version)).toEqual([...WATCH_TRIGGER_MIGRATIONS])
  }, 60_000)

  it('retries the migration when a writer holds users past the lock timeout', async () => {
    const { CONTROL_API_MIGRATIONS } = dbMod
    const { applyPendingPr1Migrations } = await import('../src/migrations/migrationRunner.js')
    const userId = await createUser()
    await pool.query(`DELETE FROM schema_migrations WHERE version = $1`, [USERS_MIGRATION])

    // An open writer transaction on users: CREATE TRIGGER waits behind it.
    const writer = await pool.connect()
    const migrator = await pool.connect()
    const statements: string[] = []
    const errors: unknown[] = []
    try {
      await writer.query('BEGIN')
      await writer.query(`UPDATE users SET name = 'busy' WHERE id = $1`, [userId])
      const applied = await migrator.query<{ version: string }>(
        'SELECT version FROM schema_migrations'
      )
      await applyPendingPr1Migrations({
        db: {
          query: async (text: string, values?: unknown[]) => {
            statements.push(text)
            // The first attempt has lost its lock wait: the writer commits.
            if (text === 'ROLLBACK' && statements.filter(s => s === 'ROLLBACK').length === 1) {
              await writer.query('COMMIT')
            }
            try {
              return await migrator.query(text, values)
            } catch (error) {
              errors.push(error)
              throw error
            }
          },
        },
        migrations: CONTROL_API_MIGRATIONS,
        appliedVersions: new Set(applied.rows.map(row => row.version)),
        recordMigration: async (db, version) => {
          await db.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version])
        },
        sleep: async () => {},
      })
    } finally {
      await writer.query('ROLLBACK').catch(() => {})
      writer.release()
      migrator.release()
    }

    expect(errors).toHaveLength(1)
    expect((errors[0] as { code?: string }).code).toBe('55P03')
    expect(statements.filter(s => s === 'BEGIN')).toHaveLength(2)
    expect(statements.filter(s => s === 'COMMIT')).toHaveLength(1)
    const recorded = await pool.query(`SELECT 1 FROM schema_migrations WHERE version = $1`, [
      USERS_MIGRATION,
    ])
    expect(recorded.rowCount).toBe(1)

    // The re-applied triggers still fire.
    const payloads = await notificationsOf(() =>
      sql(`UPDATE users SET lifecycle_version = lifecycle_version + 1 WHERE id = $1`, [userId])
    )
    expect(payloads.session).toHaveLength(1)
  }, 60_000)
})
