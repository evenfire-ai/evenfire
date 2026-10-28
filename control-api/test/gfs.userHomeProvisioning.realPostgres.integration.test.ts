import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { hashSync } from 'bcryptjs'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import pino from 'pino'
import { resolveDecision } from '../../gfs-controller/src/authz/resolve.js'
import { BlobStore } from '../../gfs-controller/src/storage/blobStore.js'
import { withTransaction } from '../src/db.js'
import { provisionUserHome } from '../src/gfs/userHomeProvisioner.js'
import { rootLogger } from '../src/observability/logger.js'
import {
  provisionAdminDesktopWorkspace,
  provisionMemberFromAdmin,
} from '../src/services/directory/adminProvisioning.js'
import { ensureInvitationUser } from '../src/services/directory/invitationStore.js'
import { googleLoginData } from '../src/services/directory/login.js'
import { createAdminUser } from '../src/services/directory/users.js'
import { GfsUserHomeReconciler } from '../src/services/gfsUserHomeReconciler.js'
import {
  createPostgresCommitReplyBlackhole,
  createPostgresDisconnectBlackhole,
} from './helpers/realPostgresCancellation.js'
import { createPostgresFatalCommitReplyInjector } from './helpers/realPostgresFatalCommit.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'
import {
  createDrive,
  createUser,
  createUserHomeDatabase,
  homeState,
} from './helpers/userHomeRealPostgres.js'

const holder = vi.hoisted(() => ({ pool: undefined as Pool | undefined }))
vi.mock('../src/db.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/db.js')>()
  return {
    ...actual,
    withTransaction: ((work, txPool, options) =>
      actual.withTransaction(
        work,
        txPool ?? holder.pool,
        options
      )) as typeof actual.withTransaction,
  }
})

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

