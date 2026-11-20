import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool, type PoolClient } from 'pg'
import { CONTROL_API_MIGRATIONS, assertDbReady, initDb } from '../src/db.js'
import {
  GOVERNED_TRACE_RETENTION_MIGRATION,
  TELEMETRY_RETENTION_PREDICATES,
} from '../src/migrations/governedTraceRetention.js'
import { ONLINE_INDEX_PLAN, expectedIndexDefinition } from '../src/migrations/pr1OnlineIndexPlan.js'
import { INFRASTRUCTURE_TELEMETRY_TYPES } from '../src/services/tracing/contracts.js'
import { GovernedEventReadService } from '../src/services/tracing/governedEventReadService.js'
import { PostgresGovernedEventReadRepository } from '../src/services/tracing/postgresGovernedEventReadRepository.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'
import './realPostgres.requirement.ts'
import { waitForDatabaseConnectionsToClose } from './realPostgresCleanup.js'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip
const batchLimit = 200
const historicalIndexed = '0151_governed_trace_retention_indexed'
const historical0152 = '0152_governed_trace_retention_search_path'
const historicalHardened = '0153_governed_trace_retention_hardening'
const finalVersion = '0158_governed_trace_retention_hardening'
const routineSignatures = [
  'public.governed_trace_prune_expired_events(text,integer)',
  'public.governed_trace_prune_expired_costs(integer)',
  'public.governed_trace_prune_expired_prompts(integer)',
  'public.governed_trace_enforce_append_only()',
  'public.governed_trace_assert_stream_integrity()',
]
// Event function source fingerprints for the reviewed definition and the frozen search-path fixture.
const earlierEventBodies = {
  reviewed: '97914123ef820cde18bfbb84db852640cb42df083960a064ac0c206fb9a9602b',
  checkpoint: '5459678cf5611cc1d289e557e8ff5c4b6d703d2a5343fac63be71f195d8c5ff7',
}
const retentionIndexes = ONLINE_INDEX_PLAN.filter(
  entry => entry.migrationVersion === GOVERNED_TRACE_RETENTION_MIGRATION
)

async function retentionReceipts(db: Pool): Promise<string[]> {
  const { rows } = await db.query<{ version: string }>(
    'SELECT version FROM schema_migrations WHERE version = ANY($1::text[]) ORDER BY version',
    [
      [
        historicalIndexed,
        historical0152,
        historicalHardened,
        GOVERNED_TRACE_RETENTION_MIGRATION,
        finalVersion,
      ],
    ]
  )
  return rows.map(row => row.version)
}

async function retentionCatalog(db: Pool) {
  const { rows } = await db.query<{
    signature: string
    source: string
    settings: string[]
    definer: boolean
    maintenance: boolean
    api: boolean
  }>(
    `
    SELECT signature, p.proconfig AS settings, p.prosrc AS source, p.prosecdef AS definer,
           p.oid::text AS oid, p.proowner::regrole::text AS owner,
           pg_get_function_arguments(p.oid) AS arguments, pg_get_function_result(p.oid) AS result,
           p.provolatile, p.proparallel, p.proisstrict, p.prolang,
           ARRAY(SELECT item::text FROM unnest(p.proacl) AS acl(item) ORDER BY item::text) AS acl,
           has_function_privilege('trace_maintenance_runtime', p.oid, 'EXECUTE') AS maintenance,
           has_function_privilege('control_api_runtime', p.oid, 'EXECUTE') AS api,
           ARRAY(SELECT t.oid::text FROM pg_trigger t WHERE t.tgfoid = p.oid ORDER BY t.oid) AS triggers
      FROM unnest($1::text[]) WITH ORDINALITY AS expected(signature, pos)
      JOIN pg_proc p ON p.oid = to_regprocedure(signature)
      ORDER BY pos
    `,
    [routineSignatures]
  )
  expect(rows.map(row => row.signature)).toEqual(routineSignatures)
  return rows
}

async function expectFinalCatalog(db: Pool) {
  const rows = await retentionCatalog(db)
  expect(rows.map(row => row.settings)).toEqual(
    routineSignatures.map(() => ['search_path=pg_catalog, pg_temp'])
  )
  expect(rows.map(row => row.definer)).toEqual([true, true, true, false, false])
  expect(rows.slice(0, 3).map(row => [row.maintenance, row.api])).toEqual(
    Array.from({ length: 3 }, () => [true, false])
  )
  return rows
}

async function readRetentionIndexes(db: Pool) {
  const { rows } = await db.query<{
    name: string
    oid: string
    valid: boolean
    ready: boolean
    definition: string
  }>(
    `
    SELECT cls.relname AS name, cls.oid::text AS oid, idx.indisvalid AS valid,
           idx.indisready AS ready, pg_get_indexdef(cls.oid) AS definition
      FROM pg_class cls JOIN pg_index idx ON idx.indexrelid = cls.oid
      WHERE cls.relnamespace = 'public'::regnamespace AND cls.relname = ANY($1::text[])
      ORDER BY name
    `,
    [retentionIndexes.map(index => index.name)]
  )
  return rows
}

function expectAcceptableIndexes(rows: Awaited<ReturnType<typeof readRetentionIndexes>>) {
  expect(
    rows.map(({ name, valid, ready, definition }) => ({ name, valid, ready, definition }))
  ).toEqual(
    [...retentionIndexes]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(index => ({
        name: index.name,
        valid: true,
        ready: true,
        definition: expectedIndexDefinition(index, 'public'),
      }))
  )
}

function interruptFinalCommit(db: Pool, outcome: 'before' | 'after', error: Error) {
  return {
    connect: async () => {
      const client = await db.connect()
      let finalReceiptStaged = false
      return {
        async query(sql: string, values?: unknown[]) {
          if (sql === 'COMMIT' && finalReceiptStaged) {
            if (outcome === 'after') await client.query(sql)
            throw error
          }
          const result = await client.query(sql, values)
          if (sql.startsWith('INSERT INTO schema_migrations(') && values?.[0] === finalVersion) {
            finalReceiptStaged = true
          }
          return result
        },
        release: (destroy?: boolean | Error) => client.release(destroy),
      }
    },
  }
}

async function seedBilledCost(client: PoolClient, id: string, days: number, version = 1) {
  await client.query(
    `INSERT INTO public.infrastructure_cost_daily (
         id, utc_day, cloud_provider, cloud_project_id, cluster_location, cluster_name,
         environment, namespace, workload_kind, workload_ref, valuation_kind, selected_basis,
         currency, rollup_version, predecessor_version, publication_state, completeness_status,
         as_of_utc, billing_export_watermark, source_count, source_sha256, gross_amount, net_amount
       )
       VALUES ($1::uuid, (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date - $2::integer,
               'gcp', 'retention-fixture', 'test-region', 'test-cluster', 'integration',
               'control-plane', 'Deployment', 'retention-fixture', 'billed',
               'gcp_request_allocation', 'USD', $3,
               CASE WHEN $3::integer > 1 THEN $3::integer - 1 END, 'provisional', 'complete',
               CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1, repeat(md5($1::uuid::text), 2), 1, 1)`,
    [id, days, version]
  )
  await client.query(
    `INSERT INTO public.infrastructure_cost_daily_components (
         daily_cost_id, valuation_kind, selected_basis, component_key, resource_class,
         provider_service, provider_sku, billing_view_version, source_row_count, source_sha256,
         billing_export_watermark, gross_amount, net_amount
       )
       VALUES ($1::uuid, 'billed', 'gcp_request_allocation', 'retention-fixture', 'provider_sku',
               'fixture-service', 'fixture-sku', 'fixture-v1', 1, repeat(md5($1::uuid::text), 2),
               CURRENT_TIMESTAMP, 1, 1)`,
    [id]
  )
}

