import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { initDb } from '../src/db.js'
import { listGrantsReferencingModel } from '../src/services/pluginWorkloadSdkDb.js'

// FIX C (T1/T3): exercise the REAL jsonb `@>` containment of
// listGrantsReferencingModel against a real Postgres — the risky part the unit
// test necessarily stubs. Skipped without CONTROL_API_REAL_PG_ADMIN_URL, but
// runnable in CI/local where a Postgres is present. The rows are inserted with
// SQL (minimal grant rows) because the query semantics — not the row DTO shape —
// are what is under test here; the DTO shape is covered by mapGrantRow tests.

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

describeRealPostgres('listGrantsReferencingModel jsonb containment on real PostgreSQL', () => {
  const database = `control_api_grant_impact_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  let adminPool: Pool
  let dbPool: Pool

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE "${database.replace(/"/g, '""')}"`)
    dbPool = new Pool({ connectionString })
    await initDb({ connect: () => dbPool.connect() })

    // A grant naming the target model under provider 'claude'.
    await insertGrant(dbPool, {
      recipeName: 'names-target-under-claude',
      provider: 'claude',
      allowedModels: ['claude-haiku-4-5', 'claude-sonnet-4-5'],
    })
    // A grant naming the SAME target model but under a DIFFERENT provider — the
    // fail-safe case: a provider filter would wrongly drop this. It MUST match.
    await insertGrant(dbPool, {
      recipeName: 'names-target-under-openai',
      provider: 'openai',
      allowedModels: ['claude-haiku-4-5'],
    })
    // A legacy NULL-provider grant that still names the model — must match.
    await insertGrant(dbPool, {
      recipeName: 'names-target-null-provider',
      provider: null,
      allowedModels: ['claude-haiku-4-5'],
    })
    // A grant that does NOT name the target model — must be excluded.
    await insertGrant(dbPool, {
      recipeName: 'no-target',
      provider: 'claude',
      allowedModels: ['claude-sonnet-4-5'],
    })
  })

  afterAll(async () => {
    await dbPool?.end()
    if (!adminPool) return
    await adminPool.query(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = $1
          AND pid <> pg_backend_pid()`,
      [database]
    )
    await adminPool.query(`DROP DATABASE IF EXISTS "${database.replace(/"/g, '""')}"`)
    await adminPool.end()
  })

  async function insertGrant(
    pool: Pool,
    row: { recipeName: string; provider: string | null; allowedModels: string[] }
  ): Promise<void> {
    await pool.query(
      `INSERT INTO plugin_workload_sdk_grants
         (recipe_namespace, recipe_name, capability_family, provider, allowed_models, allowed_callers)
       VALUES ('sandbox-recipes', $1, 'promptBridge', $2, $3::jsonb, '["worker"]'::jsonb)`,
      [row.recipeName, row.provider, JSON.stringify(row.allowedModels)]
    )
  }

  it('matches every grant naming the model — across providers and NULL provider — and excludes others', async () => {
    const grants = await listGrantsReferencingModel('claude-haiku-4-5', dbPool)
    const names = grants.map(g => g.recipeName).sort()
    expect(names).toEqual([
      'names-target-null-provider',
      'names-target-under-claude',
      'names-target-under-openai',
    ])
  })

  it('containment (not equality): a model listed among several still matches', async () => {
    const grants = await listGrantsReferencingModel('claude-sonnet-4-5', dbPool)
    const names = grants.map(g => g.recipeName).sort()
    // Present in the two-entry claude grant AND the no-target grant's list.
    expect(names).toEqual(['names-target-under-claude', 'no-target'])
  })

  it('returns nothing for a model no grant names', async () => {
    const grants = await listGrantsReferencingModel('gpt-4o-mini', dbPool)
    expect(grants).toEqual([])
  })
})
