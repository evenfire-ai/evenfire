import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import type { K8sGateway } from '../src/k8s.js'
import { RUNNER_MIGRATION_VERSIONS } from '../src/migrations/migrationRunner.js'
import {
  WORKFLOW_RUN_CANCEL_REQUEST_MIGRATION,
  WORKFLOW_RUN_CANCEL_REQUEST_PAIR_CHECK,
  applyWorkflowRunCancelRequestSchema,
} from '../src/migrations/workflowRunCancelRequest.js'
import { archiveTerminalRuns } from '../src/services/workflowRunsArchiveService.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

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

describeRealPostgres('migration 0160 workflow run cancel request on PostgreSQL 16', () => {
  const database = `workflow_run_cancel_migration_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  let adminPool: Pool
  let databasePool: Pool

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
    databasePool = new Pool({ connectionString })
    const { initDb } = await import('../src/db.js')
    await initDb({ connect: () => databasePool.connect() })
  })

  afterAll(async () => {
    try {
      await endPoolAndWaitForClients(databasePool)
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

  async function insertRun(phase: 'Pending' | 'Running' = 'Pending'): Promise<string> {
    const runId = randomUUID()
    await databasePool.query(
      `INSERT INTO workflow_runs (
         run_id, recipe_namespace, recipe_name, phase, actor_type,
         trigger_source, ttl_seconds_after_finished
       ) VALUES ($1, 'demo', 'echo', $2, 'user', 'onDemand', 0)`,
      [runId, phase]
    )
    return runId
  }

  async function cancelColumns(table: 'workflow_runs' | 'workflow_runs_audit') {
    const result = await databasePool.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = $1
          AND column_name IN ('cancel_requested_at', 'canceled_by')
        ORDER BY column_name`,
      [table]
    )
    return result.rows
  }

  it('0160 is idempotent, enforces the pair check, is classified by the runner and is archived', async () => {
    // Classified by the runner: initDb above would have thrown
    // "Unclassified post-dev migrations" otherwise, and the version is recorded.
    expect(RUNNER_MIGRATION_VERSIONS).toContain(WORKFLOW_RUN_CANCEL_REQUEST_MIGRATION)
    const recorded = await databasePool.query(
      'SELECT 1 FROM schema_migrations WHERE version = $1',
      [WORKFLOW_RUN_CANCEL_REQUEST_MIGRATION]
    )
    expect(recorded.rowCount).toBe(1)

    // A database at 0159: drop what 0160 adds, keep a row written before it.
    await databasePool.query(`
      ALTER TABLE workflow_runs DROP CONSTRAINT ${WORKFLOW_RUN_CANCEL_REQUEST_PAIR_CHECK};
      ALTER TABLE workflow_runs DROP COLUMN cancel_requested_at, DROP COLUMN canceled_by;
      ALTER TABLE workflow_runs_audit DROP COLUMN cancel_requested_at, DROP COLUMN canceled_by;
    `)
    expect(await cancelColumns('workflow_runs')).toEqual([])
    const existingRunId = await insertRun()

    const expectedColumns = [
      { column_name: 'cancel_requested_at', data_type: 'timestamp with time zone' },
      { column_name: 'canceled_by', data_type: 'text' },
    ]
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await applyWorkflowRunCancelRequestSchema(databasePool)
      expect(await cancelColumns('workflow_runs')).toEqual(expectedColumns)
      expect(await cancelColumns('workflow_runs_audit')).toEqual(expectedColumns)
      const existing = await databasePool.query(
        'SELECT cancel_requested_at, canceled_by FROM workflow_runs WHERE run_id = $1',
        [existingRunId]
      )
      expect(existing.rows).toEqual([{ cancel_requested_at: null, canceled_by: null }])
    }
    const checks = await databasePool.query(
      `SELECT count(*)::int AS count
         FROM pg_constraint
        WHERE conrelid = 'workflow_runs'::regclass
          AND conname = $1`,
      [WORKFLOW_RUN_CANCEL_REQUEST_PAIR_CHECK]
    )
    expect(checks.rows).toEqual([{ count: 1 }])

    // The pair check refuses one column without the other.
    const halfRunId = await insertRun('Running')
    await expect(
      databasePool.query('UPDATE workflow_runs SET cancel_requested_at = now() WHERE run_id = $1', [
        halfRunId,
      ])
    ).rejects.toMatchObject({ code: '23514', constraint: WORKFLOW_RUN_CANCEL_REQUEST_PAIR_CHECK })
    await expect(
      databasePool.query("UPDATE workflow_runs SET canceled_by = 'someone' WHERE run_id = $1", [
        halfRunId,
      ])
    ).rejects.toMatchObject({ code: '23514', constraint: WORKFLOW_RUN_CANCEL_REQUEST_PAIR_CHECK })
    // Both together are accepted on the same row.
    const canceledBy = randomUUID()
    const both = await databasePool.query(
      `UPDATE workflow_runs
          SET cancel_requested_at = now(), canceled_by = $2
        WHERE run_id = $1`,
      [halfRunId, canceledBy]
    )
    expect(both.rowCount).toBe(1)

    // The archive copies both values.
    await databasePool.query(
      `UPDATE workflow_runs SET phase = 'Canceled', completed_at = now() WHERE run_id = $1`,
      [halfRunId]
    )
    const stored = await databasePool.query<{ cancel_requested_at: Date }>(
      'SELECT cancel_requested_at FROM workflow_runs WHERE run_id = $1',
      [halfRunId]
    )
    await expect(
      archiveTerminalRuns({} as K8sGateway, {
        connectionPool: databasePool,
        graceMs: 0,
        batchSize: 100,
        maxBatches: 2,
      })
    ).resolves.toBeGreaterThanOrEqual(1)
    const audit = await databasePool.query<{
      final_phase: string
      cancel_requested_at: Date | null
      canceled_by: string | null
    }>(
      `SELECT final_phase, cancel_requested_at, canceled_by
         FROM workflow_runs_audit
        WHERE run_id = $1`,
      [halfRunId]
    )
    expect(audit.rows).toEqual([
      {
        final_phase: 'Canceled',
        cancel_requested_at: stored.rows[0]?.cancel_requested_at,
        canceled_by: canceledBy,
      },
    ])
  })
})