type Family = 'agent_run' | 'administrative' | 'infrastructure_telemetry'
type StreamFamily = Exclude<Family, 'infrastructure_telemetry'>
type TelemetryExample = {
  kind: 'capacity_sample' | 'usage_sample' | 'reconcile_outcome'
  days: number
  streamDays?: number
}
const eventTables: Record<Family, string> = {
  agent_run: 'agent_run_events',
  administrative: 'administrative_events',
  infrastructure_telemetry: 'infrastructure_telemetry_events',
}
type PlanMode = 'force_generic_plan' | 'force_custom_plan'
type PlanNode = {
  'Node Type': string
  'Relation Name'?: string
  'Index Name'?: string
  'Index Cond'?: string
  'Actual Rows': number
  'Actual Loops': number
  'Rows Removed by Filter'?: number
  'Shared Hit Blocks': number
  'Shared Read Blocks': number
  Plans?: PlanNode[]
}
type ExplainedStatement = { 'Query Text': string; Plan: PlanNode }

function nodes(plan: PlanNode): PlanNode[] {
  return [plan, ...(plan.Plans ?? []).flatMap(nodes)]
}

function rowsVisited(plan: PlanNode): number {
  return (plan['Actual Rows'] + (plan['Rows Removed by Filter'] ?? 0)) * plan['Actual Loops']
}

async function seedTelemetry(
  db: Pool | PoolClient,
  label: string,
  count: number,
  expired = false,
  examples: readonly TelemetryExample[] = []
): Promise<string[]> {
  const inserted = await db.query<{ event_id: string }>(
    `
    WITH fixture AS (
      SELECT n, md5($1 || ':' || n)::uuid AS event_id,
             repeat(md5($1 || ':' || n), 2) AS digest,
             $4::jsonb -> (n - 1) AS example,
             COALESCE($4::jsonb -> (n - 1) ->> 'kind',
                      CASE WHEN n % 10 = 0 THEN 'reconcile_outcome'
                           WHEN n % 2 = 0 THEN 'capacity_sample' ELSE 'usage_sample' END) AS kind
        FROM generate_series(1, $2::integer) AS seed(n)
    ), aged AS (
      SELECT *, transaction_timestamp() - CASE
               WHEN example IS NOT NULL THEN (example ->> 'days')::integer * INTERVAL '1 day'
               WHEN $3::boolean THEN INTERVAL '100 days' + (n % 37) * INTERVAL '1 minute'
               WHEN kind IN ('capacity_sample', 'usage_sample')
                 THEN INTERVAL '1 day' + (n % 2700) * INTERVAL '15 minutes'
               ELSE INTERVAL '1 day' + (n % 3400) * INTERVAL '35 minutes' END AS occurred_at
        FROM fixture
    ), family_rows AS (
      INSERT INTO public.infrastructure_telemetry_events (
        event_id, source_service, source_kind, source_occurrence_id, telemetry_type,
        trigger_kind, outcome, environment, cluster_name, namespace, workload_kind,
        workload_ref, kubernetes_kind, kubernetes_name, interval_start, interval_end,
        metadata_generation, idempotency_key, payload_sha256, occurred_at
      )
      SELECT event_id, 'control-api', 'trace_maintenance', event_id::text, kind,
             'periodic_sample', 'unknown', 'integration', 'retention-fixture', 'control-plane',
             'Deployment', 'control-plane/retention-fixture', 'Deployment', 'retention-fixture',
             CASE WHEN kind <> 'reconcile_outcome' THEN occurred_at - INTERVAL '1 minute' END,
             CASE WHEN kind <> 'reconcile_outcome' THEN occurred_at END,
             CASE WHEN kind = 'reconcile_outcome' THEN n END, digest, digest, occurred_at
        FROM aged
      RETURNING event_id, occurred_at, workload_ref, payload_sha256
    ), stream_rows AS (
      INSERT INTO public.governed_event_stream (
        event_family, event_id, schema_version, occurred_at, ingested_at, workload_ref, payload_sha256
      )
      SELECT 'infrastructure_telemetry', family_rows.event_id, 1,
             COALESCE(transaction_timestamp() - (example ->> 'streamDays')::integer * INTERVAL '1 day',
                      family_rows.occurred_at),
             transaction_timestamp(), workload_ref, payload_sha256
        FROM family_rows
        JOIN aged USING (event_id)
       ORDER BY CASE WHEN NOT $3::boolean THEN family_rows.occurred_at END, family_rows.event_id
      RETURNING event_id
    )
    SELECT stream_rows.event_id FROM stream_rows JOIN aged USING (event_id) ORDER BY n
  `,
    [label, count, expired, JSON.stringify(examples)]
  )
  return inserted.rows.map(row => row.event_id)
}

async function seedStreamFamily(
  db: Pool | PoolClient,
  family: StreamFamily,
  label: string,
  count: number,
  fixture: 'retained' | 'backlog' | 'sparse' | 'windows'
): Promise<string[]> {
  const columns =
    family === 'agent_run'
      ? 'run_id, span_id, origin, event_type, outcome, agent_sub'
      : 'event_kind, action, outcome, service_sub, target_type, target_ref'
  const values =
    family === 'agent_run'
      ? "event_id, 'retention-' || n, 'api', 'run_start', 'started', 'fixture-agent'"
      : "'service_action', 'service_maintenance', 'succeeded', 'fixture-service', 'service', 'fixture-target'"
  const inserted = await db.query<{ event_id: string }>(
    `
    WITH fixture AS (
      SELECT n, md5($1 || ':' || n)::uuid AS event_id, repeat(md5($1 || ':' || n), 2) AS digest,
             transaction_timestamp() - CASE $3
               WHEN 'retained' THEN INTERVAL '1 day' + n % 2000 * INTERVAL '1 hour'
               WHEN 'backlog' THEN INTERVAL '100 days' -
                 (CASE n WHEN 202 THEN 0 WHEN 200 THEN 199 ELSE n END) * INTERVAL '1 minute'
               WHEN 'windows' THEN (CASE n WHEN 1 THEN 91 ELSE 89 END) * INTERVAL '1 day'
               ELSE INTERVAL '100 days' END AS occurred_at
        FROM generate_series(1, $2::integer) AS seed(n)
    ), family_rows AS (
      INSERT INTO public.${eventTables[family]} (
        event_id, source_kind, source_service, source_event_id, idempotency_key,
        ${columns}, payload_sha256, occurred_at
      )
      SELECT event_id, 'control_api_local', 'control-api', event_id::text, digest,
             ${values}, digest, occurred_at
        FROM fixture
      RETURNING event_id, occurred_at, payload_sha256
    ), stream_rows AS (
      INSERT INTO public.governed_event_stream (
        event_family, event_id, schema_version, occurred_at, ingested_at, run_id, payload_sha256
      )
      SELECT $4, family_rows.event_id, 1, family_rows.occurred_at, transaction_timestamp(),
             CASE WHEN $4 = 'agent_run' THEN family_rows.event_id END, payload_sha256
        FROM family_rows JOIN fixture USING (event_id) ORDER BY n
      RETURNING event_id
    )
    SELECT stream_rows.event_id FROM stream_rows JOIN fixture USING (event_id) ORDER BY n
  `,
    [label, count, fixture, family]
  )
  return inserted.rows.map(row => row.event_id)
}

