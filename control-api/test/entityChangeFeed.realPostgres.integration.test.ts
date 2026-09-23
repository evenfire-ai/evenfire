import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { initDb } from '../src/db.js'
import './realPostgres.requirement.ts'

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

describeRealPostgres('entity change feed real PostgreSQL contract', () => {
  const database = `control_api_entity_change_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  let adminPool: Pool
  let instancePool: Pool
  let replicaPool: Pool

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
    instancePool = new Pool({ connectionString })
    replicaPool = new Pool({ connectionString })
    await initDb({ connect: () => instancePool.connect() })
  })

  beforeEach(async () => {
    await instancePool.query('SELECT * FROM entity_change_dispatch_batch(1000, 86400)')
  })

  afterAll(async () => {
    await instancePool?.end()
    await replicaPool?.end()
    if (adminPool) {
      await adminPool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [database]
      )
      await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)}`)
      await adminPool.end()
    }
  })

  it('captures committed create, replace, rename/move, delete, grant, and membership changes', async () => {
    const client = await instancePool.connect()
    const drive = `entity-change-${randomUUID()}`
    const rootId = randomUUID()
    const parentId = randomUUID()
    const movedParentId = randomUUID()
    const fileId = randomUUID()
    const userId = randomUUID()
    const teamId = randomUUID()
    try {
      await client.query('BEGIN')
      await client.query('SET ROLE gfs_controller')
      await client.query(
        `INSERT INTO gfs_resources (resource_id, drive, name, kind, path_cache)
         VALUES ($1, $2, '/', 'directory', '/')`,
        [rootId, drive]
      )
      await client.query(
        `INSERT INTO gfs_resources (resource_id, drive, parent_resource_id, name, kind, path_cache)
         VALUES ($1, $2, $3, 'parent', 'directory', '/parent')`,
        [parentId, drive, rootId]
      )
      await client.query(
        `INSERT INTO gfs_resources (resource_id, drive, parent_resource_id, name, kind, path_cache)
         VALUES ($1, $2, $3, 'destination', 'directory', '/destination')`,
        [movedParentId, drive, rootId]
      )
      await client.query(
        `INSERT INTO gfs_resources (resource_id, drive, parent_resource_id, name, kind, path_cache)
         VALUES ($1, $2, $3, 'draft.md', 'file', '/parent/draft.md')`,
        [fileId, drive, parentId]
      )
      await client.query('RESET ROLE')
      await client.query('SET ROLE control_api_runtime')
      await client.query(
        `INSERT INTO gfs_grants (drive, resource_id, subject_type, subject_id, permissions)
         VALUES ($1, $2, 'team', $3, ARRAY['read'])`,
        [drive, fileId, teamId]
      )
      await client.query(
        `INSERT INTO gfs_shares (drive, resource_id, subject_type, subject_id, permissions)
         VALUES ($1, $2, 'user', $3, ARRAY['read'])`,
        [drive, fileId, userId]
      )
      await client.query('RESET ROLE')
      await client.query('COMMIT')

      const created = await instancePool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM entity_change_outbox WHERE scope = 'gfs'`
      )
      expect(Number(created.rows[0]?.count)).toBe(4)

      await client.query('BEGIN')
      await client.query('SET ROLE control_api_runtime')
      await client.query(
        `UPDATE gfs_resources SET version = version + 1, bytes = 45 WHERE resource_id = $1`,
        [fileId]
      )
      await client.query(
        `UPDATE gfs_resources SET parent_resource_id = $2, name = 'renamed.md',
          path_cache = '/destination/renamed.md' WHERE resource_id = $1`,
        [fileId, movedParentId]
      )
      await client.query('RESET ROLE')
      await client.query('SET ROLE gfs_controller')
      await client.query(
        `UPDATE gfs_resources SET deleted_at = clock_timestamp() WHERE resource_id = $1`,
        [fileId]
      )
      await client.query('RESET ROLE')
      await client.query('COMMIT')

      await client.query('BEGIN')
      await client.query('SET ROLE control_api_runtime')
      await client.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [
        userId,
        `${userId}@entity-change.invalid`,
      ])
      await client.query('INSERT INTO teams (id, name) VALUES ($1, $2)', [teamId, teamId])
      await client.query(
        `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`,
        [teamId, userId]
      )
      await client.query('DELETE FROM team_members WHERE team_id = $1 AND user_id = $2', [
        teamId,
        userId,
      ])
      await client.query('DELETE FROM gfs_grants WHERE drive = $1 AND resource_id = $2', [
        drive,
        fileId,
      ])
      await client.query('DELETE FROM gfs_shares WHERE drive = $1 AND resource_id = $2', [
        drive,
        fileId,
      ])
      await client.query('RESET ROLE')
      await client.query('COMMIT')

      const outbox = await instancePool.query<{ scope: string; entity_id: string | null }>(
        'SELECT scope, entity_id FROM entity_change_outbox ORDER BY id'
      )
      expect(outbox.rows.filter(row => row.scope === 'gfs')).toHaveLength(7)
      expect(outbox.rows.filter(row => row.entity_id === fileId)).toHaveLength(4)
      expect(outbox.rows.filter(row => row.scope === 'authorization')).toHaveLength(7)
      // Event evidence contains no file content, path, or authorization subject.
      expect(JSON.stringify(outbox.rows)).not.toContain('draft.md')
      expect(JSON.stringify(outbox.rows)).not.toContain(userId)
      expect(JSON.stringify(outbox.rows)).not.toContain(teamId)
    } finally {
      client.release()
    }
  })

  it('rolls capture back with the producer transaction and publishes only committed facts', async () => {
    const client = await instancePool.connect()
    const drive = `entity-change-rollback-${randomUUID()}`
    try {
      const before = await instancePool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM entity_change_outbox'
      )
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO gfs_resources (drive, name, kind) VALUES ($1, 'rolled-back', 'file')`,
        [drive]
      )
      await client.query('ROLLBACK')
      const after = await instancePool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM entity_change_outbox'
      )
      expect(after.rows[0]?.count).toBe(before.rows[0]?.count)

      await instancePool.query(
        `INSERT INTO gfs_resources (drive, name, kind) VALUES ($1, 'committed', 'file')`,
        [drive]
      )
      const firstDispatch = await instancePool.query<{ feed_sequence: string }>(
        'SELECT feed_sequence FROM entity_change_dispatch_batch(1000, 86400)'
      )
      const feedAfterFirst = await instancePool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM entity_change_feed'
      )
      const duplicateDispatch = await instancePool.query<{ feed_sequence: string }>(
        'SELECT feed_sequence FROM entity_change_dispatch_batch(1000, 86400)'
      )
      const feedAfterDuplicate = await instancePool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM entity_change_feed'
      )
      expect(firstDispatch.rows).toHaveLength(1)
      expect(duplicateDispatch.rows).toHaveLength(0)
      expect(feedAfterDuplicate.rows[0]?.count).toBe(feedAfterFirst.rows[0]?.count)
    } finally {
      client.release()
    }
  })

  it('uses dispatcher order rather than identity allocation as public sequence order', async () => {
    const pending = await instancePool.connect()
    const earlyDrive = `entity-change-early-${randomUUID()}`
    try {
      await pending.query('BEGIN')
      await pending.query(
        `INSERT INTO gfs_resources (drive, name, kind) VALUES ($1, 'early', 'file')`,
        [earlyDrive]
      )
      const pendingId = await pending.query<{ id: string }>(
        `SELECT max(id)::text AS id FROM entity_change_outbox WHERE entity_id IS NOT NULL`
      )
      const watermarkBefore = await instancePool.query<{ sequence: string }>(
        'SELECT sequence::text FROM entity_change_watermark WHERE singleton = true'
      )
      const userId = randomUUID()
      const teamId = randomUUID()
      await instancePool.query('INSERT INTO users (id, email) VALUES ($1, $2)', [
        userId,
        `${userId}@ordering.invalid`,
      ])
      await instancePool.query('INSERT INTO teams (id, name) VALUES ($1, $2)', [teamId, teamId])
      await instancePool.query(
        `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`,
        [teamId, userId]
      )
      const committedMax = await instancePool.query<{ id: string }>(
        'SELECT max(id)::text AS id FROM entity_change_outbox'
      )
      expect(Number(pendingId.rows[0]?.id)).toBeLessThan(Number(committedMax.rows[0]?.id))
      await instancePool.query('SELECT * FROM entity_change_dispatch_batch(1000, 86400)')
      const firstFeed = await instancePool.query<{ sequence: string; scope: string }>(
        `SELECT sequence::text, scope FROM entity_change_feed
          WHERE sequence > $1 ORDER BY sequence`,
        [watermarkBefore.rows[0]?.sequence]
      )
      expect(firstFeed.rows.map(row => row.scope)).toEqual(['authorization'])
      await pending.query('COMMIT')
      await replicaPool.query('SELECT * FROM entity_change_dispatch_batch(1000, 86400)')
      const feed = await instancePool.query<{ sequence: string; scope: string }>(
        `SELECT sequence::text, scope FROM entity_change_feed
          WHERE sequence > $1 ORDER BY sequence`,
        [watermarkBefore.rows[0]?.sequence]
      )
      expect(feed.rows.map(row => row.scope)).toEqual(['authorization', 'gfs'])
      expect(feed.rows.map(row => Number(row.sequence))).toEqual([
        Number(watermarkBefore.rows[0]?.sequence) + 1,
        Number(watermarkBefore.rows[0]?.sequence) + 2,
      ])
    } finally {
      await pending.query('ROLLBACK').catch(() => undefined)
      pending.release()
    }
  })

  it('keeps checkpoint scopes and cursor on one committed watermark snapshot', async () => {
    const drive = `entity-change-checkpoint-lock-${randomUUID()}`
    await instancePool.query(
      `INSERT INTO gfs_resources (drive, name, kind) VALUES ($1, 'checkpoint-lock', 'file')`,
      [drive]
    )
    const baseline = await instancePool.query<{ current_cursor: string }>(
      'SELECT current_cursor::text FROM entity_change_watermark WHERE singleton = true'
    )
    await instancePool.query(
      `INSERT INTO gfs_resources (drive, name, kind) VALUES ($1, 'pending-change', 'file')`,
      [`${drive}-pending`]
    )

    const dispatcher = await instancePool.connect()
    const reader = await replicaPool.connect()
    let checkpointPending: Promise<{
      rows: Array<{
        needs_resync: boolean
        current_cursor: string
        invalidated_scopes: string[]
      }>
    }> | null = null
    try {
      await dispatcher.query('BEGIN')
      await dispatcher.query(
        'SELECT sequence FROM entity_change_watermark WHERE singleton = true FOR UPDATE'
      )
      const readerPid = await reader.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      let settled = false
      checkpointPending = reader
        .query<{
          needs_resync: boolean
          current_cursor: string
          invalidated_scopes: string[]
        }>('SELECT * FROM entity_change_read_checkpoint($1::uuid, $2)', [
          baseline.rows[0]?.current_cursor,
          10000,
        ])
        .then(result => {
          settled = true
          return result
        })

      let waitingOnWatermark = false
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const activity = await adminPool.query<{ wait_event_type: string | null }>(
          'SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1',
          [readerPid.rows[0]?.pid]
        )
        if (activity.rows[0]?.wait_event_type === 'Lock') {
          waitingOnWatermark = true
          break
        }
        if (settled) break
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      expect(waitingOnWatermark).toBe(true)
      expect(settled).toBe(false)

      await dispatcher.query('SELECT * FROM entity_change_dispatch_batch(1000, 86400)')
      await dispatcher.query('COMMIT')
      const checkpoint = await checkpointPending
      expect(checkpoint.rows[0]?.needs_resync).toBe(false)
      expect(checkpoint.rows[0]?.invalidated_scopes).toEqual(['gfs'])
      const watermark = await instancePool.query<{ current_cursor: string }>(
        'SELECT current_cursor::text FROM entity_change_watermark WHERE singleton = true'
      )
      expect(checkpoint.rows[0]?.current_cursor).toBe(watermark.rows[0]?.current_cursor)
    } finally {
      await dispatcher.query('ROLLBACK').catch(() => undefined)
      await checkpointPending?.catch(() => undefined)
      dispatcher.release()
      reader.release()
    }
  })

  it('recovers missed wakeups and expired cursors with a coarse authorized checkpoint', async () => {
    const resource = await instancePool.query<{ resource_id: string }>(
      `INSERT INTO gfs_resources (drive, name, kind) VALUES ($1, 'checkpoint', 'file')
       RETURNING resource_id`,
      [`entity-change-checkpoint-${randomUUID()}`]
    )
    await instancePool.query('SELECT * FROM entity_change_dispatch_batch(1000, 86400)')
    const lastEvent = await instancePool.query<{ cursor: string; sequence: string }>(
      'SELECT cursor::text, sequence::text FROM entity_change_feed ORDER BY sequence DESC LIMIT 1'
    )
    // No listener is involved here: the durable query is the fallback after a missed NOTIFY.
    const recovery = await instancePool.query<{
      needs_resync: boolean
      invalidated_scopes: string[]
    }>('SELECT * FROM entity_change_read_checkpoint($1::uuid, $2)', [
      lastEvent.rows[0]?.cursor,
      10000,
    ])
    expect(recovery.rows[0]?.needs_resync).toBe(false)

    await instancePool.query(
      `UPDATE entity_change_feed SET created_at = clock_timestamp() - interval '2 days'
        WHERE sequence = $1`,
      [lastEvent.rows[0]?.sequence]
    )
    await instancePool.query('SELECT * FROM entity_change_dispatch_batch(1000, 86400)')
    const expired = await instancePool.query<{
      needs_resync: boolean
      invalidated_scopes: string[]
    }>('SELECT * FROM entity_change_read_checkpoint($1::uuid, $2)', [
      lastEvent.rows[0]?.cursor,
      10000,
    ])
    expect(expired.rows[0]?.needs_resync).toBe(true)
    expect(expired.rows[0]?.invalidated_scopes).toEqual(['gfs', 'authorization'])
    expect(JSON.stringify(expired.rows)).not.toContain(resource.rows[0]?.resource_id)
  })

  it('coalesces latest-state invalidations and keeps feed storage behind the runtime boundary', async () => {
    const inserted = await instancePool.query<{ resource_id: string }>(
      `INSERT INTO gfs_resources (drive, name, kind) VALUES ($1, 'many-updates', 'file')
       RETURNING resource_id`,
      [`entity-change-coalesce-${randomUUID()}`]
    )
    const resourceId = inserted.rows[0]?.resource_id
    await instancePool.query(
      'UPDATE gfs_resources SET version = version + 1 WHERE resource_id = $1',
      [resourceId]
    )
    await instancePool.query(
      'UPDATE gfs_resources SET version = version + 1 WHERE resource_id = $1',
      [resourceId]
    )
    const before = await instancePool.query<{ sequence: string }>(
      'SELECT sequence::text FROM entity_change_watermark WHERE singleton = true'
    )
    await Promise.all([
      instancePool.query('SELECT * FROM entity_change_dispatch_batch(1000, 86400)'),
      replicaPool.query('SELECT * FROM entity_change_dispatch_batch(1000, 86400)'),
    ])
    const after = await instancePool.query<{ sequence: string }>(
      'SELECT sequence::text FROM entity_change_watermark WHERE singleton = true'
    )
    const published = await instancePool.query<{ scope: string; count: string }>(
      `SELECT scope, count(*)::text AS count FROM entity_change_feed
        WHERE sequence > $1 GROUP BY scope`,
      [before.rows[0]?.sequence]
    )
    expect(Number(after.rows[0]?.sequence) - Number(before.rows[0]?.sequence)).toBe(1)
    expect(published.rows).toEqual([{ scope: 'gfs', count: '1' }])

    const restricted = await instancePool.connect()
    try {
      await restricted.query('SET ROLE control_api_runtime')
      await expect(restricted.query('SELECT * FROM entity_change_feed')).rejects.toThrow()
      const checkpoint = await restricted.query<{ invalidated_scopes: string[] }>(
        'SELECT * FROM entity_change_read_checkpoint($1::uuid, $2)',
        ['00000000-0000-0000-0000-000000000000', 10000]
      )
      expect(checkpoint.rows[0]?.invalidated_scopes).toEqual(['gfs'])
      expect(Object.keys(checkpoint.rows[0] ?? {}).sort()).toEqual([
        'current_cursor',
        'current_sequence',
        'invalidated_scopes',
        'needs_resync',
      ])
    } finally {
      await restricted.query('RESET ROLE').catch(() => undefined)
      restricted.release()
    }
  })

  it('resyncs instead of scanning an oversized retained replay window', async () => {
    const baseline = await instancePool.query<{ current_cursor: string }>(
      'SELECT current_cursor::text FROM entity_change_watermark WHERE singleton = true'
    )
    await instancePool.query(
      `INSERT INTO gfs_resources (drive, name, kind)
       VALUES ($1, 'bounded-window', 'file')`,
      [`entity-change-bounded-${randomUUID()}`]
    )
    await instancePool.query('SELECT * FROM entity_change_dispatch_batch(1000, 86400)')
    await instancePool.query(
      `INSERT INTO gfs_resources (drive, name, kind)
       VALUES ($1, 'bounded-window-2', 'file')`,
      [`entity-change-bounded-${randomUUID()}`]
    )
    await instancePool.query('SELECT * FROM entity_change_dispatch_batch(1000, 86400)')
    const bounded = await instancePool.query<{
      needs_resync: boolean
      invalidated_scopes: string[]
    }>('SELECT * FROM entity_change_read_checkpoint($1::uuid, $2)', [
      baseline.rows[0]?.current_cursor,
      1,
    ])
    expect(bounded.rows[0]?.needs_resync).toBe(true)
    expect(bounded.rows[0]?.invalidated_scopes).toEqual(['gfs', 'authorization'])
  })
})
