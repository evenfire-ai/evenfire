import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Client, Pool, type PoolClient } from 'pg'
import { initDb } from '../src/db.js'
import { DbSeedResourceStore, seedRootDirectories } from '../src/gfs/seedResources.js'
import { applyResourcePatch } from '../src/routes/gfs/resources.js'
import {
  GFS_RESOURCE_CHANGED_CHANNEL,
  type ResourceChanged,
  parseResourceChanged,
} from '../src/services/gfsWatch/notifySchemas.js'
import { applyGfsResourceChangedSchema } from '../src/services/gfsWatch/resourceChangedSchema.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'
import './realPostgres.requirement.ts'

// Every payload asserted here is emitted by the real trigger installed by the
// real migrations, in response to a real writer committing. Nothing is built
// by hand. The expected value of each notification is read back from the row
// with SQL, independently of the TypeScript normalizers under test.
//
// The control-api writers (root seeding, rename/move PATCH) are called
// directly. gfsc's writers live in another package; the content update, soft
// delete and file insert below issue the same statements as
// gfs-controller/src/db/writeStore.ts. Nothing in production issues a hard
// DELETE; it is exercised because the trigger has a DELETE branch.

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

const FENCE_CHANNEL = 'gfs_watch_test_fence'

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

type RowIdentity = { rid32: string; parent: string | null }

const operatorCaller = {
  isOperator: true,
  subjects: new Set(['operator:']),
  actorKey: 'operator:',
}
const noAudit = async () => {}

const byIdentity = (a: ResourceChanged, b: ResourceChanged) =>
  `${a.rid32}${a.op}${a.h}${a.a}`.localeCompare(`${b.rid32}${b.op}${b.h}${b.a}`)