async function expectPairs(
  db: Pool | PoolClient,
  family: Family,
  ids: string[],
  present: boolean
): Promise<void> {
  const result = await db.query<{ relation: string; event_id: string }>(
    `
    SELECT 'family' AS relation, event_id FROM public.${eventTables[family]}
      WHERE event_id = ANY($1::uuid[])
    UNION ALL
    SELECT 'stream', event_id FROM public.governed_event_stream
      WHERE event_family = $2 AND event_id = ANY($1::uuid[])
  `,
    [ids, family]
  )
  const expected = present ? [...ids].sort() : []
  expect(
    result.rows
      .filter(row => row.relation === 'family')
      .map(row => row.event_id)
      .sort()
  ).toEqual(expected)
  expect(
    result.rows
      .filter(row => row.relation === 'stream')
      .map(row => row.event_id)
      .sort()
  ).toEqual(expected)
}

async function prune(db: PoolClient, family: Family, limit = batchLimit): Promise<string[]> {
  const deleted = await db.query<{ event_id: string }>(
    'SELECT event_id FROM public.governed_trace_prune_expired_events($1, $2)',
    [family, limit]
  )
  return deleted.rows.map(row => row.event_id).sort()
}

async function capturePrune(
  client: PoolClient,
  family: Family,
  mode: PlanMode,
  commit = true
): Promise<{ deleted: string[]; plans: ExplainedStatement[] }> {
  const plans: ExplainedStatement[] = []
  const onNotice = (notice: { message?: string }) => {
    const json = notice.message?.match(/\bplan:\s*(\{[\s\S]*\}|\[[\s\S]*\])$/)?.[1]
    if (json) {
      const parsed = JSON.parse(json) as ExplainedStatement | ExplainedStatement[]
      plans.push(...(Array.isArray(parsed) ? parsed : [parsed]))
    }
  }

  await client.query("LOAD 'auto_explain'")
  await client.query('BEGIN')
  client.on('notice', onNotice)
  try {
    await client.query("SET LOCAL statement_timeout = '30s'")
    await client.query("SET LOCAL lock_timeout = '1s'")
    await client.query("SET LOCAL auto_explain.log_format = 'json'")
    await client.query("SET LOCAL auto_explain.log_level = 'notice'")
    await client.query("SET LOCAL client_min_messages = 'notice'")
    await client.query('SET LOCAL auto_explain.log_analyze = on')
    await client.query('SET LOCAL auto_explain.log_timing = off')
    await client.query('SET LOCAL auto_explain.log_buffers = on')
    await client.query('SET LOCAL auto_explain.log_nested_statements = on')
    await client.query('SET LOCAL auto_explain.log_min_duration = 0')
    await client.query('SELECT set_config($1, $2, true)', ['plan_cache_mode', mode])
    await client.query('SET LOCAL ROLE trace_maintenance_runtime')
    const deleted = await prune(client, family)
    await client.query(commit ? 'COMMIT' : 'ROLLBACK')
    return { deleted, plans }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.off('notice', onNotice)
  }
}

function assertTelemetryPlan(plans: ExplainedStatement[], expected: number): void {
  const pages = plans.filter(plan => plan['Query Text'].includes('AS queued'))
  expect(pages, 'prune must select candidates from a bounded telemetry page').toHaveLength(1)
  const page = pages[0]!.Plan
  const pageNodes = nodes(page)
  for (const indexName of [
    'idx_infra_telemetry_retention_samples',
    'idx_infra_telemetry_retention_other',
  ]) {
    const range = pageNodes.find(node => node['Index Name'] === indexName)
    expect(range?.['Index Cond']).toContain('occurred_at <')
    expect(
      pageNodes.some(node => node['Node Type'] === 'Limit' && node.Plans?.includes(range!))
    ).toBe(true)
    expect(rowsVisited(range!)).toBeLessThanOrEqual(batchLimit + 1)
    if (expected > 0) expect(range!['Actual Rows']).toBeGreaterThan(0)
  }
  for (const sort of pageNodes.filter(node => node['Node Type'] === 'Sort')) {
    expect(sort.Plans![0]!['Actual Rows']).toBeLessThanOrEqual(2 * batchLimit)
  }
  const locks = plans.filter(plan =>
    plan['Query Text'].includes('FOR UPDATE OF stream SKIP LOCKED')
  )
  expect(locks).toHaveLength(expected)
  const lockPlans = locks.flatMap(lock => nodes(lock.Plan))
  const lookups = lockPlans.filter(node => node['Relation Name'] === 'governed_event_stream')
  expect(lookups).toHaveLength(expected)
  for (const lookup of lookups) {
    expect(lookup['Index Cond']).toEqual(expect.stringContaining('event_family'))
    expect(lookup['Index Cond']).toEqual(expect.stringContaining('event_id'))
  }
  const visits = [...pageNodes, ...lockPlans]
    .filter(node => node['Relation Name'])
    .reduce((total, node) => total + rowsVisited(node), 0)
  expect(visits).toBeLessThanOrEqual(expected === batchLimit ? 3 * batchLimit + 2 : 432)
  const selectionBlocks = [page, ...locks.map(lock => lock.Plan)].reduce(
    (total, plan) => total + plan['Shared Hit Blocks'] + plan['Shared Read Blocks'],
    0
  )
  process.stdout.write(
    `telemetry selected=${expected} leaf-visits=${visits} blocks=${selectionBlocks}\n`
  )
}

