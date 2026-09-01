import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { initDb } from '../src/db.js'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip
const runtimeRoles = [
  'control_api_runtime',
  'trace_maintenance_runtime',
  'workflow_recipes_runtime',
] as const
const barrierClass = 35_005

function databaseUrl(baseUrl: string, database: string): string {
  const value = new URL(baseUrl)
  value.pathname = `/${database}`
  return value.toString()
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

async function backendPid(client: PoolClient): Promise<number> {
  const result = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
  return result.rows[0]!.pid
}

async function waitForAdvisoryBlock(
  pool: Pool,
  blockedPid: number,
  blockerPid: number,
  label: string
): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const result = await pool.query<{ blocked: boolean; wait_event: string | null }>(
      `SELECT $2::integer = ANY(pg_blocking_pids($1::integer)) AS blocked,
              wait_event
         FROM pg_stat_activity
        WHERE pid = $1::integer`,
      [blockedPid, blockerPid]
    )
    if (result.rows[0]?.blocked && result.rows[0].wait_event === 'advisory') return
    await new Promise<void>(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`${label}: expected advisory barrier was not observed`)
}

async function waitForSecondWriter(
  pool: Pool,
  blockedPid: number,
  firstWriterPid: number,
  secondBarrierPid: number
): Promise<'same-first-row' | 'opposite-first-row'> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const result = await pool.query<{
      blocked_by_first: boolean
      blocked_by_barrier: boolean
      wait_event: string | null
    }>(
      `SELECT $2::integer = ANY(pg_blocking_pids($1::integer)) AS blocked_by_first,
              $3::integer = ANY(pg_blocking_pids($1::integer)) AS blocked_by_barrier,
              wait_event
         FROM pg_stat_activity
        WHERE pid = $1::integer`,
      [blockedPid, firstWriterPid, secondBarrierPid]
    )
    const row = result.rows[0]
    if (row?.blocked_by_first) return 'same-first-row'
    if (row?.blocked_by_barrier && row.wait_event === 'advisory') return 'opposite-first-row'
    await new Promise<void>(resolve => setTimeout(resolve, 10))
  }
  throw new Error('expected the second GFS writer to reach a revision-row lock or barrier')
}

type WriteOutcome = { status: 'fulfilled' } | { status: 'rejected'; code: string; error: unknown }

function observeWrite(write: Promise<unknown>): Promise<WriteOutcome> {
  return write.then(
    () => ({ status: 'fulfilled' as const }),
    error => ({
      status: 'rejected' as const,
      code:
        typeof error === 'object' && error !== null && 'code' in error
          ? String((error as { code?: unknown }).code ?? 'unknown')
          : 'unknown',
      error,
    })
  )
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  await client.query('ROLLBACK').catch(() => undefined)
}