describeRealPostgres('user-home provisioning on PostgreSQL', () => {
  let adminPool: Pool
  let database: Awaited<ReturnType<typeof createUserHomeDatabase>>
  let drive: string
  let rootId: string

  beforeAll(async () => {
    if (!adminUrl) throw new Error('CONTROL_API_REAL_PG_ADMIN_URL is required')
    adminPool = new Pool({ connectionString: adminUrl })
    database = await createUserHomeDatabase(adminUrl, adminPool)
    holder.pool = database.pool
  }, 60_000)

  afterAll(async () => {
    try {
      holder.pool = undefined
      if (database) {
        await database.closeConnections()
        await adminPool.query(`DROP DATABASE "${database.database}"`)
      }
    } finally {
      await adminPool?.end()
    }
  }, 60_000)

  beforeEach(async () => {
    drive = `homes-${randomUUID()}`
    rootId = await createDrive(database.pool, drive)
  })

  async function assertReady(userId: string) {
    const row = await homeState(database.pool, userId)
    expect(row).toMatchObject({ state: 'ready', drive, conflict_code: null, last_error: null })
    expect(row?.resource_id).toBeTruthy()
    const grants = await database.pool.query(
      `SELECT permissions, inherit, granted_by FROM gfs_grants
        WHERE drive = $1 AND resource_id = $2 AND subject_type = 'user' AND subject_id = $3`,
      [drive, row!.resource_id, userId]
    )
    expect(grants.rows).toEqual([
      {
        permissions: ['read', 'write', 'delete', 'share', 'manage_acl'],
        inherit: true,
        granted_by: 'platform:user-home',
      },
    ])
    return row!
  }

  it('settles a tick and releases the reconciler lock after a silent lost COMMIT reply', async () => {
    const user = await createUser(database.pool, 'Lost Commit Owner')
    const url = new URL(adminUrl!)
    url.pathname = `/${database.database}`
    const blackhole = await createPostgresCommitReplyBlackhole(url.toString())
    const proxyPool = new Pool({
      connectionString: blackhole.connectionString,
      max: 2,
      statement_timeout: 10_000,
    })
    let transactions = 0
    const transaction: typeof withTransaction = async (work, txPool, options) => {
      transactions += 1
      return withTransaction(work, txPool, options)
    }
    const results: string[] = []
    const worker = new GfsUserHomeReconciler(drive, database.pool, async userId => {
      const result = await provisionUserHome(userId, {
        drive,
        dbPool: proxyPool,
        transaction,
        transactionTimeoutMs: 2_000,
      })
      results.push(result)
      return result
    })
    try {
      const tick = worker.tick()
      await blackhole.commitForwarded
      await tick

      expect(blackhole.discardedReplyBytes).toBeGreaterThan(0)
      expect(transactions).toBe(2)
      expect(results).toEqual(['ready'])
      await assertReady(user)

      const observer = await database.pool.connect()
      try {
        const lock = await observer.query(
          "SELECT pg_try_advisory_lock(hashtext('gfs-user-home-reconciler-v1')) AS acquired"
        )
        expect(lock.rows[0].acquired).toBe(true)
        await observer.query("SELECT pg_advisory_unlock(hashtext('gfs-user-home-reconciler-v1'))")
      } finally {
        observer.release()
      }
    } finally {
      await blackhole.close()
      await endPoolAndWaitForClients(proxyPool)
    }
  }, 15_000)

  it('provisions exactly one home after each of the five user creation paths', async () => {
    const suffix = randomUUID()
    const adminId = randomUUID()
    const passwordHash = hashSync(randomUUID(), 4)
    await database.pool.query(
      `INSERT INTO control_admin_users (id, username, email, password_hash, role, status, session_version)
       VALUES ($1, $2, $3, $4, 'admin', 'active', 1)`,
      [adminId, `admin-${suffix}`, `admin-${suffix}@example.test`, passwordHash]
    )
    const workspace = await provisionAdminDesktopWorkspace({
      controlAdminId: adminId,
      email: `workspace-${suffix}@example.test`,
      displayName: 'Workspace Owner',
      passwordHash,
      agentNames: [],
      contextIds: [],
      linkDesktopOperator: false,
      seedPassword: false,
    })
    const member = await provisionMemberFromAdmin({
      adminId,
      operatorSub: adminId,
      teamAssignments: [],
      seedPassword: false,
    })
    if ('error' in member) throw new Error(member.error)
    const invited = await withTransaction(
      db => ensureInvitationUser(db, `invited-${suffix}@example.test`, 'Invited User'),
      database.pool
    )
    const google = await googleLoginData({
      email: `google-${suffix}@example.test`,
      name: 'Google User',
    })
    if ('error' in google) throw new Error(google.error)
    const created = await createAdminUser(`created-${suffix}@example.test`, 'Created User')
    const ids = [workspace.userId, member.user.id, invited.id, google.user.id, created.id]
    expect(new Set(ids).size).toBe(5)
    for (const id of ids) {
      expect(await provisionUserHome(id, { drive, dbPool: database.pool })).toBe('ready')
      await assertReady(id)
      expect(
        (
          await database.pool.query(
            'SELECT count(*)::int AS count FROM gfs_user_homes WHERE user_id = $1',
            [id]
          )
        ).rows[0].count
      ).toBe(1)
    }
  }, 60_000)

  it('serializes concurrent attempts and resolves same-base names with savepoints', async () => {
    const first = await createUser(database.pool, 'Common Name')
    const second = await createUser(database.pool, 'Common Name')
    const results = await Promise.all([
      provisionUserHome(first, { drive, dbPool: database.pool }),
      provisionUserHome(first, { drive, dbPool: database.pool }),
      provisionUserHome(second, { drive, dbPool: database.pool }),
    ])
    expect(results.filter(result => result === 'ready')).toHaveLength(2)
    const firstHome = await assertReady(first)
    const secondHome = await assertReady(second)
    expect(firstHome.resource_id).not.toBe(secondHome.resource_id)
    expect(firstHome.storage_username).not.toBe(secondHome.storage_username)
    expect([firstHome.storage_username, secondHome.storage_username]).toContain('common-name')
    expect(await provisionUserHome(first, { drive, dbPool: database.pool })).toBe('unchanged')
    await assertReady(first)
  })

  it('falls back to the full UUID when the base and eight-character suffix are taken', async () => {
    const first = '12345678-1000-4000-8000-000000000001'
    const second = '12345678-2000-4000-8000-000000000002'
    const third = '12345678-3000-4000-8000-000000000003'
    for (const id of [first, second, third]) {
      await database.pool.query('INSERT INTO users (id, email, name) VALUES ($1, $2, $3)', [
        id,
        `${id}@example.test`,
        'Same User',
      ])
      expect(await provisionUserHome(id, { drive, dbPool: database.pool })).toBe('ready')
    }
    expect((await assertReady(first)).storage_username).toBe('same-user')
    expect((await assertReady(second)).storage_username).toBe('same-user-12345678')
    expect((await assertReady(third)).storage_username).toBe(third)
    await database.pool.query('UPDATE users SET name = $2 WHERE id = $1', [
      first,
      'Changed Profile',
    ])
    expect(await provisionUserHome(first, { drive, dbPool: database.pool })).toBe('unchanged')
    expect((await assertReady(first)).storage_username).toBe('same-user')
  })

  it.each([false, true])(
    'keeps a bound resource when its reserved path does not match (occupied=%s)',
    async occupied => {
      const user = await createUser(database.pool, 'Bound Owner')
      expect(await provisionUserHome(user, { drive, dbPool: database.pool })).toBe('ready')
      const original = await assertReady(user)
      const before = await database.pool.query(
        'SELECT resource_id, parent_resource_id, name, kind FROM gfs_resources WHERE resource_id = $1',
        [original.resource_id]
      )
      expect(before.rows).toHaveLength(1)
      const ownerGrant = await database.pool.query<{ id: string }>(
        `SELECT id::text FROM gfs_grants
          WHERE resource_id = $1 AND subject_type = 'user' AND subject_id = $2`,
        [original.resource_id, user]
      )
      expect(ownerGrant.rows).toHaveLength(1)
      const subject = randomUUID()
      const boundShare = await database.pool.query<{ id: string }>(
        `INSERT INTO gfs_shares (drive, resource_id, subject_type, subject_id, permissions, include_descendants)
         VALUES ($1, $2, 'user', $3, ARRAY['read'], true) RETURNING id::text`,
        [drive, original.resource_id, subject]
      )
      const foreignId = occupied ? randomUUID() : null
      let foreignGrantId: string | undefined
      let foreignShareId: string | undefined
      if (foreignId) {
        await database.pool.query(
          `INSERT INTO gfs_resources (resource_id, drive, parent_resource_id, name, kind, path_cache)
         VALUES ($1, $2, $3, 'different-name', 'directory', '/Users/different-name')`,
          [foreignId, drive, before.rows[0].parent_resource_id]
        )
        const foreignGrant = await database.pool.query<{ id: string }>(
          `INSERT INTO gfs_grants (drive, resource_id, subject_type, subject_id, permissions, inherit)
           VALUES ($1, $2, 'user', $3, ARRAY['read'], true) RETURNING id::text`,
          [drive, foreignId, subject]
        )
        const foreignShare = await database.pool.query<{ id: string }>(
          `INSERT INTO gfs_shares (drive, resource_id, subject_type, subject_id, permissions, include_descendants)
           VALUES ($1, $2, 'user', $3, ARRAY['read'], true) RETURNING id::text`,
          [drive, foreignId, subject]
        )
        foreignGrantId = foreignGrant.rows[0].id
        foreignShareId = foreignShare.rows[0].id
      }
      await database.pool.query(
        "UPDATE gfs_user_homes SET state = 'pending', storage_username = 'different-name' WHERE user_id = $1",
        [user]
      )
      const statements: string[] = []
      const transaction: typeof withTransaction = (work, txPool, options) =>
        withTransaction(
          async db =>
            work({
              ...db,
              query: async (sql: string, values?: unknown[]) => {
                statements.push(sql)
                return db.query(sql, values)
              },
            } as typeof db),
          txPool,
          options
        )
      expect(await provisionUserHome(user, { drive, dbPool: database.pool, transaction })).toBe(
        'conflict'
      )
      expect(await homeState(database.pool, user)).toMatchObject({
        state: 'conflict',
        conflict_code: 'path_conflict',
        resource_id: original.resource_id,
      })
      const details = await database.pool.query(
        'SELECT conflict_detail FROM gfs_user_homes WHERE user_id = $1',
        [user]
      )
      expect(details.rows[0].conflict_detail).toEqual({
        resourceIds: foreignId ? [foreignId, original.resource_id] : [original.resource_id],
        grantIds: [foreignGrantId ?? ownerGrant.rows[0].id],
        shareIds: [foreignShareId ?? boundShare.rows[0].id],
      })
      expect(statements.some(sql => sql.includes('WHERE resource_id = $1::uuid FOR UPDATE'))).toBe(
        true
      )
      expect(statements.some(sql => sql.includes('INSERT INTO gfs_resources'))).toBe(false)
      expect(
        (
          await database.pool.query(
            'SELECT resource_id, parent_resource_id, name, kind FROM gfs_resources WHERE resource_id = $1',
            [original.resource_id]
          )
        ).rows
      ).toEqual(before.rows)
      const extra = await database.pool.query(
        "SELECT resource_id FROM gfs_resources WHERE drive = $1 AND name = 'different-name' AND deleted_at IS NULL",
        [drive]
      )
      expect(extra.rows).toEqual(foreignId ? [{ resource_id: foreignId }] : [])
      const conflicts = await database.pool.query(
        "SELECT op FROM gfs_audit WHERE subject = $1 AND op LIKE 'user_home.conflict.%'",
        [`user:${user}`]
      )
      expect(conflicts.rows).toEqual([{ op: 'user_home.conflict.path_conflict' }])
      const owner = await database.pool.query(
        "SELECT permissions, inherit FROM gfs_grants WHERE resource_id = $1 AND subject_type = 'user' AND subject_id = $2",
        [original.resource_id, user]
      )
      expect(owner.rows).toEqual([
        { permissions: ['read', 'write', 'delete', 'share', 'manage_acl'], inherit: true },
      ])
    }
  )

  it('enrolls an insert-only users role without giving it any home-table privileges', async () => {
    const role = `home_insert_${randomUUID().replaceAll('-', '')}`
    const userId = randomUUID()
    const client = await database.pool.connect()
    try {
      await client.query(`CREATE ROLE "${role}" NOLOGIN`)
      await client.query(`GRANT USAGE ON SCHEMA public TO "${role}"`)
      await client.query(`GRANT INSERT ON users TO "${role}"`)
      // The existing invoker-rights password fence also runs on every user INSERT.
      await client.query(`GRANT SELECT, UPDATE ON password_identifier_state TO "${role}"`)
      await client.query(`SET ROLE "${role}"`)
      const privileges = await client.query(`SELECT
        has_table_privilege(current_user, 'users', 'INSERT') AS insert_users,
        has_table_privilege(current_user, 'users', 'SELECT') AS select_users,
        has_table_privilege(current_user, 'users', 'UPDATE') AS update_users,
        has_table_privilege(current_user, 'users', 'DELETE') AS delete_users,
        has_table_privilege(current_user, 'gfs_user_homes', 'SELECT') AS select_homes,
        has_table_privilege(current_user, 'gfs_user_homes', 'INSERT') AS insert_homes,
        has_table_privilege(current_user, 'gfs_user_homes', 'UPDATE') AS update_homes,
        has_table_privilege(current_user, 'gfs_user_homes', 'DELETE') AS delete_homes`)
      expect(privileges.rows[0]).toEqual({
        insert_users: true,
        select_users: false,
        update_users: false,
        delete_users: false,
        select_homes: false,
        insert_homes: false,
        update_homes: false,
        delete_homes: false,
      })
      await client.query('INSERT INTO users (id, email, name) VALUES ($1, $2, $3)', [
        userId,
        `${userId}@example.test`,
        'Role User',
      ])
      await expect(
        client.query('SELECT * FROM gfs_user_homes WHERE user_id = $1', [userId])
      ).rejects.toMatchObject({ code: '42501' })
      await client.query('RESET ROLE')
      expect(await homeState(database.pool, userId)).toMatchObject({
        state: 'pending',
        drive: null,
      })
      expect(await provisionUserHome(userId, { drive, dbPool: database.pool })).toBe('ready')
      await assertReady(userId)
    } finally {
      await client.query('RESET ROLE')
      await client.query(`DROP OWNED BY "${role}"`)
      await client.query(`DROP ROLE "${role}"`)
      client.release()
    }
  })

  it('reports a foreign path without changing its owner access or bytes', async () => {
    const foreignOwner = randomUUID()
    const user = await createUser(database.pool, 'Foreign Path')
    const usersId = randomUUID()
    const foreignId = randomUUID()
    const fileId = randomUUID()
    await database.pool.query(
      `INSERT INTO gfs_resources (resource_id, drive, parent_resource_id, name, kind, path_cache)
       VALUES ($1,$4,$5,'Users','directory','/Users'),
              ($2,$4,$1,'foreign-path','directory','/Users/foreign-path'),
              ($3,$4,$2,'file.txt','file','/Users/foreign-path/file.txt')`,
      [usersId, foreignId, fileId, drive, rootId]
    )
    const foreignGrant = await database.pool.query(
      `INSERT INTO gfs_grants (drive, resource_id, subject_type, subject_id, permissions, inherit)
       VALUES ($1,$2,'user',$3,ARRAY['read'],true) RETURNING id::text`,
      [drive, foreignId, foreignOwner]
    )
    const foreignShare = await database.pool.query(
      `INSERT INTO gfs_shares (drive, resource_id, subject_type, subject_id, permissions, include_descendants)
       VALUES ($1,$2,'user',$3,ARRAY['read'],true) RETURNING id::text`,
      [drive, foreignId, foreignOwner]
    )
    const directory = await mkdtemp(join(tmpdir(), 'gfs-home-foreign-'))
    try {
      const store = new BlobStore(directory, 'writer')
      const content = Buffer.from('foreign owner bytes')
      const blob = await store.writeImmutable(fileId, randomUUID(), content)
      await database.pool.query(
        'UPDATE gfs_resources SET blob_key = $2, content_sha256 = $3, bytes = $4 WHERE resource_id = $1',
        [fileId, blob.blobKey, blob.contentSha256, blob.bytes]
      )
      expect(await provisionUserHome(user, { drive, dbPool: database.pool })).toBe('conflict')
      expect(await homeState(database.pool, user)).toMatchObject({
        state: 'conflict',
        conflict_code: 'path_conflict',
        resource_id: null,
      })
      const stored = await database.pool.query(
        'SELECT conflict_detail FROM gfs_user_homes WHERE user_id = $1',
        [user]
      )
      expect(stored.rows[0].conflict_detail).toEqual({
        resourceIds: [foreignId],
        grantIds: [foreignGrant.rows[0].id],
        shareIds: [foreignShare.rows[0].id],
      })
      const grants = await database.pool.query<{
        subject_type: string
        subject_id: string
        resource_id: string
        permissions: string[]
        inherit: boolean
      }>(
        'SELECT subject_type, subject_id, resource_id, permissions, inherit FROM gfs_grants WHERE resource_id = $1',
        [foreignId]
      )
      const decision = resolveDecision({
        resourceId: fileId,
        ancestors: [fileId, foreignId, usersId, rootId],
        subjects: new Set([`user:${foreignOwner}`]),
        isOperator: false,
        op: 'read',
        shares: [],
        grants: grants.rows.map(row => ({
          subjectKey: `${row.subject_type}:${row.subject_id}`,
          resourceId: row.resource_id,
          permissions: row.permissions,
          inherit: row.inherit,
        })),
      })
      expect(decision.allowed).toBe(true)
      const chunks: Buffer[] = []
      for await (const chunk of await store.read(fileId, blob.blobKey))
        chunks.push(Buffer.from(chunk))
      expect(Buffer.concat(chunks)).toEqual(content)
      expect(
        (
          await database.pool.query('SELECT blob_key FROM gfs_resources WHERE resource_id = $1', [
            fileId,
          ])
        ).rows[0].blob_key
      ).toBe(blob.blobKey)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.each([
    { ancestor: 'root', table: 'gfs_grants' },
    { ancestor: 'users', table: 'gfs_grants' },
    { ancestor: 'root', table: 'gfs_shares' },
    { ancestor: 'users', table: 'gfs_shares' },
  ] as const)(
    'rejects inheritable $table on $ancestor while provisioning a separate safe drive',
    async ({ ancestor, table }) => {
      const blocked = await createUser(database.pool, 'Blocked User')
      const users = await database.pool.query(
        `INSERT INTO gfs_resources (drive, parent_resource_id, name, kind, path_cache)
       VALUES ($1,$2,'Users','directory','/Users') RETURNING resource_id`,
        [drive, rootId]
      )
      const ancestorId = ancestor === 'root' ? rootId : users.rows[0].resource_id
      const inherited = table === 'gfs_grants' ? 'inherit' : 'include_descendants'
      const offending = await database.pool.query(
        `INSERT INTO ${table} (drive, resource_id, subject_type, subject_id, permissions, ${inherited})
       VALUES ($1,$2,'team',$3,ARRAY['read'],true) RETURNING id::text`,
        [drive, ancestorId, randomUUID()]
      )
      expect(await provisionUserHome(blocked, { drive, dbPool: database.pool })).toBe('conflict')
      expect(await homeState(database.pool, blocked)).toMatchObject({
        state: 'conflict',
        conflict_code: 'ancestor_grant_conflict',
        drive,
      })
      const stored = await database.pool.query(
        'SELECT conflict_detail FROM gfs_user_homes WHERE user_id = $1',
        [blocked]
      )
      expect(stored.rows[0].conflict_detail).toEqual({
        resourceIds: [ancestorId],
        [table === 'gfs_grants' ? 'grantIds' : 'shareIds']: [offending.rows[0].id],
      })
      const safeDrive = `homes-${randomUUID()}`
      await createDrive(database.pool, safeDrive)
      const safe = await createUser(database.pool, 'Safe User')
      expect(await provisionUserHome(safe, { drive: safeDrive, dbPool: database.pool })).toBe(
        'ready'
      )
      expect(await homeState(database.pool, safe)).toMatchObject({
        state: 'ready',
        drive: safeDrive,
      })
    }
  )

  it('records all offending ancestor grant, share and resource IDs', async () => {
    const blocked = await createUser(database.pool, 'Blocked User')
    const users = await database.pool.query(
      `INSERT INTO gfs_resources (drive, parent_resource_id, name, kind, path_cache)
       VALUES ($1,$2,'Users','directory','/Users') RETURNING resource_id::text`,
      [drive, rootId]
    )
    const usersId = users.rows[0].resource_id
    const grant = await database.pool.query(
      `INSERT INTO gfs_grants (drive, resource_id, subject_type, subject_id, permissions, inherit)
       VALUES ($1,$2,'team',$3,ARRAY['read'],true) RETURNING id::text`,
      [drive, rootId, randomUUID()]
    )
    const share = await database.pool.query(
      `INSERT INTO gfs_shares (drive, resource_id, subject_type, subject_id, permissions, include_descendants)
       VALUES ($1,$2,'user',$3,ARRAY['read'],true) RETURNING id::text`,
      [drive, usersId, randomUUID()]
    )
    expect(await provisionUserHome(blocked, { drive, dbPool: database.pool })).toBe('conflict')
    const stored = await database.pool.query(
      'SELECT conflict_detail FROM gfs_user_homes WHERE user_id = $1',
      [blocked]
    )
    expect(stored.rows[0].conflict_detail).toEqual({
      resourceIds: [rootId, usersId].sort(),
      grantIds: [grant.rows[0].id],
      shareIds: [share.rows[0].id],
    })
    const safeDrive = `homes-${randomUUID()}`
    await createDrive(database.pool, safeDrive)
    const safe = await createUser(database.pool, 'Safe User')
    expect(await provisionUserHome(safe, { drive: safeDrive, dbPool: database.pool })).toBe('ready')
  })

  it('keeps a missing drive pending and succeeds after the drive appears', async () => {
    const user = await createUser(database.pool)
    const missing = `homes-${randomUUID()}`
    expect(await provisionUserHome(user, { drive: missing, dbPool: database.pool })).toBe('pending')
    expect(await homeState(database.pool, user)).toMatchObject({
      state: 'pending',
      last_error: 'drive_not_ready',
      attempts: 1,
    })
    await createDrive(database.pool, missing)
    const worker = new GfsUserHomeReconciler(missing, database.pool)
    await worker.tick()
    expect(await homeState(database.pool, user)).toMatchObject({
      state: 'ready',
      drive: missing,
      attempts: 2,
      last_error: null,
    })
  })

  it.each(['deleted', 'narrowed', 'non-inheriting'] as const)(
    'does not restore a %s owner grant on an already bound home',
    async change => {
      const user = await createUser(database.pool, 'Owner Grant User')
      expect(await provisionUserHome(user, { drive, dbPool: database.pool })).toBe('ready')
      const original = await assertReady(user)
      if (change === 'deleted') {
        await database.pool.query(
          'DELETE FROM gfs_grants WHERE resource_id = $1 AND subject_id = $2',
          [original.resource_id, user]
        )
      } else if (change === 'narrowed') {
        await database.pool.query(
          "UPDATE gfs_grants SET permissions = ARRAY['read'] WHERE resource_id = $1 AND subject_id = $2",
          [original.resource_id, user]
        )
      } else {
        await database.pool.query(
          'UPDATE gfs_grants SET inherit = false WHERE resource_id = $1 AND subject_id = $2',
          [original.resource_id, user]
        )
      }
      await database.pool.query("UPDATE gfs_user_homes SET state = 'pending' WHERE user_id = $1", [
        user,
      ])
      expect(await provisionUserHome(user, { drive, dbPool: database.pool })).toBe('conflict')
      expect(await homeState(database.pool, user)).toMatchObject({
        state: 'conflict',
        conflict_code: 'ownership_conflict',
        resource_id: original.resource_id,
      })
      const grant = await database.pool.query(
        'SELECT permissions, inherit FROM gfs_grants WHERE resource_id = $1 AND subject_id = $2',
        [original.resource_id, user]
      )
      if (change === 'deleted') expect(grant.rows).toEqual([])
      if (change === 'narrowed')
        expect(grant.rows).toEqual([{ permissions: ['read'], inherit: true }])
      if (change === 'non-inheriting') expect(grant.rows[0].inherit).toBe(false)
      const safe = await createUser(database.pool, 'Unaffected User')
      expect(await provisionUserHome(safe, { drive, dbPool: database.pool })).toBe('ready')
      await assertReady(safe)
    }
  )

  it('marks an absent user retired at the S3 boundary while another user provisions', async () => {
    const absent = await createUser(database.pool, 'Absent User')
    await database.pool.query('DELETE FROM users WHERE id = $1', [absent])
    expect(await provisionUserHome(absent, { drive, dbPool: database.pool })).toBe('retired')
    expect(await homeState(database.pool, absent)).toMatchObject({
      state: 'retired',
      drive: null,
      attempts: 1,
    })
    const audits = await database.pool.query(
      'SELECT subject, actor_on_behalf_of, op, gfs_uri, outcome FROM gfs_audit WHERE subject = $1 ORDER BY sequence_no',
      [`user:${absent}`]
    )
    expect(audits.rows).toEqual([
      {
        subject: `user:${absent}`,
        actor_on_behalf_of: 'platform:user-home',
        op: 'user_home.retired',
        gfs_uri: null,
        outcome: 'allowed',
      },
    ])
    const active = await createUser(database.pool, 'Active User')
    expect(await provisionUserHome(active, { drive, dbPool: database.pool })).toBe('ready')
    await assertReady(active)
  })

  it.each(['path_conflict', 'ancestor_grant_conflict', 'ownership_conflict'] as const)(
    'audits and logs %s before clearing it during retirement',
    async code => {
      const user = await createUser(database.pool, 'Retirement Conflict')
      let expectedResource: string | null = null
      if (code === 'path_conflict') {
        const usersId = randomUUID()
        expectedResource = randomUUID()
        await database.pool.query(
          `INSERT INTO gfs_resources (resource_id, drive, parent_resource_id, name, kind, path_cache)
           VALUES ($1,$3,$4,'Users','directory','/Users'),
                  ($2,$3,$1,'retirement-conflict','directory','/Users/retirement-conflict')`,
          [usersId, expectedResource, drive, rootId]
        )
      } else if (code === 'ancestor_grant_conflict') {
        await database.pool.query(
          `INSERT INTO gfs_grants (drive, resource_id, subject_type, subject_id, permissions, inherit)
           VALUES ($1,$2,'team',$3,ARRAY['read'],true)`,
          [drive, rootId, randomUUID()]
        )
      } else {
        expect(await provisionUserHome(user, { drive, dbPool: database.pool })).toBe('ready')
        expectedResource = (await assertReady(user)).resource_id
        await database.pool.query(
          'DELETE FROM gfs_grants WHERE resource_id = $1 AND subject_id = $2',
          [expectedResource, user]
        )
        await database.pool.query(
          "UPDATE gfs_user_homes SET state = 'pending' WHERE user_id = $1",
          [user]
        )
      }

      const logger = rootLogger as unknown as Record<symbol, unknown>
      const streamSymbol = pino.symbols.streamSym
      const oldStream = logger[streamSymbol]
      const oldLevel = rootLogger.level
      const lines: Array<Record<string, unknown>> = []
      logger[streamSymbol] = {
        write: (line: string) => {
          lines.push(JSON.parse(line))
          return true
        },
      }
      rootLogger.level = 'info'
      try {
        expect(await provisionUserHome(user, { drive, dbPool: database.pool })).toBe('conflict')
        const snapshot = await database.pool.query(
          'SELECT conflict_code, conflict_detail FROM gfs_user_homes WHERE user_id = $1',
          [user]
        )
        expect(snapshot.rows[0].conflict_code).toBe(code)
        const detail = snapshot.rows[0].conflict_detail
        await database.pool.query('DELETE FROM users WHERE id = $1', [user])
        const statements: string[] = []
        const transaction: typeof withTransaction = (work, txPool, options) =>
          withTransaction(
            async db =>
              work({
                ...db,
                query: async (sql: string, values?: unknown[]) => {
                  statements.push(sql)
                  return db.query(sql, values)
                },
              } as typeof db),
            txPool,
            options
          )
        expect(await provisionUserHome(user, { drive, dbPool: database.pool, transaction })).toBe(
          'retired'
        )
        const auditsBeforeUpdate = statements.slice(
          0,
          statements.findIndex(sql => sql.includes('UPDATE gfs_user_homes'))
        )
        expect(
          auditsBeforeUpdate.filter(sql => sql.includes('INSERT INTO gfs_audit'))
        ).toHaveLength(2)
        const retired = await database.pool.query(
          'SELECT state, conflict_code, conflict_detail FROM gfs_user_homes WHERE user_id = $1',
          [user]
        )
        expect(retired.rows).toEqual([
          { state: 'retired', conflict_code: null, conflict_detail: null },
        ])

        const events = await database.pool.query(
          `SELECT op, subject, actor_on_behalf_of, gfs_uri, outcome FROM gfs_audit
           WHERE subject = $1 AND op = ANY($2::text[]) ORDER BY sequence_no`,
          [
            `user:${user}`,
            [
              `user_home.conflict.${code}`,
              `user_home.conflict_cleared.${code}`,
              'user_home.retired',
            ],
          ]
        )
        const uri = expectedResource === null ? null : `gfs://${drive}/${expectedResource}`
        expect(events.rows).toEqual(
          [
            `user_home.conflict.${code}`,
            `user_home.conflict_cleared.${code}`,
            'user_home.retired',
          ].map(op => ({
            op,
            subject: `user:${user}`,
            actor_on_behalf_of: 'platform:user-home',
            gfs_uri: uri,
            outcome: 'allowed',
          }))
        )
        expect(
          lines.filter(line => line.event === 'user_home.retired' && line.userId === user)
        ).toEqual([
          expect.objectContaining({
            conflictCode: code,
            conflictDetail: detail,
            transactionState: 'pending_commit',
          }),
        ])
      } finally {
        rootLogger.level = oldLevel
        logger[streamSymbol] = oldStream
      }
    }
  )

  it('keeps malformed conflict detail private and unchanged while a safe user provisions', async () => {
    const user = await createUser(database.pool)
    await database.pool.query(
      `UPDATE gfs_user_homes SET drive = $2, state = 'conflict', conflict_code = 'path_conflict',
       conflict_detail = jsonb_build_object('resourceIds', ARRAY['not-a-resource-id']) WHERE user_id = $1`,
      [user, drive]
    )
    await database.pool.query('DELETE FROM users WHERE id = $1', [user])
    await expect(provisionUserHome(user, { drive, dbPool: database.pool })).rejects.toThrow(
      'Invalid user-home conflict detail'
    )
    expect(await homeState(database.pool, user)).toMatchObject({
      state: 'conflict',
      conflict_code: 'path_conflict',
    })
    const events = await database.pool.query(
      "SELECT op FROM gfs_audit WHERE subject = $1 AND op LIKE 'user_home.%'",
      [`user:${user}`]
    )
    expect(events.rows).toEqual([])
    const safe = await createUser(database.pool, 'Safe User')
    expect(await provisionUserHome(safe, { drive, dbPool: database.pool })).toBe('ready')
    await assertReady(safe)
  })

  it('uses control-api runtime privileges to provision and audit a home', async () => {
    const url = new URL(adminUrl!)
    url.pathname = `/${database.database}`
    const runtimePool = new Pool({
      connectionString: url.toString(),
      options: '-c role=control_api_runtime',
      statement_timeout: 10_000,
    })
    try {
      const identity = await runtimePool.query('SELECT current_user')
      expect(identity.rows[0].current_user).toBe('control_api_runtime')
      const user = await createUser(database.pool, 'Runtime Role User')
      expect(await provisionUserHome(user, { drive, dbPool: runtimePool })).toBe('ready')
      const row = await assertReady(user)
      const audit = await database.pool.query(
        'SELECT op, outcome FROM gfs_audit WHERE gfs_uri = $1 AND op = $2',
        [`gfs://${drive}/${row.resource_id}`, 'user_home.provisioned']
      )
      expect(audit.rows).toEqual([{ op: 'user_home.provisioned', outcome: 'allowed' }])
    } finally {
      await endPoolAndWaitForClients(runtimePool)
    }
  })

  it('re-reads an unknown committed outcome only after taking the user lock', async () => {
    const user = await createUser(database.pool)
    let inject = true
    const statements: string[] = []
    const transaction: typeof withTransaction = async (work, txPool, options) => {
      if (inject) {
        inject = false
        await withTransaction(work, txPool, options)
        options?.onCommitOutcomeUnknown?.()
        throw new Error('commit acknowledgement lost')
      }
      return withTransaction(
        async db =>
          work({
            ...db,
            query: async (sql: string, values?: unknown[]) => {
              statements.push(sql)
              return db.query(sql, values)
            },
          } as typeof db),
        txPool,
        options
      )
    }
    expect(await provisionUserHome(user, { drive, dbPool: database.pool, transaction })).toBe(
      'ready'
    )
    const lockIndex = statements.findIndex(sql => sql.includes('pg_advisory_xact_lock'))
    const readIndex = statements.findIndex(sql => sql.includes('SELECT state FROM gfs_user_homes'))
    expect(lockIndex).toBeGreaterThanOrEqual(0)
    expect(readIndex).toBeGreaterThan(lockIndex)
    await assertReady(user)
  })

  it.each(['committed', 'rolled back'] as const)(
    'accounts for an uncertain outcome only after fencing a transaction that %s',
    async outcome => {
      const user = await createUser(database.pool)
      let first = true
      const transaction: typeof withTransaction = async (work, _txPool, options) => {
        if (!first) throw new Error('simulated fenced reread failure')
        first = false
        if (outcome === 'committed') {
          await withTransaction(work, database.pool)
        } else {
          await expect(
            withTransaction(async db => {
              await work(db)
              throw new Error('simulate rollback')
            }, database.pool)
          ).rejects.toThrow('simulate rollback')
        }
        options?.onCommitOutcomeUnknown?.()
        throw new Error('commit acknowledgement lost')
      }

      expect(await provisionUserHome(user, { drive, dbPool: database.pool, transaction })).toBe(
        'pending'
      )
      const state = await homeState(database.pool, user)
      if (outcome === 'committed') {
        expect(state).toMatchObject({ state: 'ready', attempts: 1, last_error: null })
        expect(await provisionUserHome(user, { drive, dbPool: database.pool })).toBe('unchanged')
      } else {
        expect(state).toMatchObject({
          state: 'pending',
          attempts: 1,
          last_error: 'commit_outcome_pending',
        })
        await new GfsUserHomeReconciler(drive, database.pool).tick()
        expect(await homeState(database.pool, user)).toMatchObject({ state: 'ready', attempts: 2 })
      }
      await assertReady(user)
    }
  )

  it('leaves the outcome pending when the re-read pool is saturated', async () => {
    const user = await createUser(database.pool)
    const url = new URL(adminUrl!)
    url.pathname = `/${database.database}`
    const limitedPool = new Pool({
      connectionString: url.toString(),
      max: 1,
      connectionTimeoutMillis: 250,
      statement_timeout: 10_000,
    })
    const held = await limitedPool.connect()
    let first = true
    const transaction: typeof withTransaction = async (work, txPool, options) => {
      if (!first) return withTransaction(work, txPool, options)
      first = false
      await withTransaction(work, database.pool, options)
      options?.onCommitOutcomeUnknown?.()
      throw new Error('commit acknowledgement lost')
    }
    try {
      expect(await provisionUserHome(user, { drive, dbPool: limitedPool, transaction })).toBe(
        'pending'
      )
    } finally {
      held.release()
      await endPoolAndWaitForClients(limitedPool)
    }
    // The transaction committed; a later fenced attempt sees the existing home.
    expect(await provisionUserHome(user, { drive, dbPool: database.pool })).toBe('unchanged')
    await assertReady(user)
  })

  it('uses the carrier hook after PostgreSQL commits but its acknowledgement is lost', async () => {
    const user = await createUser(database.pool)
    const url = new URL(adminUrl!)
    url.pathname = `/${database.database}`
    const injector = await createPostgresFatalCommitReplyInjector(url.toString())
    const carrierPool = new Pool({
      connectionString: injector.connectionString,
      statement_timeout: 10_000,
    })
    let first = true
    let unknown = 0
    const statements: string[] = []
    const transaction: typeof withTransaction = async (work, txPool, options) => {
      const carrier = first
      first = false
      return withTransaction(
        async db =>
          work(
            carrier
              ? db
              : ({
                  ...db,
                  query: async (sql: string, values?: unknown[]) => {
                    statements.push(sql)
                    return db.query(sql, values)
                  },
                } as typeof db)
          ),
        carrier ? carrierPool : txPool,
        {
          ...options,
          onCommitOutcomeUnknown: () => {
            unknown++
            options?.onCommitOutcomeUnknown?.()
          },
        }
      )
    }
    try {
      const provisioning = provisionUserHome(user, { drive, dbPool: database.pool, transaction })
      const backend = await injector.backendReady
      await injector.commitAckWithheld
      expect(
        (await adminPool.query('SELECT pg_terminate_backend($1) AS terminated', [backend])).rows[0]
          .terminated
      ).toBe(true)
      expect(await provisioning).toBe('ready')
      expect(unknown).toBe(1)
      expect(
        statements.findIndex(sql => sql.includes('pg_advisory_xact_lock'))
      ).toBeGreaterThanOrEqual(0)
      expect(
        statements.findIndex(sql => sql.includes('SELECT state FROM gfs_user_homes'))
      ).toBeGreaterThan(statements.findIndex(sql => sql.includes('pg_advisory_xact_lock')))
      await assertReady(user)
    } finally {
      await endPoolAndWaitForClients(carrierPool)
      await injector.close()
    }
  }, 30_000)

  it('releases an abandoned transaction and retries after a lost COMMIT', async () => {
    const user = await createUser(database.pool)
    const url = new URL(adminUrl!)
    url.pathname = `/${database.database}`
    const proxy = await createPostgresDisconnectBlackhole(url.toString())
    const carrierPool = new Pool({
      connectionString: proxy.connectionString,
      statement_timeout: 10_000,
    })
    let carrierClient: { connection: { stream: { destroy: () => void } } } | undefined
    carrierPool.on('acquire', client => {
      carrierClient = client as unknown as typeof carrierClient
    })
    let backendPid = 0
    let first = true
    let outcome: Awaited<ReturnType<typeof provisionUserHome>> | undefined
    let observed: Awaited<ReturnType<typeof homeState>>
    let locked = true
    let state = ''
    let elapsedMs = 0
    const transaction: typeof withTransaction = async (work, txPool, options) => {
      if (!first) return withTransaction(work, txPool, options)
      first = false
      return withTransaction(
        async db => {
          const result = await work(db)
          const pid = await db.query('SELECT pg_backend_pid() AS pid')
          backendPid = (pid.rows[0] as { pid: number }).pid
          proxy.dropRepliesAndDisconnects()
          setImmediate(() => carrierClient!.connection.stream.destroy())
          return result
        },
        carrierPool,
        options
      )
    }
    try {
      const start = Date.now()
      outcome = await provisionUserHome(user, { drive, dbPool: database.pool, transaction })
      elapsedMs = Date.now() - start
      observed = await homeState(database.pool, user)
      const lock = await database.pool.query(
        "SELECT pg_try_advisory_xact_lock(hashtext('gfs:user-home:' || $1)::bigint) AS acquired",
        [user]
      )
      locked = !lock.rows[0].acquired
      const activity = await database.pool.query(
        'SELECT state FROM pg_stat_activity WHERE pid = $1',
        [backendPid]
      )
      state = activity.rows[0]?.state
    } finally {
      if (backendPid) await adminPool.query('SELECT pg_terminate_backend($1)', [backendPid])
      await proxy.close()
      await endPoolAndWaitForClients(carrierPool)
    }
    expect(await provisionUserHome(user, { drive, dbPool: database.pool })).toBe('unchanged')
    await assertReady(user)
    expect(outcome).toBe('ready')
    expect(elapsedMs).toBeGreaterThanOrEqual(7_000)
    expect(locked).toBe(false)
    expect(state).toBeUndefined()
    expect(observed).toMatchObject({ state: 'ready', attempts: 1 })
  }, 30_000)

  it('keeps an uncertain attempt pending without duplicates and converges on the next tick', async () => {
    const user = await createUser(database.pool)
    const url = new URL(adminUrl!)
    url.pathname = `/${database.database}`
    const proxy = await createPostgresDisconnectBlackhole(url.toString())
    const carrierPool = new Pool({
      connectionString: proxy.connectionString,
      statement_timeout: 10_000,
    })
    const limitedPool = new Pool({
      connectionString: url.toString(),
      max: 1,
      connectionTimeoutMillis: 250,
      statement_timeout: 10_000,
    })
    const held = await limitedPool.connect()
    let released = false
    let carrierClient: { connection: { stream: { destroy: () => void } } } | undefined
    carrierPool.on('acquire', client => {
      carrierClient = client as unknown as typeof carrierClient
    })
    let backendPid = 0
    let first = true
    const logger = rootLogger as unknown as Record<symbol, unknown>
    const streamSymbol = pino.symbols.streamSym
    const oldStream = logger[streamSymbol]
    const oldLevel = rootLogger.level
    const lines: Array<Record<string, unknown>> = []
    logger[streamSymbol] = {
      write: (line: string) => {
        lines.push(JSON.parse(line))
        return true
      },
    }
    rootLogger.level = 'error'
    const transaction: typeof withTransaction = async (work, txPool, options) => {
      if (!first) return withTransaction(work, txPool, options)
      first = false
      return withTransaction(
        async db => {
          const result = await work(db)
          const pid = await db.query('SELECT pg_backend_pid() AS pid')
          backendPid = (pid.rows[0] as { pid: number }).pid
          proxy.dropRepliesAndDisconnects()
          setImmediate(() => carrierClient!.connection.stream.destroy())
          return result
        },
        carrierPool,
        options
      )
    }
    try {
      expect(await provisionUserHome(user, { drive, dbPool: limitedPool, transaction })).toBe(
        'pending'
      )
      expect(lines.filter(line => line.level === 50)).toEqual([
        expect.objectContaining({
          event: 'user_home_attempt_record_failed',
          userId: user,
          attemptOutcome: 'commit_outcome_pending',
          errorClass: 'Error',
        }),
      ])
      held.release()
      released = true
      await database.pool.query(
        "SELECT pg_advisory_xact_lock(hashtext('gfs:user-home:' || $1)::bigint)",
        [user]
      )
      const observed = await homeState(database.pool, user)
      expect(observed).toMatchObject({ state: 'pending', resource_id: null })
      const before = await database.pool.query(
        "SELECT count(*)::int AS count FROM gfs_grants WHERE subject_type = 'user' AND subject_id = $1",
        [user]
      )
      expect(before.rows[0].count).toBe(0)
      const worker = new GfsUserHomeReconciler(drive, database.pool)
      await worker.tick()
      const ready = await assertReady(user)
      const counts = await database.pool.query(
        `SELECT (SELECT count(*)::int FROM gfs_resources
                  WHERE drive = $3 AND parent_resource_id = (SELECT parent_resource_id FROM gfs_resources WHERE resource_id = $1::uuid)
                    AND name = (SELECT storage_username FROM gfs_user_homes WHERE user_id = $2::uuid) AND deleted_at IS NULL) AS resources,
                (SELECT count(*)::int FROM gfs_grants WHERE resource_id = $1::uuid AND subject_type = 'user' AND subject_id = $2::text) AS grants`,
        [ready.resource_id, user, drive]
      )
      expect(counts.rows).toEqual([{ resources: 1, grants: 1 }])
    } finally {
      rootLogger.level = oldLevel
      logger[streamSymbol] = oldStream
      if (!released) held.release()
      if (backendPid) await adminPool.query('SELECT pg_terminate_backend($1)', [backendPid])
      await proxy.close()
      await endPoolAndWaitForClients(carrierPool)
      await endPoolAndWaitForClients(limitedPool)
    }
  }, 30_000)
})