function assertStreamPlan(
  plans: ExplainedStatement[],
  family: StreamFamily,
  expected: number
): void {
  const selection = plans.filter(plan =>
    plan['Query Text'].includes('FOR UPDATE OF stream SKIP LOCKED')
  )
  expect(selection).toHaveLength(1)
  const plan = selection[0]!.Plan
  const leaves = nodes(plan).filter(node => node['Relation Name'] === 'governed_event_stream')
  expect(leaves).toHaveLength(1)
  expect(leaves[0]?.['Index Cond']).toContain('event_family')
  expect(leaves[0]?.['Index Cond']).toContain('occurred_at <')
  expect(leaves[0]?.['Actual Rows']).toBe(expected)
  const visits = rowsVisited(leaves[0]!)
  expect(visits).toBeLessThanOrEqual(432)
  process.stdout.write(
    `${family} selected=${expected} leaf-visits=${visits} blocks=${plan['Shared Hit Blocks'] + plan['Shared Read Blocks']}\n`
  )
}

async function lockTelemetry(client: PoolClient, ids: string[]) {
  return client.query(
    `SELECT event_id FROM public.governed_event_stream
      WHERE event_family = 'infrastructure_telemetry' AND event_id = ANY($1::uuid[])
      FOR UPDATE NOWAIT`,
    [ids]
  )
}