describeRealPostgres('GFS subject revision lock order on real PostgreSQL', () => {
  const database = `control_api_gfs_revision_order_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  let adminPool: Pool
  let databasePool: Pool

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRoles.join(', ')}`)
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(database)}`)
    databasePool = new Pool({ connectionString, max: 12 })
    await initDb({ connect: () => databasePool.connect() })
  })

  afterAll(async () => {
    await databasePool?.end()
    if (adminPool) {
      await adminPool.query(
        `SELECT pg_terminate_backend(pid)
           FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [database]
      )
      await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)}`)
      await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRoles.join(', ')}`)
      await adminPool.end()
    }
  })

  it('serializes overlapping resource writes in one deduplicated subject order', async () => {
    const subjectIds = Array.from({ length: 96 }, (_, index) => {
      const suffix = String(index + 1).padStart(12, '0')
      return `00000000-0000-4000-8000-${suffix}`
    })
    for (const [index, subjectId] of subjectIds.entries()) {
      await databasePool.query(`INSERT INTO users(id, email, name) VALUES ($1, $2, $3)`, [
        subjectId,
        `rp005a-${index}-${subjectId}@example.test`,
        `RP005A ${index}`,
      ])
    }

    const resourceA = randomUUID()
    const resourceB = randomUUID()
    const driveA = `rp005a-a-${randomBytes(4).toString('hex')}`
    const driveB = `rp005a-b-${randomBytes(4).toString('hex')}`
    await databasePool.query(
      `INSERT INTO gfs_resources(resource_id, drive, name, kind)
       VALUES ($1, $3, 'rp005a-a', 'file'), ($2, $4, 'rp005a-b', 'file')`,
      [resourceA, resourceB, driveA, driveB]
    )

    for (const [resourceId, drive, ids] of [
      [resourceA, driveA, subjectIds],
      [resourceB, driveB, [...subjectIds].reverse()],
    ] as const) {
      for (const subjectId of ids) {
        await databasePool.query(
          `INSERT INTO gfs_grants(drive, resource_id, subject_type, subject_id, permissions)
           VALUES ($1, $2, 'user', $3, ARRAY['read']::text[])`,
          [drive, resourceId, subjectId]
        )
        await databasePool.query(
          `INSERT INTO gfs_shares(drive, resource_id, subject_type, subject_id, permissions)
           VALUES ($1, $2, 'user', $3, ARRAY['read']::text[])`,
          [drive, resourceId, subjectId]
        )
      }
    }

    const subjectOrder = async (
      resourceId: string,
      strategy: 'sorted' | 'hashed'
    ): Promise<readonly string[]> => {
      const client = await databasePool.connect()
      try {
        await client.query('BEGIN')
        if (strategy === 'sorted') {
          await client.query('SET LOCAL enable_hashagg = off')
          await client.query('SET LOCAL enable_sort = on')
        } else {
          await client.query('SET LOCAL enable_hashagg = on')
          await client.query('SET LOCAL enable_sort = off')
        }
        const result = await client.query<{ subject_id: string }>(
          `SELECT grant_row.subject_type, grant_row.subject_id
             FROM gfs_grants grant_row
            WHERE grant_row.resource_id = $1
           UNION
           SELECT share_row.subject_type, share_row.subject_id
             FROM gfs_shares share_row
            WHERE share_row.resource_id = $1`,
          [resourceId]
        )
        return result.rows.map(row => row.subject_id)
      } finally {
        await client.query('ROLLBACK')
        client.release()
      }
    }

    const sortedOrder = await subjectOrder(resourceA, 'sorted')
    const hashedOrder = await subjectOrder(resourceB, 'hashed')
    const firstSorted = sortedOrder[0]
    const firstHashed = hashedOrder[0]
    expect(firstSorted).toBeDefined()
    expect(firstHashed).toBeDefined()
    expect(firstSorted).not.toBe(firstHashed)

    const before = await databasePool.query<{ user_id: string; revision: string }>(
      `SELECT user_id::text, revision::text
         FROM authorization_user_revisions
        WHERE user_id = ANY($1::uuid[])
        ORDER BY user_id::text`,
      [subjectIds]
    )
    const revisionsBefore = new Map(before.rows.map(row => [row.user_id, BigInt(row.revision)]))

    await databasePool.query(`
      CREATE TABLE rp005a_barrier_config(
        application_name TEXT PRIMARY KEY,
        user_id UUID NOT NULL,
        gate INTEGER NOT NULL
      );
      CREATE OR REPLACE FUNCTION rp005a_revision_barrier()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      DECLARE selected_gate INTEGER;
      BEGIN
        SELECT gate INTO selected_gate
          FROM rp005a_barrier_config
         WHERE application_name = current_setting('application_name')
           AND user_id = NEW.user_id;
        IF FOUND THEN
          PERFORM pg_advisory_lock(35005, selected_gate);
          PERFORM pg_advisory_unlock(35005, selected_gate);
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER rp005a_revision_barrier
        BEFORE UPDATE ON authorization_user_revisions
        FOR EACH ROW EXECUTE FUNCTION rp005a_revision_barrier();
    `)
    await databasePool.query(
      `INSERT INTO rp005a_barrier_config(application_name, user_id, gate)
       VALUES ('rp005a-sorted', $1, 1), ('rp005a-hashed', $2, 2)`,
      [firstSorted, firstHashed]
    )

    const gateOne = await databasePool.connect()
    const gateTwo = await databasePool.connect()
    const txOne = await databasePool.connect()
    const txTwo = await databasePool.connect()
    const outcomes: WriteOutcome[] = []
    try {
      const gateOnePid = await backendPid(gateOne)
      const gateTwoPid = await backendPid(gateTwo)
      await gateOne.query('SELECT pg_advisory_lock($1, 1)', [barrierClass])
      await gateTwo.query('SELECT pg_advisory_lock($1, 2)', [barrierClass])

      await txOne.query('BEGIN')
      await txOne.query("SELECT set_config('application_name', 'rp005a-sorted', true)")
      await txOne.query('SET LOCAL enable_hashagg = off')
      await txOne.query('SET LOCAL enable_sort = on')
      await txOne.query("SET LOCAL deadlock_timeout = '100ms'")
      await txOne.query("SET LOCAL statement_timeout = '8s'")
      const txOnePid = await backendPid(txOne)
      const writeOne = observeWrite(
        txOne.query(`UPDATE gfs_resources SET name = name || '-one' WHERE resource_id = $1`, [
          resourceA,
        ])
      )
      await waitForAdvisoryBlock(databasePool, txOnePid, gateOnePid, 'first-writer-first-row')

      await txTwo.query('BEGIN')
      await txTwo.query("SELECT set_config('application_name', 'rp005a-hashed', true)")
      await txTwo.query('SET LOCAL enable_hashagg = on')
      await txTwo.query('SET LOCAL enable_sort = off')
      await txTwo.query("SET LOCAL deadlock_timeout = '100ms'")
      await txTwo.query("SET LOCAL statement_timeout = '8s'")
      const txTwoPid = await backendPid(txTwo)
      const writeTwo = observeWrite(
        txTwo.query(`UPDATE gfs_resources SET name = name || '-two' WHERE resource_id = $1`, [
          resourceB,
        ])
      )
      const secondWriterState = await waitForSecondWriter(
        databasePool,
        txTwoPid,
        txOnePid,
        gateTwoPid
      )

      if (secondWriterState === 'same-first-row') {
        await gateOne.query('SELECT pg_advisory_unlock($1, 1)', [barrierClass])
        const firstOutcome = await writeOne
        outcomes.push(firstOutcome)
        if (firstOutcome.status === 'fulfilled') await txOne.query('COMMIT')
        else await rollbackQuietly(txOne)
        await waitForAdvisoryBlock(databasePool, txTwoPid, gateTwoPid, 'second-writer-later-row')
        await gateTwo.query('SELECT pg_advisory_unlock($1, 2)', [barrierClass])
        const secondOutcome = await writeTwo
        outcomes.push(secondOutcome)
        if (secondOutcome.status === 'fulfilled') await txTwo.query('COMMIT')
        else await rollbackQuietly(txTwo)
      } else {
        await gateOne.query('SELECT pg_advisory_unlock($1, 1)', [barrierClass])
        await gateTwo.query('SELECT pg_advisory_unlock($1, 2)', [barrierClass])
        outcomes.push(await writeOne, await writeTwo)
        await rollbackQuietly(txOne)
        await rollbackQuietly(txTwo)
      }
    } finally {
      await gateOne.query('SELECT pg_advisory_unlock_all()').catch(() => undefined)
      await gateTwo.query('SELECT pg_advisory_unlock_all()').catch(() => undefined)
      await rollbackQuietly(txOne)
      await rollbackQuietly(txTwo)
      gateOne.release()
      gateTwo.release()
      txOne.release()
      txTwo.release()
    }

    expect(outcomes).toEqual([{ status: 'fulfilled' }, { status: 'fulfilled' }])
    const after = await databasePool.query<{ user_id: string; revision: string }>(
      `SELECT user_id::text, revision::text
         FROM authorization_user_revisions
        WHERE user_id = ANY($1::uuid[])
        ORDER BY user_id::text`,
      [subjectIds]
    )
    expect(after.rows).toHaveLength(subjectIds.length)
    for (const row of after.rows) {
      expect(BigInt(row.revision) - (revisionsBefore.get(row.user_id) ?? 0n)).toBe(2n)
    }
  })

  it('preserves the subject validation failures owned by the revision dispatcher', async () => {
    await expect(
      databasePool.query(`SELECT authorization_bump_subject_revision('invalid', 'subject')`)
    ).rejects.toMatchObject({ message: expect.stringContaining('unmapped catalog subject type') })
    await expect(
      databasePool.query(`SELECT authorization_bump_subject_revision('user', 'not-a-uuid')`)
    ).rejects.toMatchObject({
      code: 'P0001',
      message: expect.stringContaining('invalid catalog user subject identifier'),
    })
  })
})