describeRealPostgres('gfs_resource_changed trigger against real writers', () => {
  const database = `control_api_gfs_watch_trigger_${randomBytes(6).toString('hex')}`
  let adminPool: Pool
  let pool: Pool
  let listener: Client
  const received: { channel: string; payload: string | undefined }[] = []

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
    const connectionString = databaseUrl(adminUrl!, database)
    pool = new Pool({ connectionString })
    await initDb({ connect: () => pool.connect() })
    listener = new Client({ connectionString })
    listener.on('error', () => {})
    await listener.connect()
    listener.on('notification', message => {
      received.push({ channel: message.channel, payload: message.payload })
    })
    await listener.query(`LISTEN ${GFS_RESOURCE_CHANGED_CHANNEL}`)
    await listener.query(`LISTEN ${FENCE_CHANNEL}`)
  })

  afterAll(async () => {
    try {
      await listener?.end().catch(() => {})
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

  async function inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
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

  /** Commits a fence NOTIFY and returns the index just past its arrival. */
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
   * Notifications of `write`, exactly. A listener receives notifications in
   * commit order, so a fence committed before the write flushes everything
   * earlier setup committed, and a fence after it closes the window.
   */
  async function notificationsOf(write: () => Promise<void>): Promise<string[]> {
    const start = await fence()
    await write()
    const end = await fence()
    return received
      .slice(start, end)
      .filter(n => n.channel === GFS_RESOURCE_CHANGED_CHANNEL)
      .map(n => n.payload ?? '')
  }

  function parseAll(payloads: string[]): ResourceChanged[] {
    const parsed = payloads.map(payload => parseResourceChanged(payload))
    expect(parsed, `payloads: ${JSON.stringify(payloads)}`).not.toContain(null)
    return (parsed as ResourceChanged[]).sort(byIdentity)
  }

  async function identity(resourceId: string): Promise<RowIdentity> {
    const result = await pool.query<{ rid32: string; parent: string | null }>(
      `SELECT replace(resource_id::text, '-', '') AS rid32,
              replace(parent_resource_id::text, '-', '') AS parent
         FROM gfs_resources WHERE resource_id = $1::uuid`,
      [resourceId]
    )
    return result.rows[0]!
  }

  async function seed(drive: string, paths: string[]) {
    return inTransaction(client =>
      seedRootDirectories(new DbSeedResourceStore(client), drive, paths)
    )
  }

  async function insertFile(drive: string, parentId: string, name: string): Promise<string> {
    const resourceId = randomUUID()
    await inTransaction(client =>
      client.query(
        `INSERT INTO gfs_resources
           (resource_id, drive, parent_resource_id, name, kind, path_cache,
            version, bytes, blob_key, content_sha256)
         VALUES ($1, $2, $3, $4, 'file', $5, 0, $6, NULL, NULL)`,
        [resourceId, drive, parentId, name, `/${name}`, 0]
      )
    )
    return resourceId
  }

  const change = (
    row: RowIdentity,
    fields: Pick<ResourceChanged, 'h' | 'a' | 'op'> & {
      oldParent: string | null
      newParent: string | null
    }
  ): ResourceChanged => ({ rid32: row.rid32, ...fields }) as ResourceChanged

  it('installs the trigger function with a pinned search_path and no PUBLIC execute', async () => {
    const fn = await pool.query<{ config: string[] | null; public_execute: boolean }>(
      `SELECT procedure.proconfig AS config,
              EXISTS (
                SELECT 1 FROM aclexplode(coalesce(procedure.proacl, acldefault('f', procedure.proowner))) acl
                 WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
              ) AS public_execute
         FROM pg_proc procedure
         JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
        WHERE namespace.nspname = 'public' AND procedure.proname = 'gfs_resource_changed_notify'`
    )
    expect(fn.rows).toHaveLength(1)
    expect(fn.rows[0]!.config).toEqual(['search_path=pg_catalog, public, pg_temp'])
    expect(fn.rows[0]!.public_execute).toBe(false)
    const migration = await pool.query(
      `SELECT 1 FROM schema_migrations WHERE version = '0139_gfs_resource_changed_notify'`
    )
    expect(migration.rowCount).toBe(1)

    // Re-applying replaces the trigger in place instead of failing or adding a second one.
    await applyGfsResourceChangedSchema(pool)
    const triggers = await pool.query(
      `SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'gfs_resources'::regclass AND tgname = 'gfs_resource_changed_notify'`
    )
    expect(triggers.rowCount).toBe(1)
  })

  it('emits one parseable payload per inserted root and child, equal to the row', async () => {
    const drive = `watch-${randomUUID()}`
    let seeded: Awaited<ReturnType<typeof seed>> | undefined
    const payloads = await notificationsOf(async () => {
      seeded = await seed(drive, ['/org', '/org/team'])
    })
    const root = await identity(seeded!.rootResourceId)
    const org = await identity(seeded!.byPath['/org']!)
    const team = await identity(seeded!.byPath['/org/team']!)
    expect(root.parent).toBeNull()

    expect(parseAll(payloads)).toEqual(
      [
        change(root, { oldParent: null, newParent: null, h: 1, a: 0, op: 'i' }),
        change(org, { oldParent: null, newParent: root.rid32, h: 1, a: 0, op: 'i' }),
        change(team, { oldParent: null, newParent: org.rid32, h: 1, a: 0, op: 'i' }),
      ].sort(byIdentity)
    )
  })

  it('marks a rename as listing-visible without an ancestry change', async () => {
    const drive = `watch-${randomUUID()}`
    const seeded = await seed(drive, ['/org/team'])
    const teamId = seeded.byPath['/org/team']!
    const team = await identity(teamId)

    const payloads = await notificationsOf(async () => {
      await inTransaction(client =>
        applyResourcePatch(client, operatorCaller, drive, teamId, { newName: 'renamed' }, noAudit)
      )
    })

    // The PATCH renames the row, then rewrites its path_cache: two row writes.
    expect(parseAll(payloads)).toEqual(
      [
        change(team, { oldParent: team.parent, newParent: team.parent, h: 1, a: 0, op: 'u' }),
        change(team, { oldParent: team.parent, newParent: team.parent, h: 0, a: 0, op: 'u' }),
      ].sort(byIdentity)
    )
  })

  it('marks a move as an ancestry change with both parents, and its subtree path refresh', async () => {
    const drive = `watch-${randomUUID()}`
    const seeded = await seed(drive, ['/org/team/project', '/org/team/project/leaf', '/org/other'])
    const projectId = seeded.byPath['/org/team/project']!
    const otherId = seeded.byPath['/org/other']!
    const before = await identity(projectId)
    const leaf = await identity(seeded.byPath['/org/team/project/leaf']!)

    const payloads = await notificationsOf(async () => {
      await inTransaction(client =>
        applyResourcePatch(
          client,
          operatorCaller,
          drive,
          projectId,
          { newParentId: otherId },
          noAudit
        )
      )
    })
    const after = await identity(projectId)
    expect(after.parent).toBe((await identity(otherId)).rid32)
    expect(after.parent).not.toBe(before.parent)

    expect(parseAll(payloads)).toEqual(
      [
        change(before, { oldParent: before.parent, newParent: after.parent, h: 1, a: 1, op: 'u' }),
        change(before, { oldParent: after.parent, newParent: after.parent, h: 0, a: 0, op: 'u' }),
        change(leaf, { oldParent: leaf.parent, newParent: leaf.parent, h: 0, a: 0, op: 'u' }),
      ].sort(byIdentity)
    )
  })

  it('covers gfsc content updates, soft deletes and a hard DELETE of a child and a root', async () => {
    const drive = `watch-${randomUUID()}`
    const seeded = await seed(drive, ['/org'])
    const orgId = seeded.byPath['/org']!
    const fileId = await insertFile(drive, orgId, 'report.md')
    const file = await identity(fileId)

    const contentPayloads = await notificationsOf(async () => {
      await inTransaction(client =>
        client.query(
          `UPDATE gfs_resources
              SET version = version + 1, bytes = $3, blob_key = NULL,
                  content_sha256 = NULL, updated_at = now()
            WHERE drive = $1 AND resource_id = $2 AND deleted_at IS NULL`,
          [drive, fileId, 42]
        )
      )
    })
    expect(parseAll(contentPayloads)).toEqual([
      change(file, { oldParent: file.parent, newParent: file.parent, h: 0, a: 0, op: 'u' }),
    ])

    const softDeletePayloads = await notificationsOf(async () => {
      await inTransaction(client =>
        client.query(
          `UPDATE gfs_resources SET deleted_at = now(), updated_at = now()
            WHERE drive = $1 AND resource_id = $2 AND deleted_at IS NULL`,
          [drive, fileId]
        )
      )
    })
    expect(parseAll(softDeletePayloads)).toEqual([
      change(file, { oldParent: file.parent, newParent: file.parent, h: 1, a: 1, op: 'u' }),
    ])

    const childDeletePayloads = await notificationsOf(async () => {
      await inTransaction(client =>
        client.query('DELETE FROM gfs_resources WHERE resource_id = $1', [fileId])
      )
    })
    expect(parseAll(childDeletePayloads)).toEqual([
      change(file, { oldParent: file.parent, newParent: null, h: 1, a: 1, op: 'd' }),
    ])

    const root = await identity(seeded.rootResourceId)
    const org = await identity(orgId)
    const treeDeletePayloads = await notificationsOf(async () => {
      await inTransaction(async client => {
        await client.query('DELETE FROM gfs_resources WHERE resource_id = $1', [orgId])
        await client.query('DELETE FROM gfs_resources WHERE resource_id = $1', [
          seeded.rootResourceId,
        ])
      })
    })
    expect(parseAll(treeDeletePayloads)).toEqual(
      [
        change(org, { oldParent: root.rid32, newParent: null, h: 1, a: 1, op: 'd' }),
        change(root, { oldParent: null, newParent: null, h: 1, a: 1, op: 'd' }),
      ].sort(byIdentity)
    )
  })

  it('never aborts a write with boundary values and only notifies on commit', async () => {
    const longDrive = `watch-${'d'.repeat(4000)}-${randomUUID()}`
    const longName = 'n'.repeat(10_000)
    const resourceId = randomUUID()

    const insertPayloads = await notificationsOf(async () => {
      await inTransaction(client =>
        client.query(
          `INSERT INTO gfs_resources
             (resource_id, drive, parent_resource_id, name, kind, path_cache, bytes)
           VALUES ($1, $2, NULL, $3, 'directory', NULL, 9223372036854775807)`,
          [resourceId, longDrive, longName]
        )
      )
    })
    const row = await identity(resourceId)
    expect(parseAll(insertPayloads)).toEqual([
      change(row, { oldParent: null, newParent: null, h: 1, a: 0, op: 'i' }),
    ])

    const noopPayloads = await notificationsOf(async () => {
      await inTransaction(client =>
        client.query('UPDATE gfs_resources SET updated_at = updated_at WHERE resource_id = $1', [
          resourceId,
        ])
      )
    })
    expect(parseAll(noopPayloads)).toEqual([
      change(row, { oldParent: null, newParent: null, h: 0, a: 0, op: 'u' }),
    ])

    const rolledBack = await notificationsOf(async () => {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(`UPDATE gfs_resources SET name = 'x' WHERE resource_id = $1`, [
          resourceId,
        ])
        await client.query('ROLLBACK')
      } finally {
        client.release()
      }
    })
    expect(rolledBack).toEqual([])
  })

  // No production writer restores a row or changes its kind today; both are
  // branches of the trigger and are pinned so a future writer inherits them.
  it('marks a restore as an ancestry change and a kind change as listing-only', async () => {
    const drive = `watch-${randomUUID()}`
    const seeded = await seed(drive, ['/org'])
    const fileId = await insertFile(drive, seeded.byPath['/org']!, 'restored.md')
    const file = await identity(fileId)
    await inTransaction(client =>
      client.query(`UPDATE gfs_resources SET deleted_at = now() WHERE resource_id = $1`, [fileId])
    )

    const restorePayloads = await notificationsOf(async () => {
      await inTransaction(client =>
        client.query(
          `UPDATE gfs_resources SET deleted_at = NULL, updated_at = now() WHERE resource_id = $1`,
          [fileId]
        )
      )
    })
    expect(parseAll(restorePayloads)).toEqual([
      change(file, { oldParent: file.parent, newParent: file.parent, h: 1, a: 1, op: 'u' }),
    ])

    const kindPayloads = await notificationsOf(async () => {
      await inTransaction(client =>
        client.query(`UPDATE gfs_resources SET kind = 'directory' WHERE resource_id = $1`, [fileId])
      )
    })
    expect(parseAll(kindPayloads)).toEqual([
      change(file, { oldParent: file.parent, newParent: file.parent, h: 1, a: 0, op: 'u' }),
    ])
  })

  it('fires for the gfsc writer role, which does not own the function and cannot execute it', async () => {
    const privilege = await pool.query<{ owner: string; can_execute: boolean }>(
      `SELECT pg_get_userbyid(proowner) AS owner,
              has_function_privilege('gfs_controller', oid, 'EXECUTE') AS can_execute
         FROM pg_proc WHERE proname = 'gfs_resource_changed_notify'`
    )
    expect(privilege.rows).toHaveLength(1)
    expect(privilege.rows[0]!.owner).not.toBe('gfs_controller')
    expect(privilege.rows[0]!.can_execute).toBe(false)

    const drive = `watch-${randomUUID()}`
    const seeded = await seed(drive, ['/org'])
    const parentId = seeded.byPath['/org']!
    const fileId = randomUUID()

    const payloads = await notificationsOf(async () => {
      await inTransaction(async client => {
        await client.query('SET LOCAL ROLE gfs_controller')
        const role = await client.query<{ current_user: string }>('SELECT current_user')
        expect(role.rows[0]!.current_user).toBe('gfs_controller')
        await client.query(
          `INSERT INTO gfs_resources (resource_id, drive, parent_resource_id, name, kind, path_cache)
           VALUES ($1, $2, $3, 'by-gfsc.md', 'file', '/org/by-gfsc.md')`,
          [fileId, drive, parentId]
        )
        await client.query(
          `UPDATE gfs_resources SET deleted_at = now(), updated_at = now()
            WHERE drive = $1 AND resource_id = $2 AND deleted_at IS NULL`,
          [drive, fileId]
        )
      })
    })
    const file = await identity(fileId)
    expect(parseAll(payloads)).toEqual(
      [
        change(file, { oldParent: null, newParent: file.parent, h: 1, a: 0, op: 'i' }),
        change(file, { oldParent: file.parent, newParent: file.parent, h: 1, a: 1, op: 'u' }),
      ].sort(byIdentity)
    )
  })
})
