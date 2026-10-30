import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { PROVIDER_CATALOG_AUTO_ENABLE_DEFAULT } from '@clerum/llm-providers'
import { initDb } from '../src/db.js'
import { acquireCatalogSyncLock } from '../src/services/llmCatalogSyncLock.js'
import {
  CatalogPolicyLockTimeoutError,
  readEffectiveAutoEnablePolicy,
  setProviderAutoEnable,
} from '../src/services/llmProviderCatalogSettings.js'
import { PROVIDER_KEY_MAP } from '../src/services/modelsDevClient.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'
import './realPostgres.requirement.ts'

// Real PostgreSQL proves what a fake cannot: the migration's ACL, and that the
// toggle's upsert really blocks behind the advisory lock a catalog sync run
// holds (the run then sees the policy either before or after the toggle, never
// a toggle that committed in the middle of the run).
// Skipped without CONTROL_API_REAL_PG_ADMIN_URL, like every sibling suite.

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

describeRealPostgres('llm_provider_catalog_settings on real PostgreSQL', () => {
  const database = `control_api_catalog_policy_${randomBytes(6).toString('hex')}`
  let adminPool: Pool
  let dbPool: Pool

  async function storedRow(provider: string) {
    const { rows } = await dbPool.query<{ auto_enable: boolean; updated_by: string | null }>(
      'SELECT auto_enable, updated_by FROM llm_provider_catalog_settings WHERE provider = $1',
      [provider]
    )
    return rows[0] ?? null
  }

  async function advisoryWaiters(): Promise<number> {
    const { rows } = await dbPool.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM pg_locks l
         JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.locktype = 'advisory' AND NOT l.granted AND a.datname = $1`,
      [database]
    )
    return rows[0]!.n
  }

  // Wait until the toggle is either parked on the lock or has settled, so the
  // assertion below runs against whichever actually happened.
  async function waitForWaiterOrSettled(settled: () => boolean): Promise<void> {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      if (settled() || (await advisoryWaiters()) > 0) return
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error('toggle neither waited on the lock nor settled')
  }

  async function holdSyncLock(): Promise<PoolClient> {
    const holder = await dbPool.connect()
    await holder.query('BEGIN')
    await acquireCatalogSyncLock(holder)
    return holder
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
    dbPool = new Pool({ connectionString: databaseUrl(adminUrl!, database) })
    await initDb({ connect: () => dbPool.connect() })
  })

  afterAll(async () => {
    try {
      await endPoolAndWaitForClients(dbPool)
      if (adminPool) {
        await adminPool.query(
          `SELECT pg_terminate_backend(pid)
             FROM pg_stat_activity
            WHERE datname = $1
              AND pid <> pg_backend_pid()`,
          [database]
        )
        await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)}`)
      }
    } finally {
      await adminPool?.end()
    }
  })

  it('migrates the table with exactly the upsert envelope for the runtime role', async () => {
    const { rows } = await dbPool.query<Record<string, boolean>>(
      `SELECT has_table_privilege('control_api_runtime', 'llm_provider_catalog_settings', 'SELECT') AS sel,
              has_table_privilege('control_api_runtime', 'llm_provider_catalog_settings', 'INSERT') AS ins,
              has_table_privilege('control_api_runtime', 'llm_provider_catalog_settings', 'UPDATE') AS upd,
              has_table_privilege('control_api_runtime', 'llm_provider_catalog_settings', 'DELETE') AS del,
              has_table_privilege('control_api_runtime', 'llm_provider_catalog_settings', 'TRUNCATE') AS trn,
              has_table_privilege('workflow_recipes_runtime', 'llm_provider_catalog_settings', 'SELECT') AS wrc,
              has_table_privilege('trace_maintenance_runtime', 'llm_provider_catalog_settings', 'SELECT') AS trace`
    )
    expect(rows[0]).toEqual({
      sel: true,
      ins: true,
      upd: true,
      del: false,
      trn: false,
      wrc: false,
      trace: false,
    })

    const runtime = await dbPool.connect()
    try {
      await runtime.query('SET ROLE control_api_runtime')
      await runtime.query(
        `INSERT INTO llm_provider_catalog_settings (provider, auto_enable, updated_by)
         VALUES ('mistral', false, 'role-check')
         ON CONFLICT (provider) DO UPDATE SET auto_enable = EXCLUDED.auto_enable`
      )
      await runtime.query(
        `INSERT INTO llm_provider_catalog_settings (provider, auto_enable, updated_by)
         VALUES ('mistral', true, 'role-check')
         ON CONFLICT (provider) DO UPDATE SET auto_enable = EXCLUDED.auto_enable`
      )
      const read = await runtime.query(
        `SELECT auto_enable FROM llm_provider_catalog_settings WHERE provider = 'mistral'`
      )
      expect(read.rows).toEqual([{ auto_enable: true }])
    } finally {
      await runtime.query('RESET ROLE').catch(() => {})
      runtime.release()
    }
    await dbPool.query(`DELETE FROM llm_provider_catalog_settings WHERE provider = 'mistral'`)
  })

  it('readEffectiveAutoEnablePolicy uses the code default without a row and the row when present', async () => {
    const before = await readEffectiveAutoEnablePolicy(dbPool)
    expect(before).toEqual(
      Object.fromEntries(
        Object.keys(PROVIDER_KEY_MAP).map(provider => [
          provider,
          PROVIDER_CATALOG_AUTO_ENABLE_DEFAULT[
            provider as keyof typeof PROVIDER_CATALOG_AUTO_ENABLE_DEFAULT
          ],
        ])
      )
    )

    await dbPool.query(
      `INSERT INTO llm_provider_catalog_settings (provider, auto_enable)
       VALUES ('claude', false), ('openrouter', true), ('retired-provider', true)`
    )
    try {
      const after = await readEffectiveAutoEnablePolicy(dbPool)
      expect(after.claude).toBe(false)
      expect(after.openrouter).toBe(true)
      expect(after.openai).toBe(true)
      expect(after.groq).toBe(false)
      expect(Object.keys(after).sort()).toEqual(Object.keys(PROVIDER_KEY_MAP).sort())
    } finally {
      await dbPool.query('DELETE FROM llm_provider_catalog_settings')
    }
  })

  it('T-H2: a toggle does not commit while a sync run holds the lock, and commits after it', async () => {
    const holder = await holdSyncLock()
    let settled = false
    const toggle = setProviderAutoEnable('openai', false, 'admin-h2', dbPool).finally(() => {
      settled = true
    })
    try {
      await waitForWaiterOrSettled(() => settled)

      expect(settled).toBe(false)
      expect(await storedRow('openai')).toBeNull()
      // What the in-flight run would read under its lock: still the old policy.
      expect((await readEffectiveAutoEnablePolicy(holder)).openai).toBe(true)

      await holder.query('COMMIT')
      const outcome = await toggle
      expect(outcome.previousAutoEnable).toBe(true)
      expect(outcome.policy).toMatchObject({
        provider: 'openai',
        auto_enable: false,
        default: true,
        overridden: true,
        updated_by: 'admin-h2',
      })
      expect(await storedRow('openai')).toEqual({ auto_enable: false, updated_by: 'admin-h2' })
    } finally {
      await holder.query('ROLLBACK').catch(() => {})
      holder.release()
      await toggle.catch(() => {})
      await dbPool.query('DELETE FROM llm_provider_catalog_settings')
    }
  })

  it('surfaces a lock wait cut by statement_timeout as a retryable error and writes nothing', async () => {
    const shortPool = new Pool({
      connectionString: databaseUrl(adminUrl!, database),
      statement_timeout: 300,
    })
    const holder = await holdSyncLock()
    try {
      await expect(
        setProviderAutoEnable('gemini', false, 'admin-k4', shortPool)
      ).rejects.toBeInstanceOf(CatalogPolicyLockTimeoutError)
      await holder.query('COMMIT')
      expect(await storedRow('gemini')).toBeNull()
    } finally {
      await holder.query('ROLLBACK').catch(() => {})
      holder.release()
      await endPoolAndWaitForClients(shortPool)
    }
  })
})