async function maintenanceTransaction<T>(
  client: PoolClient,
  run: () => Promise<T>,
  commit = true
): Promise<T> {
  await client.query('BEGIN')
  try {
    await client.query("SET LOCAL statement_timeout = '30s'")
    await client.query("SET LOCAL lock_timeout = '1s'")
    await client.query('SET LOCAL ROLE trace_maintenance_runtime')
    const result = await run()
    await client.query(commit ? 'COMMIT' : 'ROLLBACK')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}

describeRealPostgres('governed trace retention in PostgreSQL', () => {
  const database = `governed_retention_${randomBytes(6).toString('hex')}`
  let adminPool: Pool | undefined
  let db: Pool

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE "${database}"`)
    const url = new URL(adminUrl!)
    url.pathname = `/${database}`
    db = new Pool({ connectionString: url.toString() })
    await initDb(db)
    expect(await seedTelemetry(db, 'scale-retained', 90_000)).toHaveLength(90_000)
    expect(await seedStreamFamily(db, 'agent_run', 'scale-agent', 7_000, 'retained')).toHaveLength(
      7_000
    )
    expect(
      await seedStreamFamily(db, 'administrative', 'scale-admin', 450, 'retained')
    ).toHaveLength(450)
    await db.query(
      'ANALYZE public.infrastructure_telemetry_events, public.governed_event_stream, public.agent_run_events, public.administrative_events'
    )
  }, 60_000)

  afterAll(async () => {
    try {
      await endPoolAndWaitForClients(db)
      if (!adminPool) return
      await waitForDatabaseConnectionsToClose(adminPool, database)
      await adminPool.query(`DROP DATABASE IF EXISTS "${database}"`)
    } finally {
      await adminPool?.end()
    }
  })

  it('installs the final retention receipt and routine catalog on a fresh database', async () => {
    expect(await retentionReceipts(db)).toEqual([GOVERNED_TRACE_RETENTION_MIGRATION, finalVersion])
    await expectFinalCatalog(db)
    expectAcceptableIndexes(await readRetentionIndexes(db))
    await expect(assertDbReady(db)).resolves.toBeUndefined()
  })

  it.each(['reviewed', 'checkpoint'] as const)(
    'upgrades recorded retention from the %s definitions after interrupted commits',
    async origin => {
      if (!adminPool) throw new Error('Administrative fixture pool is unavailable')
      const fixtureName = `retention_upgrade_${randomBytes(6).toString('hex')}`
      await adminPool.query(`CREATE DATABASE "${fixtureName}"`)
      const url = new URL(adminUrl!)
      url.pathname = `/${fixtureName}`
      const fixture = new Pool({ connectionString: url.toString() })
      try {
        // Roll back only the last migration. Earlier versions and their concurrent
        // indexes are the frozen definitions installed by the reviewed 0151.
        const beforeCommit = new Error('test stopped before final COMMIT')
        await expect(initDb(interruptFinalCommit(fixture, 'before', beforeCommit))).rejects.toBe(
          beforeCommit
        )
        await fixture.query('UPDATE schema_migrations SET version = $1 WHERE version = $2', [
          historicalIndexed,
          GOVERNED_TRACE_RETENTION_MIGRATION,
        ])
        const priorReceipts: string[] = [historicalIndexed]
        if (origin === 'checkpoint') {
          const sql = await readFile(
            new URL('./fixtures/governed-trace-retention-0152.sql', import.meta.url),
            'utf8'
          )
          const client = await fixture.connect()
          try {
            await client.query('BEGIN')
            await client.query(sql)
            await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [
              historical0152,
            ])
            await client.query('COMMIT')
          } finally {
            await client.query('ROLLBACK')
            client.release()
          }
          priorReceipts.push(historical0152)
        }

        expect(await retentionReceipts(fixture)).toEqual(priorReceipts)
        await expect(assertDbReady(fixture)).rejects.toThrow(finalVersion)
        const original = await retentionCatalog(fixture)
        const oldPath = origin === 'reviewed' ? 'pg_catalog, public' : 'pg_catalog, public, pg_temp'
        expect(original.map(row => row.settings)).toEqual(
          routineSignatures.map(() => [`search_path=${oldPath}`])
        )
        expect(createHash('sha256').update(original[0]!.source).digest('hex')).toBe(
          earlierEventBodies[origin]
        )
        const indexes = await readRetentionIndexes(fixture)
        expectAcceptableIndexes(indexes)

        const lostReply = new Error('test lost the successful final COMMIT response')
        await expect(initDb(interruptFinalCommit(fixture, 'after', lostReply))).rejects.toBe(
          lostReply
        )
        const currentReceipts = [...priorReceipts, GOVERNED_TRACE_RETENTION_MIGRATION, finalVersion]
        expect(await retentionReceipts(fixture)).toEqual(currentReceipts)
        const final = await expectFinalCatalog(fixture)
        const identity = (rows: typeof final) => rows.map(({ source, settings, ...row }) => row)
        expect(identity(final)).toEqual(identity(original))
        expect(await readRetentionIndexes(fixture)).toEqual(indexes)
        await expect(assertDbReady(fixture)).resolves.toBeUndefined()
        await initDb(fixture)
        expect(await retentionReceipts(fixture)).toEqual(currentReceipts)
        expect(await retentionCatalog(fixture)).toEqual(final)
        expect(await readRetentionIndexes(fixture)).toEqual(indexes)

        // Relabel receipts over the already-hardened catalog to exercise alias acceptance.
        // This scenario verifies receipt reconciliation and preservation of the final definitions.
        await fixture.query('DELETE FROM schema_migrations WHERE version = $1', [
          GOVERNED_TRACE_RETENTION_MIGRATION,
        ])
        await fixture.query('UPDATE schema_migrations SET version = $1 WHERE version = $2', [
          historicalHardened,
          finalVersion,
        ])
        await initDb(fixture)
        expect(await retentionReceipts(fixture)).toEqual([
          ...priorReceipts,
          historicalHardened,
          GOVERNED_TRACE_RETENTION_MIGRATION,
          finalVersion,
        ])
        expect(await retentionCatalog(fixture)).toEqual(final)
        expect(await readRetentionIndexes(fixture)).toEqual(indexes)
      } finally {
        await endPoolAndWaitForClients(fixture)
        await waitForDatabaseConnectionsToClose(adminPool, fixtureName)
        await adminPool.query(`DROP DATABASE IF EXISTS "${fixtureName}"`)
      }
    }
  )

  it('partitions every telemetry type and an unlisted scalar exactly once', async () => {
    const types = [...INFRASTRUCTURE_TELEMETRY_TYPES, 'unlisted-retention-fixture']
    const { rows } = await db.query<{ telemetry_type: string; sample: boolean; other: boolean }>(
      `SELECT telemetry_type, ${TELEMETRY_RETENTION_PREDICATES.samples} AS sample,
              ${TELEMETRY_RETENTION_PREDICATES.other} AS other
         FROM unnest($1::text[]) WITH ORDINALITY AS e(telemetry_type, ord) ORDER BY ord`,
      [types]
    )
    expect(rows).toEqual(
      types.map(telemetry_type => {
        const sample = telemetry_type === 'capacity_sample' || telemetry_type === 'usage_sample'
        return { telemetry_type, sample, other: !sample }
      })
    )
  })

  it('prunes expired costs and prompts through the maintenance role', async () => {
    const expired = '00000000-0000-4000-8000-000000000101'
    const retained = '00000000-0000-4000-8000-000000000102'
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await seedBilledCost(client, expired, 366)
      await seedBilledCost(client, retained, 364)
      const { rows: prompts } = await client.query<{
        approval_request_id: string
        expired: boolean
      }>(
        `INSERT INTO public.governed_approval_prompt_history (
             approval_request_id, approval_kind, ciphertext, nonce, key_version, plaintext_sha256,
             plaintext_bytes, redaction_summary, source_kind, captured_at, expires_at
           )
           SELECT gen_random_uuid(), 'workflow', decode(repeat('aa', 17), 'hex'),
                  decode(repeat('bb', 12), 'hex'), 'v1', repeat('c', 64), 1,
                  '{"redacted":false,"replacementCount":0}'::jsonb, 'control_api_local',
                  CURRENT_TIMESTAMP - INTERVAL '2 days', CURRENT_TIMESTAMP + expiry
             FROM (VALUES (INTERVAL '-1 day'), (INTERVAL '1 day')) AS ages(expiry)
           RETURNING approval_request_id, expires_at <= CURRENT_TIMESTAMP AS expired`
      )
      await client.query('SET LOCAL ROLE trace_maintenance_runtime')
      expect(
        (await client.query('SELECT id FROM public.governed_trace_prune_expired_costs(10)')).rows
      ).toEqual([{ id: expired }])
      expect(
        (
          await client.query(
            'SELECT approval_request_id FROM public.governed_trace_prune_expired_prompts(10)'
          )
        ).rows
      ).toEqual([
        { approval_request_id: prompts.find(prompt => prompt.expired)!.approval_request_id },
      ])
      await client.query('RESET ROLE')
      expect(
        (await client.query('SELECT id FROM public.infrastructure_cost_daily ORDER BY id')).rows
      ).toEqual([{ id: retained }])
      expect(
        (
          await client.query(
            'SELECT daily_cost_id FROM public.infrastructure_cost_daily_components ORDER BY daily_cost_id'
          )
        ).rows
      ).toEqual([{ daily_cost_id: retained }])
      expect(
        (
          await client.query(
            'SELECT approval_request_id FROM public.governed_approval_prompt_history'
          )
        ).rows
      ).toEqual([
        { approval_request_id: prompts.find(prompt => !prompt.expired)!.approval_request_id },
      ])
      await client.query('SET CONSTRAINTS ALL IMMEDIATE')
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })

  it('rolls back a successful prune statement when COMMIT splits a cost chain', async () => {
    const predecessor = '00000000-0000-4000-8000-000000000103'
    const successor = '00000000-0000-4000-8000-000000000104'
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await seedBilledCost(client, predecessor, 367)
      await seedBilledCost(client, successor, 367, 2)
      await client.query('COMMIT')
      const ids = await seedTelemetry(db, 'cost-rollback-event', 1, true)

      await client.query('BEGIN')
      await client.query('SET LOCAL ROLE trace_maintenance_runtime')
      expect(await prune(client, 'infrastructure_telemetry', 1)).toEqual(ids)
      expect(
        (await client.query('SELECT id FROM public.governed_trace_prune_expired_costs(1)')).rows
      ).toEqual([{ id: predecessor }])
      await expect(client.query('COMMIT')).rejects.toMatchObject({ code: '23503' })
      await expectPairs(db, 'infrastructure_telemetry', ids, true)
      expect(
        (await db.query('SELECT id FROM public.infrastructure_cost_daily ORDER BY id')).rows
      ).toEqual([{ id: predecessor }, { id: successor }])

      await maintenanceTransaction(client, async () => {
        expect(await prune(client, 'infrastructure_telemetry', 1)).toEqual(ids)
        expect(
          (await client.query('SELECT id FROM public.governed_trace_prune_expired_costs(2)'))
            .rowCount
        ).toBe(2)
      })
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })

  it('rejects an ordinary unpaired insert without a durable stream row', async () => {
    const client = await db.connect()
    const id = '00000000-0000-4000-8000-000000000105'
    try {
      await client.query('BEGIN')
      await client.query('SET LOCAL ROLE control_api_runtime')
      await client.query(
        `INSERT INTO public.governed_event_stream (
           event_family, event_id, schema_version, occurred_at, ingested_at, run_id, payload_sha256
         )
         VALUES ('agent_run', $1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, $1, repeat('a', 64))`,
        [id]
      )
      await expect(client.query('COMMIT')).rejects.toThrow('stream pointer must commit together')
      await expectPairs(db, 'agent_run', [id], false)
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })

  it('lets a waiting maintenance process proceed only after the transaction releases its lock', async () => {
    const winner = await db.connect()
    const contender = await db.connect()
    const attempt =
      "SELECT pg_try_advisory_xact_lock(hashtext('governed-trace-maintenance-v1')) AS acquired"
    try {
      await winner.query('BEGIN')
      await contender.query('BEGIN')
      expect((await winner.query(attempt)).rows).toEqual([{ acquired: true }])
      expect((await contender.query(attempt)).rows).toEqual([{ acquired: false }])
      await winner.query('ROLLBACK')
      expect((await contender.query(attempt)).rows).toEqual([{ acquired: true }])
    } finally {
      await Promise.all([winner.query('ROLLBACK'), contender.query('ROLLBACK')])
      winner.release()
      contender.release()
    }
  })

  it.each(['force_generic_plan', 'force_custom_plan'] as const)(
    'uses bounded date ranges for all families under %s with zero and sparse expiry',
    async mode => {
      const client = await db.connect()
      try {
        const families = ['infrastructure_telemetry', 'agent_run', 'administrative'] as const
        for (const variant of ['zero', 'sparse'] as const) {
          for (const family of families) {
            const expected =
              variant === 'zero'
                ? []
                : family === 'infrastructure_telemetry'
                  ? await seedTelemetry(db, 'sparse-expired', 12, true)
                  : await seedStreamFamily(db, family, 'sparse-' + family, 8, 'sparse')
            await expectPairs(db, family, expected, true)
            await db.query('ANALYZE public.governed_event_stream, public.' + eventTables[family])
            const result = await capturePrune(client, family, mode)
            expect(result.deleted).toEqual([...expected].sort())
            await expectPairs(db, family, expected, false)
            if (family === 'infrastructure_telemetry') {
              assertTelemetryPlan(result.plans, expected.length)
            } else {
              assertStreamPlan(result.plans, family, expected.length)
            }
          }
        }
      } finally {
        client.release()
      }
    },
    45_000
  )

  it('keeps the 30- and 90-day boundaries and checks telemetry stream age', async () => {
    const client = await db.connect()
    try {
      const ids = await seedTelemetry(db, 'windows', 7, false, [
        { kind: 'capacity_sample', days: 31 },
        { kind: 'usage_sample', days: 31 },
        { kind: 'reconcile_outcome', days: 91 },
        { kind: 'capacity_sample', days: 29 },
        { kind: 'usage_sample', days: 29 },
        { kind: 'reconcile_outcome', days: 89 },
        { kind: 'capacity_sample', days: 31, streamDays: 29 },
      ])
      await expectPairs(db, 'infrastructure_telemetry', ids, true)
      expect(
        await maintenanceTransaction(client, () => prune(client, 'infrastructure_telemetry'))
      ).toEqual(ids.slice(0, 3).sort())
      await expectPairs(db, 'infrastructure_telemetry', ids.slice(0, 3), false)
      await expectPairs(db, 'infrastructure_telemetry', ids.slice(3), true)

      for (const family of ['agent_run', 'administrative'] as const) {
        const windows = await seedStreamFamily(db, family, 'windows-' + family, 2, 'windows')
        await expectPairs(db, family, windows, true)
        expect(await maintenanceTransaction(client, () => prune(client, family))).toEqual(
          windows.slice(0, 1)
        )
        await expectPairs(db, family, windows.slice(0, 1), false)
        await expectPairs(db, family, windows.slice(1), true)
      }
    } finally {
      client.release()
    }
  })

  it.each(['agent_run', 'administrative'] as const)(
    'prunes the oldest %s by time and stream sequence',
    async family => {
      const client = await db.connect()
      try {
        const ids = await seedStreamFamily(db, family, 'backlog-' + family, 202, 'backlog')
        const oldest = [ids[201]!, ...ids.slice(0, 199)]
        const remaining = ids.slice(199, 201)
        await expectPairs(db, family, ids, true)
        expect(await maintenanceTransaction(client, () => prune(client, family, 1), false)).toEqual(
          [ids[201]]
        )
        const batch = await capturePrune(client, family, 'force_generic_plan')
        expect(batch.deleted).toEqual([...oldest].sort())
        assertStreamPlan(batch.plans, family, batchLimit)
        await expectPairs(db, family, oldest, false)
        await expectPairs(db, family, remaining, true)
        expect(await maintenanceTransaction(client, () => prune(client, family))).toEqual(
          remaining.sort()
        )
        await expectPairs(db, family, ids, false)
      } finally {
        client.release()
      }
    }
  )

  it('shares a telemetry batch across both classes and orders by time and event ID', async () => {
    const client = await db.connect()
    try {
      const ids = await seedTelemetry(db, 'backlog', 450, true)
      const ordered = await db.query<{ event_id: string }>(
        'SELECT event_id FROM public.infrastructure_telemetry_events WHERE event_id = ANY($1) ORDER BY occurred_at, event_id',
        [ids]
      )
      const sorted = ordered.rows.map(row => row.event_id)
      await expectPairs(db, 'infrastructure_telemetry', ids, true)
      expect(
        await maintenanceTransaction(
          client,
          () => prune(client, 'infrastructure_telemetry', 1),
          false
        )
      ).toEqual(sorted.slice(0, 1))
      const batch = await capturePrune(client, 'infrastructure_telemetry', 'force_generic_plan')
      expect(batch.deleted).toEqual(sorted.slice(0, batchLimit).sort())
      assertTelemetryPlan(batch.plans, batchLimit)
      await expectPairs(db, 'infrastructure_telemetry', batch.deleted, false)
      await expectPairs(db, 'infrastructure_telemetry', sorted.slice(batchLimit), true)

      const remaining = await maintenanceTransaction(client, () =>
        client.query<{ event_id: string }>(
          "SELECT event_id FROM public.governed_trace_prune_expired_events('infrastructure_telemetry')"
        )
      )
      expect(remaining.rows.map(row => row.event_id).sort()).toEqual(
        sorted.slice(batchLimit).sort()
      )
      await expectPairs(db, 'infrastructure_telemetry', ids, false)
    } finally {
      client.release()
    }
  })

  it('continues past locked telemetry and leaves rows outside the batch available', async () => {
    const client = await db.connect()
    const locker = await db.connect()
    const witness = await db.connect()
    try {
      const ids = await seedTelemetry(db, 'contention', 426, true)
      const ordered = await db.query<{ event_id: string }>(
        'SELECT event_id FROM public.infrastructure_telemetry_events WHERE event_id = ANY($1) ORDER BY occurred_at, event_id',
        [ids]
      )
      const sorted = ordered.rows.map(row => row.event_id)
      const oldest = sorted.slice(0, 225)
      const next = sorted.slice(225, 425)
      await expectPairs(witness, 'infrastructure_telemetry', ids, true)
      await locker.query('BEGIN')
      await locker.query("SET LOCAL statement_timeout = '5s'")
      expect((await lockTelemetry(locker, oldest)).rowCount).toBe(225)

      const deleted = await maintenanceTransaction(client, async () => {
        const batch = await prune(client, 'infrastructure_telemetry')
        expect((await lockTelemetry(witness, sorted.slice(425))).rowCount).toBe(1)
        return batch
      })
      expect(deleted).toEqual([...next].sort())
      await expectPairs(witness, 'infrastructure_telemetry', next, false)
      await expectPairs(witness, 'infrastructure_telemetry', oldest, true)
      await locker.query('ROLLBACK')

      expect(
        await maintenanceTransaction(client, () => prune(client, 'infrastructure_telemetry', 1))
      ).toEqual(sorted.slice(0, 1))
      await expectPairs(witness, 'infrastructure_telemetry', sorted.slice(0, 1), false)
      await maintenanceTransaction(client, () => prune(client, 'infrastructure_telemetry', 1000))
      await expectPairs(witness, 'infrastructure_telemetry', ids, false)
    } finally {
      await locker.query('ROLLBACK')
      witness.release()
      locker.release()
      client.release()
    }
  })

  it('preserves worker-only execution and rolls back pruning and paired appends together', async () => {
    const client = await db.connect()
    const signature = 'public.governed_trace_prune_expired_events(text,integer)'
    try {
      const settings = await db.query(
        `
        SELECT f.prosecdef AS security_definer, f.proconfig AS settings,
               f.proowner = s.relowner AS ledger_owner,
               has_function_privilege('trace_maintenance_runtime', f.oid, 'EXECUTE') AS maintenance,
               has_function_privilege('control_api_runtime', f.oid, 'EXECUTE') AS api,
               EXISTS (SELECT 1 FROM aclexplode(f.proacl) AS privilege
                        WHERE privilege.grantee = 0 AND privilege.privilege_type = 'EXECUTE') AS public_execute
          FROM pg_proc AS f
          JOIN pg_class AS s ON s.oid = 'public.governed_event_stream'::regclass
         WHERE f.oid = $1::regprocedure
      `,
        [signature]
      )
      expect(settings.rows).toEqual([
        {
          security_definer: true,
          settings: ['search_path=pg_catalog, pg_temp'],
          ledger_owner: true,
          maintenance: true,
          api: false,
          public_execute: false,
        },
      ])
      for (const table of [...Object.values(eventTables), 'governed_event_stream']) {
        const result = await db.query(
          "SELECT has_table_privilege('trace_maintenance_runtime', $1, 'DELETE') AS allowed",
          ['public.' + table]
        )
        expect(result.rows[0]?.allowed).toBe(false)
      }
      for (const [family, limit] of [
        [null, 200],
        ['unsupported', 200],
        ['agent_run', null],
        ['agent_run', 0],
        ['agent_run', 1001],
      ]) {
        await expect(
          maintenanceTransaction(client, () =>
            client.query('SELECT ' + 'public.governed_trace_prune_expired_events($1, $2)', [
              family,
              limit,
            ])
          )
        ).rejects.toThrow(/unsupported governed event family|retention batch must be between/)
      }

      const expired = await seedTelemetry(db, 'rollback-expired', 12, true)
      await expectPairs(db, 'infrastructure_telemetry', expired, true)
      const appended = await maintenanceTransaction(
        client,
        async () => {
          const fresh = await seedTelemetry(client, 'rollback-fresh', 2)
          expect(await prune(client, 'infrastructure_telemetry')).toEqual([...expired].sort())
          await expectPairs(client, 'infrastructure_telemetry', expired, false)
          await expectPairs(client, 'infrastructure_telemetry', fresh, true)
          return fresh
        },
        false
      )
      await expectPairs(db, 'infrastructure_telemetry', expired, true)
      await expectPairs(db, 'infrastructure_telemetry', appended, false)
      await maintenanceTransaction(client, () => prune(client, 'infrastructure_telemetry'))
      await expectPairs(db, 'infrastructure_telemetry', expired, false)
    } finally {
      client.release()
    }
  })

  it('keeps the earlier prune function through index conflict and interruption, then retries online', async () => {
    const indexes = ONLINE_INDEX_PLAN.filter(
      index => index.migrationVersion === GOVERNED_TRACE_RETENTION_MIGRATION
    )
    const [samples, other] = indexes as [(typeof indexes)[number], (typeof indexes)[number]]
    const applyLegacy = CONTROL_API_MIGRATIONS.find(
      migration => migration.version === '0062_governed_trace_runtime_roles'
    )!.apply
    const signature = 'public.governed_trace_prune_expired_events(text,integer)'
    const getBody = async () =>
      (
        await db.query<{ body: string }>('SELECT pg_get_functiondef($1::regprocedure) AS body', [
          signature,
        ])
      ).rows[0]!.body
    const indexState = async (name: string) =>
      (
        await db.query<{ oid: string; valid: boolean }>(
          `
      SELECT indexrelid::text AS oid, indisvalid AS valid FROM pg_index
       WHERE indexrelid = to_regclass($1)`,
          [name]
        )
      ).rows[0]
    const receipts = () =>
      db.query('SELECT 1 FROM schema_migrations WHERE version = $1', [
        GOVERNED_TRACE_RETENTION_MIGRATION,
      ])

    const currentBody = await getBody()
    // Replay just the old function DDL. The historical migration also changes
    // grants unrelated to this replay, which must remain at their current versions.
    await applyLegacy({
      async query(sql) {
        const legacy = sql.match(
          /CREATE OR REPLACE FUNCTION governed_trace_prune_expired_events\([\s\S]+?\$\$;/
        )
        if (!legacy) throw new Error('Historical prune definition not found')
        return db.query(legacy[0])
      },
    })
    const legacyBody = await getBody()
    expect(legacyBody).not.toBe(currentBody)
    await db.query('DELETE FROM schema_migrations WHERE version = ANY($1::text[])', [
      [GOVERNED_TRACE_RETENTION_MIGRATION, finalVersion],
    ])
    const sampleState = await indexState(samples.name)
    expect(sampleState?.valid).toBe(true)
    await db.query(`DROP INDEX ${other.name}`)
    await db.query(`CREATE INDEX ${other.name} ON infrastructure_telemetry_events (occurred_at, event_id)
      WHERE (telemetry_type = 'controller_error'::text)`)
    await expect(initDb(db)).rejects.toThrow('Non-equivalent existing index: ' + other.name)
    expect((await receipts()).rowCount).toBe(0)
    expect(await getBody()).toBe(legacyBody)
    expect(await indexState(samples.name)).toEqual(sampleState)
    await db.query(`DROP INDEX ${other.name}`)

    const writer = await db.connect()
    const migration = await db.connect()
    let upgrade: Promise<void> | undefined
    try {
      const pid = (await migration.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
        .rows[0]!.pid
      await writer.query('BEGIN')
      await writer.query("SET LOCAL lock_timeout = '1s'")
      await seedTelemetry(writer, 'online-before', 2)
      upgrade = initDb({
        connect: async () => ({
          query: (sql: string, params?: unknown[]) => migration.query(sql, params),
          release: () => undefined,
        }),
      })
      // The query returns early once the catalog entry is visible and the
      // migrator is waiting for our writer to commit.
      const deadline = Date.now() + 5_000
      let waiting = false
      while (!waiting && Date.now() < deadline) {
        const progress = await db.query(
          "SELECT 1 FROM pg_stat_progress_create_index WHERE pid = $1 AND phase = 'waiting for writers before build'",
          [pid]
        )
        waiting = progress.rowCount === 1
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 25))
      }
      expect(waiting).toBe(true)
      expect((await indexState(other.name))?.valid).toBe(false)
      const concurrent = await seedTelemetry(writer, 'online-during', 2)
      await expectPairs(writer, 'infrastructure_telemetry', concurrent, true)
      expect(
        (await db.query('SELECT pg_cancel_backend($1) AS canceled', [pid])).rows[0]?.canceled
      ).toBe(true)
      await expect(upgrade).rejects.toMatchObject({ code: '57014' })
      await writer.query('COMMIT')
      await expectPairs(db, 'infrastructure_telemetry', concurrent, true)
    } finally {
      await writer.query('ROLLBACK')
      // Always settle the acquisition before releasing the pinned session.
      await upgrade?.catch(() => undefined)
      writer.release()
      migration.release()
    }

    expect((await receipts()).rowCount).toBe(0)
    expect(await getBody()).toBe(legacyBody)
    const invalid = await indexState(other.name)
    expect(invalid?.valid).toBe(false)

    await initDb(db)
    expect((await receipts()).rowCount).toBe(1)
    expect(await getBody()).toBe(currentBody)
    expect(await indexState(samples.name)).toEqual(sampleState)
    const repaired = await indexState(other.name)
    expect(repaired?.valid).toBe(true)
    expect(repaired?.oid).not.toBe(invalid?.oid)
    await initDb(db)
    expect(await indexState(other.name)).toEqual(repaired)
  }, 20_000)

  it('recovers an online index after the lock deadline for an older snapshot', async () => {
    const original = await readRetentionIndexes(db)
    const waitingIndex = 'idx_infra_telemetry_retention_other'
    await db.query('DROP INDEX public.idx_infra_telemetry_retention_other')
    await db.query('DELETE FROM schema_migrations WHERE version = ANY($1::text[])', [
      [GOVERNED_TRACE_RETENTION_MIGRATION, finalVersion],
    ])

    const reader = await db.connect()
    const migrator = await db.connect()
    let attempt: Promise<unknown> | undefined
    try {
      const {
        rows: [{ pid }],
      } = await migrator.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      await reader.query('SELECT event_id FROM public.infrastructure_telemetry_events LIMIT 1')
      const startedAt = performance.now()
      attempt = initDb({
        connect: async () => ({
          query: (sql: string, params?: unknown[]) => migrator.query(sql, params),
          release: () => undefined,
        }),
      }).then(
        () => undefined,
        (error: unknown) => error
      )
      const deadline = Date.now() + 5_000
      let waiting = false
      while (!waiting && Date.now() < deadline) {
        const progress = await db.query(
          "SELECT 1 FROM pg_stat_progress_create_index WHERE pid = $1 AND phase = 'waiting for old snapshots'",
          [pid]
        )
        waiting = progress.rowCount === 1
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 25))
      }
      expect(waiting).toBe(true)
      expect(await attempt).toMatchObject({ code: '55P03' })
      expect(performance.now() - startedAt).toBeGreaterThanOrEqual(9_500)
      expect(await retentionReceipts(db)).toEqual([])
      expect(
        (await readRetentionIndexes(db)).find(index => index.name === waitingIndex)?.valid
      ).toBe(false)
    } finally {
      await reader.query('ROLLBACK')
      await attempt
      reader.release()
      migrator.release()
      await initDb(db)
    }
    expect(await retentionReceipts(db)).toEqual([GOVERNED_TRACE_RETENTION_MIGRATION, finalVersion])
    const recovered = await readRetentionIndexes(db)
    expectAcceptableIndexes(recovered)
    expect(recovered.filter(index => index.name !== waitingIndex)).toEqual(
      original.filter(index => index.name !== waitingIndex)
    )
  }, 20_000)

  it.each(['agent_run', 'administrative', 'infrastructure_telemetry'] as const)(
    'deletes a valid expired %s pair with immediate constraints',
    async family => {
      const client = await db.connect()
      try {
        await client.query('BEGIN')
        const label = `immediate-${family}`
        const expired =
          family === 'infrastructure_telemetry'
            ? await seedTelemetry(client, label, 1, true)
            : await seedStreamFamily(client, family, label, 1, 'sparse')
        await expectPairs(client, family, expired, true)
        await client.query('SET CONSTRAINTS ALL IMMEDIATE')
        await client.query('SET LOCAL ROLE trace_maintenance_runtime')
        expect(await prune(client, family, 1)).toEqual(expired)
        await expectPairs(client, family, expired, false)
      } finally {
        await client.query('ROLLBACK')
        client.release()
      }
    }
  )

  it('continues a real stream read across a pruned high sequence', async () => {
    const client = await db.connect()
    try {
      const [first] = await seedStreamFamily(db, 'agent_run', 'reader-first', 1, 'retained')
      const expired = await seedStreamFamily(db, 'agent_run', 'reader-expired', 1, 'sparse')
      const [last] = await seedStreamFamily(db, 'agent_run', 'reader-last', 1, 'retained')
      const repo = new PostgresGovernedEventReadRepository(db)
      const highWatermark = await repo.captureHighWatermark()
      const firstSequence = await db.query<{ sequence: string }>(
        `
        SELECT (stream_sequence - 1)::text AS sequence
          FROM public.governed_event_stream WHERE event_family = 'agent_run' AND event_id = $1
      `,
        [first]
      )
      const query = {
        scope: { kind: 'stream' },
        families: ['agent_run'],
        order: 'oldest',
        highWatermark,
        limit: 1,
        occurredFrom: null,
        occurredTo: null,
      } as const
      const firstPage = await repo.readAfter({
        ...query,
        afterSequence: firstSequence.rows[0]!.sequence,
      })
      expect(firstPage.map(row => row.eventId)).toEqual([first])
      await expectPairs(db, 'agent_run', expired, true)
      expect(await maintenanceTransaction(client, () => prune(client, 'agent_run'))).toEqual(
        expired
      )
      await expectPairs(db, 'agent_run', expired, false)
      const nextPage = await repo.readAfter({
        ...query,
        afterSequence: firstPage[0]!.streamSequence,
      })
      expect(nextPage.map(row => row.eventId)).toEqual([last])
      expect(nextPage[0]!.streamSequence).toBe(highWatermark)
    } finally {
      client.release()
    }
  })

  it('continues a real latest cursor when its boundary was deleted', async () => {
    const [retained] = await seedStreamFamily(db, 'agent_run', 'latest-retained', 1, 'retained')
    const expired = await seedStreamFamily(db, 'agent_run', 'latest-expired', 1, 'sparse')
    const service = new GovernedEventReadService(new PostgresGovernedEventReadRepository(db))
    const query = {
      scope: { kind: 'stream' },
      families: ['agent_run'],
      order: 'latest',
      limit: 1,
    } as const
    const first = await service.read({ ...query, families: [...query.families] })
    expect(first.events.map(event => event.eventId)).toEqual(expired)
    expect(first.nextCursor).not.toBeNull()
    await seedStreamFamily(db, 'agent_run', 'latest-after-capture', 1, 'retained')
    const client = await db.connect()
    try {
      expect(await maintenanceTransaction(client, () => prune(client, 'agent_run', 1))).toEqual(
        expired
      )
      await expectPairs(db, 'agent_run', expired, false)
      const next = await service.read({
        ...query,
        families: [...query.families],
        cursor: first.nextCursor!,
      })
      expect(next.events.map(event => event.eventId)).toEqual([retained])
      expect(next.capturedHighWatermark).toBe(first.capturedHighWatermark)
    } finally {
      client.release()
    }
  })
})
