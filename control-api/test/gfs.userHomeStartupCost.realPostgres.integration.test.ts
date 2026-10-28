import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { Client, Pool } from 'pg'
import {
  GfsUserHomeReconciler,
  STARTUP_OWNER_SQL,
  STARTUP_RETIRED_SQL,
} from '../src/services/gfsUserHomeReconciler.js'
import { createDrive, createUserHomeDatabase } from './helpers/userHomeRealPostgres.js'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

describeRealPostgres('startup user-home repair cost on PostgreSQL', () => {
  let adminPool: Pool
  let database: Awaited<ReturnType<typeof createUserHomeDatabase>>
  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl! })
    database = await createUserHomeDatabase(adminUrl!, adminPool)
  }, 60_000)
  afterAll(async () => {
    try {
      if (database) {
        await database.closeConnections()
        await adminPool.query(`DROP DATABASE "${database.database}"`)
      }
    } finally {
      await adminPool?.end()
    }
  }, 60_000)

  it('scans 10000 healthy homes in under five seconds using indexes', async () => {
    const drive = 'startup-repair-cost'
    const root = await createDrive(database.pool, drive)
    const usersDir = (
      await database.pool.query<{ resource_id: string }>(
        `INSERT INTO gfs_resources(drive,parent_resource_id,name,kind,path_cache)
       VALUES ($1,$2,'Users','directory','/Users') RETURNING resource_id::text`,
        [drive, root]
      )
    ).rows[0]!.resource_id
    await database.pool.query(
      `INSERT INTO users(id,email,name)
       SELECT md5('startup-cost-' || n)::uuid, 'startup-cost-' || n || '@example.test', 'User ' || n
         FROM generate_series(1,10000) n`
    )
    await database.pool.query(
      `INSERT INTO gfs_resources(drive,parent_resource_id,name,kind,path_cache)
       SELECT $1,$2,'u-' || n,'directory','/Users/u-' || n FROM generate_series(1,10000) n`,
      [drive, usersDir]
    )
    await database.pool.query(
      `UPDATE gfs_user_homes h SET state='ready',drive=$1,storage_username='u-' || n,
         resource_id=r.resource_id
       FROM generate_series(1,10000) n JOIN gfs_resources r ON r.drive=$1 AND r.parent_resource_id=$2 AND r.name='u-' || n
       WHERE h.user_id=md5('startup-cost-' || n)::uuid`,
      [drive, usersDir]
    )
    await database.pool.query(
      `INSERT INTO gfs_grants(drive,resource_id,subject_type,subject_id,permissions,inherit,granted_by)
       SELECT drive,resource_id,'user',user_id::text,ARRAY['read','write','delete','share','manage_acl'],true,'platform:user-home'
         FROM gfs_user_homes WHERE drive=$1`,
      [drive]
    )
    await database.pool.query('ANALYZE users')
    await database.pool.query('ANALYZE gfs_user_homes')
    await database.pool.query('ANALYZE gfs_grants')
    expect(
      (
        await database.pool.query(
          `SELECT count(*)::int AS count FROM gfs_user_homes WHERE state='ready'`
        )
      ).rows[0].count
    ).toBe(10000)
    const worker = new GfsUserHomeReconciler(drive, database.pool)
    const querySpy = vi.spyOn(Client.prototype, 'query')
    const start = performance.now()
    let elapsedMs: number
    let pages: Array<{ sql: unknown; values: unknown; result: unknown }>
    try {
      await worker.tick()
      elapsedMs = performance.now() - start
      pages = querySpy.mock.calls.map((call, index) => ({
        sql: call[0],
        values: call[1],
        result: querySpy.mock.results[index]!.value,
      }))
    } finally {
      querySpy.mockRestore()
    }
    const pageCounts: Record<string, { pages: number; homes: number; needingRepair: number }> = {}
    for (const [name, sql] of [
      ['retired', STARTUP_RETIRED_SQL],
      ['owner', STARTUP_OWNER_SQL],
    ] as const) {
      const results = await Promise.all(
        pages
          .filter(page => page.sql === sql)
          .map(page => page.result as Promise<{ rows: Array<{ needs_repair: boolean }> }>)
      )
      const rows = results.flatMap(result => result.rows)
      pageCounts[name] = {
        pages: results.length,
        homes: rows.length,
        needingRepair: rows.filter(row => row.needs_repair).length,
      }
    }
    // Re-explain every cursor used by the measured pass, including the empty
    // terminal pages, against the same unchanged and analyzed fixture.
    const plans = []
    for (const page of pages) {
      if (page.sql !== STARTUP_RETIRED_SQL && page.sql !== STARTUP_OWNER_SQL) continue
      const values = page.values as [string]
      const result = await database.pool.query(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${page.sql}`,
        values
      )
      plans.push({
        name: page.sql === STARTUP_RETIRED_SQL ? 'retired' : 'owner',
        cursor: values[0],
        plan: result.rows[0]['QUERY PLAN'],
      })
    }
    const evidence = { homes: 10000, elapsedMs, pageCounts, plans }
    if (process.env.HOME_REPAIR_EXPLAIN_PATH) {
      await writeFile(
        process.env.HOME_REPAIR_EXPLAIN_PATH,
        JSON.stringify(evidence, null, 2) + '\n'
      )
    }
    console.info(`STARTUP_REPAIR homes=10000 elapsed_ms=${elapsedMs.toFixed(2)}`)
    expect(pageCounts).toEqual({
      retired: { pages: 201, homes: 10000, needingRepair: 0 },
      owner: { pages: 201, homes: 10000, needingRepair: 0 },
    })
    expect(plans).toHaveLength(402)
    const planText = JSON.stringify(plans)
    expect(planText).not.toContain('"Node Type":"Seq Scan"')
    expect(elapsedMs).toBeLessThan(5000)
    expect(
      (
        await database.pool.query(
          `SELECT count(*)::int AS count FROM gfs_user_homes WHERE state='ready'`
        )
      ).rows[0].count
    ).toBe(10000)
  }, 90_000)
})
