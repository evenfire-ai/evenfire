import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { initDb } from '../src/db.js'
import {
  addPluginWorkloadSdkPolicyReviewProvenance,
  repairPluginWorkloadSdkLegacyGrantPolicies,
} from '../src/services/pluginWorkloadSdkSchema.js'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

describeRealPostgres('Plugin Workload SDK policy review provenance on real PostgreSQL', () => {
  const database = `control_api_sdk_policy_${randomBytes(6).toString('hex')}`
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

  it('re-fences complete-looking active rows without provenance and never reactivates them', async () => {
    const client = await dbPool.connect()
    try {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO plugin_workload_sdk_grants
           (recipe_namespace, recipe_name, capability_family, provider,
            allowed_callers, prompt_targets, default_target_ref, policy_revision,
            policy_state, policy_reviewed_at, policy_reviewed_by)
         VALUES ('sandbox-recipes', 'legacy-complete-looking', 'promptBridge', 'openai',
                 '["worker"]'::jsonb,
                 '[{"targetRef":"primary","provider":"openai","model":"gpt-4o-mini","credentialSlot":"openai-api-key"}]'::jsonb,
                 'primary', 1, 'active', NULL, NULL)
         RETURNING id`
      )
      const grantId = inserted.rows[0]!.id

      await repairPluginWorkloadSdkLegacyGrantPolicies({
        query: client.query.bind(client),
      } as never)
      const repairState = await client.query(
        `SELECT policy_state, policy_revision
           FROM plugin_workload_sdk_grants
          WHERE id = $1`,
        [grantId]
      )
      expect(repairState.rows[0]).toEqual({ policy_state: 'active', policy_revision: 1 })

      await addPluginWorkloadSdkPolicyReviewProvenance({
        query: client.query.bind(client),
      } as never)
      const fencedState = await client.query(
        `SELECT policy_state, policy_revision, policy_reviewed_at, policy_reviewed_by
           FROM plugin_workload_sdk_grants
          WHERE id = $1`,
        [grantId]
      )
      expect(fencedState.rows[0]).toMatchObject({
        policy_state: 'legacy_unreviewed',
        policy_revision: 0,
        policy_reviewed_at: null,
        policy_reviewed_by: null,
      })

      await client.query(
        `UPDATE plugin_workload_sdk_grants
            SET policy_state = 'active', policy_revision = 2,
                policy_reviewed_at = now(), policy_reviewed_by = 'operator-1'
          WHERE id = $1`,
        [grantId]
      )
      await addPluginWorkloadSdkPolicyReviewProvenance({
        query: client.query.bind(client),
      } as never)
      const reviewedState = await client.query(
        `SELECT policy_state, policy_revision, policy_reviewed_by
           FROM plugin_workload_sdk_grants
          WHERE id = $1`,
        [grantId]
      )
      expect(reviewedState.rows[0]).toMatchObject({
        policy_state: 'active',
        policy_revision: 2,
        policy_reviewed_by: 'operator-1',
      })
    } finally {
      client.release()
    }
  })

  it('keeps the SDK attempt and spend ledgers writable only by control_api_runtime', async () => {
    const result = await dbPool.query(`
      SELECT
        has_table_privilege('control_api_runtime', 'plugin_workload_sdk_provider_attempts', 'SELECT,INSERT,UPDATE,DELETE') AS control_attempt_rw,
        has_table_privilege('workflow_recipes_runtime', 'plugin_workload_sdk_provider_attempts', 'SELECT') AS wrc_attempt_read,
        has_table_privilege('trace_maintenance_runtime', 'plugin_workload_sdk_provider_attempts', 'SELECT') AS trace_attempt_read,
        has_table_privilege('control_api_runtime', 'plugin_workload_sdk_spend_outcomes', 'SELECT,INSERT') AS control_spend_write,
        has_table_privilege('workflow_recipes_runtime', 'plugin_workload_sdk_spend_outcomes', 'SELECT') AS wrc_spend_read,
        has_table_privilege('trace_maintenance_runtime', 'plugin_workload_sdk_spend_outcomes', 'SELECT') AS trace_spend_read
    `)
    expect(result.rows[0]).toEqual({
      control_attempt_rw: true,
      wrc_attempt_read: false,
      trace_attempt_read: false,
      control_spend_write: true,
      wrc_spend_read: false,
      trace_spend_read: false,
    })
  })
})
