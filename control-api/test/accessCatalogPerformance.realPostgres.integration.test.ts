import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { config } from '../src/config.js'
import { type DbClient, initDb } from '../src/db.js'
import { buildAccessCatalog } from '../src/services/access/accessCatalogCoordinator.js'
import { AccessCatalogCursorError } from '../src/services/access/accessCatalogCursor.js'
import { CATALOG_FAMILIES, type CatalogFamily } from '../src/services/access/catalogContracts.js'
import { CATALOG_KEY_SQL } from '../src/services/access/catalogProducerSql.js'
import {
  OPERATIONAL_SOURCE_FAMILIES,
  canonicalEnvironmentId,
} from '../src/services/access/operationalAccessProjection.js'
import {
  type TeamGfsStreamRequest,
  collectTeamGfsTopK,
  teamGfsTopKSql,
} from '../src/services/access/teamGfsTopK.js'
import type { ExternalSessionAuthorityContext } from '../src/services/auth/externalSessionAuthentication.js'
import { CatalogQueryObservation } from './accessCatalogQueryObservation.js'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip
const runtimeRoles = [
  'control_api_runtime',
  'trace_maintenance_runtime',
  'workflow_recipes_runtime',
] as const
const DIRECT_ONLY_RESOURCES = 20
const TYPICAL_TEAMS = 3
const TYPICAL_RESOURCES_PER_TEAM = 10
const HIGH_DIRECT_RESOURCES = 1_500
const HIGH_TEAMS = 250
const HIGH_RESOURCES_PER_TEAM = 6

const armCounts: Readonly<Record<CatalogFamily, number>> = Object.freeze({
  user: 1,
  team: 1,
  host: 2,
  context: 2,
  mcp_server: 4,
  workflow_recipe: 2,
  workflow_run: 3,
  workflow_approval: 2,
  notification: 2,
  gfs_resource: 2,
  shared_filesystem: 2,
  sandbox_app: 2,
})

function databaseUrl(baseUrl: string, database: string): string {
  const value = new URL(baseUrl)
  value.pathname = `/${database}`
  return value.toString()
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

type JsonPlanNode = Record<string, unknown> & { Plans?: JsonPlanNode[] }

function planNodes(root: JsonPlanNode): JsonPlanNode[] {
  const values: JsonPlanNode[] = []
  const pending = [root]
  while (pending.length > 0) {
    const current = pending.pop()!
    values.push(current)
    pending.push(...(current.Plans ?? []))
  }
  return values
}

function numberField(value: JsonPlanNode, key: string): number {
  const number = Number(value[key] ?? 0)
  return Number.isFinite(number) ? number : 0
}

function queryPlan(row: unknown): Record<string, unknown> & { Plan: JsonPlanNode } {
  const value = (row as Record<string, unknown>)['QUERY PLAN']
  if (!Array.isArray(value) || !value[0] || typeof value[0] !== 'object') {
    throw new Error('explain_plan_invalid')
  }
  return value[0] as Record<string, unknown> & { Plan: JsonPlanNode }
}

describeRealPostgres('aggregate catalog plans on real PostgreSQL', () => {
  const database = `control_api_catalog_performance_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  const environmentId = canonicalEnvironmentId()
  const userId = randomUUID()
  const allTeamIds = Array.from({ length: HIGH_TEAMS }, () => randomUUID())
  const session: ExternalSessionAuthorityContext = {
    contract: 'v1',
    userId,
    tokenHash: randomBytes(32).toString('hex'),
    issuedAt: Math.floor(Date.now() / 1_000),
  }
  let adminPool: Pool
  let databasePool: Pool

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRoles.join(', ')}`)
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(database)}`)
    databasePool = new Pool({ connectionString })
    await initDb({ connect: () => databasePool.connect() })
    await databasePool.query(
      `INSERT INTO users(id, email, name) VALUES ($1, $2, 'Catalog Plan User')`,
      [userId, `${userId}@example.test`]
    )
    await databasePool.query(
      `INSERT INTO operational_catalog_source_state(
         environment_id, source_family, generation, resource_version, status, last_success_at
       )
       SELECT $1, source_family, 1, '1', 'current', NOW()
         FROM UNNEST($2::text[]) source_family`,
      [environmentId, OPERATIONAL_SOURCE_FAMILIES]
    )
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

  async function seedDirect(first: number, last: number): Promise<void> {
    if (first > last) return
    const seriesValues = [userId, first, last]
    const values = [...seriesValues, environmentId]
    await databasePool.query(
      `WITH requester AS (SELECT $1::uuid AS user_id), ids AS (
         SELECT value, LPAD(value::text, 5, '0') AS suffix
           FROM generate_series($2::int, $3::int) value
       )
       INSERT INTO user_agents(user_id, agent_name)
       SELECT $1, 'direct-host-' || suffix FROM ids`,
      seriesValues
    )
    await databasePool.query(
      `WITH requester AS (SELECT $1::uuid AS user_id), ids AS (
         SELECT value, LPAD(value::text, 5, '0') AS suffix
           FROM generate_series($2::int, $3::int) value
       )
       INSERT INTO user_contexts(user_id, context_id)
       SELECT $1, 'direct-context-' || suffix FROM ids`,
      seriesValues
    )
    await databasePool.query(
      `WITH ids AS (
         SELECT value, LPAD(value::text, 5, '0') AS suffix
           FROM generate_series($2::int, $3::int) value
       )
       INSERT INTO user_workflow_triggers(user_id, recipe_namespace, recipe_name)
       SELECT $1, $4, 'direct-recipe-' || suffix FROM ids`,
      [...seriesValues, config.sandboxNamespace]
    )
    await databasePool.query(
      `WITH requester AS (SELECT $1::uuid AS user_id), ids AS (
         SELECT value, LPAD(value::text, 5, '0') AS suffix
           FROM generate_series($2::int, $3::int) value
       ), resources(resource_type, logical_id, source_family, provider_uid, display_name) AS (
         SELECT 'host', $5 || '/direct-host-' || suffix, 'host',
                'direct-host-uid-' || suffix, 'Direct Host ' || suffix FROM ids
         UNION ALL
         SELECT 'context', $6 || '/direct-context-' || suffix, 'context',
                'direct-context-uid-' || suffix, 'Direct Context ' || suffix FROM ids
         UNION ALL
         SELECT 'mcp_server', $7 || '/direct-mcp-' || suffix, 'mcp_server',
                'direct-mcp-uid-' || suffix, 'Direct MCP ' || suffix FROM ids
         UNION ALL
         SELECT 'shared_filesystem', $8 || '/direct-files-' || suffix, 'shared_filesystem',
                'direct-files-uid-' || suffix, 'Direct Files ' || suffix FROM ids
         UNION ALL
         SELECT 'workflow_recipe', $9 || '/direct-recipe-' || suffix, 'workflow_recipe',
                'direct-recipe-uid-' || suffix, 'Direct Recipe ' || suffix FROM ids
         UNION ALL
         SELECT 'sandbox_app', $9 || '/direct-recipe-' || suffix, 'workflow_recipe',
                'direct-recipe-uid-' || suffix || ':ui', 'Direct App ' || suffix FROM ids
       )
       INSERT INTO operational_resource_index(
         environment_id, resource_type, logical_id, source_family, source_generation,
         provider_uid, provider_resource_version, display_name, enabled, content_bytes
       )
       SELECT $4, resource_type, logical_id, source_family, 1,
              provider_uid, '1', display_name, TRUE, 128
         FROM resources`,
      [
        userId,
        first,
        last,
        environmentId,
        config.hostsNamespace,
        config.contextsNamespace,
        config.mcpServersNamespace,
        config.sharedFilesystemsNamespace,
        config.sandboxNamespace,
      ]
    )
    await databasePool.query(
      `WITH requester AS (SELECT $1::uuid AS user_id), ids AS (
         SELECT value, LPAD(value::text, 5, '0') AS suffix
           FROM generate_series($2::int, $3::int) value
       ), relationships(
         source_type, source_id, relationship_type, target_type, target_id,
         relationship_instance_id, behavior_attributes, source_family,
         source_provider_uid
       ) AS (
         SELECT 'host', $5 || '/direct-host-' || suffix, 'uses_context', 'context',
                $6 || '/direct-context-' || suffix, 'direct-host-context-' || suffix,
                '{}'::jsonb, 'host', 'direct-host-uid-' || suffix FROM ids
         UNION ALL
         SELECT 'context', $6 || '/direct-context-' || suffix, 'includes_mcp_server',
                'mcp_server', $7 || '/direct-mcp-' || suffix, 'direct-context-mcp-' || suffix,
                '{}'::jsonb, 'context', 'direct-context-uid-' || suffix FROM ids
         UNION ALL
         SELECT 'context', $6 || '/direct-context-' || suffix, 'mounts_shared_filesystem',
                'shared_filesystem', $8 || '/direct-files-' || suffix,
                'direct-context-files-' || suffix,
                jsonb_build_object('mountPath', '/workspace/' || suffix, 'readOnly', TRUE),
                'context', 'direct-context-uid-' || suffix FROM ids
         UNION ALL
         SELECT 'workflow_recipe', $9 || '/direct-recipe-' || suffix,
                'exposes_sandbox_app', 'sandbox_app', $9 || '/direct-recipe-' || suffix,
                'direct-recipe-app-' || suffix,
                jsonb_build_object('workloadRef', 'app', 'port', 8080, 'defaultPath', '/'),
                'workflow_recipe', 'direct-recipe-uid-' || suffix FROM ids
       )
       INSERT INTO operational_resource_relationships(
         environment_id, source_type, source_id, relationship_type, target_type, target_id,
         relationship_instance_id, behavior_attributes, source_family, source_provider_uid,
         source_resource_version, source_generation, content_bytes
       )
       SELECT $4, source_type, source_id, relationship_type, target_type, target_id,
              relationship_instance_id, behavior_attributes, source_family,
              source_provider_uid, '1', 1, 64
         FROM relationships`,
      [
        userId,
        first,
        last,
        environmentId,
        config.hostsNamespace,
        config.contextsNamespace,
        config.mcpServersNamespace,
        config.sharedFilesystemsNamespace,
        config.sandboxNamespace,
      ]
    )
    await databasePool.query(
      `WITH ids AS (
         SELECT value, LPAD(value::text, 5, '0') AS suffix
           FROM generate_series($2::int, $3::int) value
       )
       INSERT INTO workflow_runs(
         run_id, recipe_namespace, recipe_name, phase, actor_type, actor_id, trigger_source
       )
       SELECT gen_random_uuid(), $4, 'direct-recipe-' || suffix,
              'Succeeded', 'user', $1, 'onDemand'
         FROM ids`,
      [userId, first, last, config.sandboxNamespace]
    )
    await databasePool.query(
      `WITH ids AS (
         SELECT value, LPAD(value::text, 5, '0') AS suffix
           FROM generate_series($2::int, $3::int) value
       )
       INSERT INTO workflow_approval_requests(
         id, recipe_namespace, recipe_name, expires_at, status, target_user_id,
         payload, idempotency_key, payload_hash
       )
       SELECT gen_random_uuid(), $4, 'direct-recipe-' || suffix,
              NOW() + INTERVAL '1 hour', 'pending', $1, '{}'::jsonb,
              'direct-load-' || gen_random_uuid()::text, 'hash'
         FROM ids`,
      [userId, first, last, config.sandboxNamespace]
    )
    await databasePool.query(
      `WITH ids AS (
         SELECT value FROM generate_series($2::int, $3::int) value
       )
       INSERT INTO notification_deliveries(
         id, event_type, dedupe_key, audience, payload, status, expires_at
       )
       SELECT gen_random_uuid(), 'catalog.direct', 'direct-load-' || gen_random_uuid()::text,
              jsonb_build_object('userId', $1::text), '{}'::jsonb, 'queued',
              NOW() + INTERVAL '1 hour'
         FROM ids`,
      [userId, first, last]
    )
    await databasePool.query(
      `WITH ids AS (
         SELECT value, LPAD(value::text, 5, '0') AS suffix
           FROM generate_series($2::int, $3::int) value
       ), inserted AS (
         INSERT INTO gfs_resources(resource_id, drive, name, kind)
         SELECT gen_random_uuid(), 'direct-drive-' || suffix, '/', 'directory' FROM ids
         RETURNING resource_id, drive
       )
       INSERT INTO gfs_grants(drive, resource_id, subject_type, subject_id, permissions)
       SELECT drive, resource_id, 'user', $1::text, ARRAY['read']::text[] FROM inserted`,
      [userId, first, last]
    )
  }

  async function seedTeams(teamIds: readonly string[], resourcesPerTeam: number): Promise<void> {
    if (teamIds.length === 0) return
    const seriesValues = [teamIds, userId, resourcesPerTeam]
    const values = [...seriesValues, environmentId]
    await databasePool.query(
      `WITH requester AS (SELECT $2::uuid AS user_id), requested AS (
         SELECT team_id, ordinal FROM UNNEST($1::uuid[]) WITH ORDINALITY value(team_id, ordinal)
       ), inserted_teams AS (
         INSERT INTO teams(id, name)
         SELECT team_id, 'Load Team ' || team_id::text FROM requested
         ON CONFLICT (id) DO NOTHING RETURNING id
       )
       INSERT INTO team_members(team_id, user_id, role, status)
       SELECT team_id, $2, 'member', 'active' FROM requested
       ON CONFLICT (team_id, user_id) DO NOTHING`,
      [teamIds, userId]
    )
    await databasePool.query(
      `WITH requester AS (SELECT $2::uuid AS user_id), requested AS (
         SELECT team_id, ordinal FROM UNNEST($1::uuid[]) WITH ORDINALITY value(team_id, ordinal)
       ), ids AS (
         SELECT team_id,
                REPLACE(team_id::text, '-', '') || '-' || LPAD(value::text, 3, '0') AS suffix
           FROM requested CROSS JOIN generate_series(1, $3::int) value
       )
       INSERT INTO team_agents(team_id, agent_name)
       SELECT team_id, 'team-host-' || suffix FROM ids`,
      seriesValues
    )
    await databasePool.query(
      `WITH requester AS (SELECT $2::uuid AS user_id), requested AS (
         SELECT team_id, ordinal FROM UNNEST($1::uuid[]) WITH ORDINALITY value(team_id, ordinal)
       ), ids AS (
         SELECT team_id,
                REPLACE(team_id::text, '-', '') || '-' || LPAD(value::text, 3, '0') AS suffix
           FROM requested CROSS JOIN generate_series(1, $3::int) value
       )
       INSERT INTO team_contexts(team_id, context_id)
       SELECT team_id, 'team-context-' || suffix FROM ids`,
      seriesValues
    )
    await databasePool.query(
      `WITH requester AS (SELECT $2::uuid AS user_id), requested AS (
         SELECT team_id, ordinal FROM UNNEST($1::uuid[]) WITH ORDINALITY value(team_id, ordinal)
       ), ids AS (
         SELECT team_id,
                REPLACE(team_id::text, '-', '') || '-' || LPAD(value::text, 3, '0') AS suffix
           FROM requested CROSS JOIN generate_series(1, $3::int) value
       )
       INSERT INTO team_workflow_triggers(team_id, recipe_namespace, recipe_name)
       SELECT team_id, $4, 'team-recipe-' || suffix FROM ids`,
      [...seriesValues, config.sandboxNamespace]
    )
    await databasePool.query(
      `WITH requester AS (SELECT $2::uuid AS user_id), requested AS (
         SELECT team_id, ordinal FROM UNNEST($1::uuid[]) WITH ORDINALITY value(team_id, ordinal)
       ), ids AS (
         SELECT team_id,
                REPLACE(team_id::text, '-', '') || '-' || LPAD(value::text, 3, '0') AS suffix
           FROM requested CROSS JOIN generate_series(1, $3::int) value
       ), resources(resource_type, logical_id, source_family, provider_uid, display_name) AS (
         SELECT 'host', $5 || '/team-host-' || suffix, 'host',
                'team-host-uid-' || suffix, 'Team Host ' || suffix FROM ids
         UNION ALL
         SELECT 'context', $6 || '/team-context-' || suffix, 'context',
                'team-context-uid-' || suffix, 'Team Context ' || suffix FROM ids
         UNION ALL
         SELECT 'mcp_server', $7 || '/team-mcp-' || suffix, 'mcp_server',
                'team-mcp-uid-' || suffix, 'Team MCP ' || suffix FROM ids
         UNION ALL
         SELECT 'shared_filesystem', $8 || '/team-files-' || suffix, 'shared_filesystem',
                'team-files-uid-' || suffix, 'Team Files ' || suffix FROM ids
         UNION ALL
         SELECT 'workflow_recipe', $9 || '/team-recipe-' || suffix, 'workflow_recipe',
                'team-recipe-uid-' || suffix, 'Team Recipe ' || suffix FROM ids
         UNION ALL
         SELECT 'sandbox_app', $9 || '/team-recipe-' || suffix, 'workflow_recipe',
                'team-recipe-uid-' || suffix || ':ui', 'Team App ' || suffix FROM ids
       )
       INSERT INTO operational_resource_index(
         environment_id, resource_type, logical_id, source_family, source_generation,
         provider_uid, provider_resource_version, display_name, enabled, content_bytes
       )
       SELECT $4, resource_type, logical_id, source_family, 1,
              provider_uid, '1', display_name, TRUE, 128 FROM resources`,
      [
        teamIds,
        userId,
        resourcesPerTeam,
        environmentId,
        config.hostsNamespace,
        config.contextsNamespace,
        config.mcpServersNamespace,
        config.sharedFilesystemsNamespace,
        config.sandboxNamespace,
      ]
    )
    await databasePool.query(
      `WITH requester AS (SELECT $2::uuid AS user_id), requested AS (
         SELECT team_id, ordinal FROM UNNEST($1::uuid[]) WITH ORDINALITY value(team_id, ordinal)
       ), ids AS (
         SELECT team_id,
                REPLACE(team_id::text, '-', '') || '-' || LPAD(value::text, 3, '0') AS suffix
           FROM requested CROSS JOIN generate_series(1, $3::int) value
       ), relationships(
         source_type, source_id, relationship_type, target_type, target_id,
         relationship_instance_id, behavior_attributes, source_family,
         source_provider_uid
       ) AS (
         SELECT 'host', $5 || '/team-host-' || suffix, 'uses_context', 'context',
                $6 || '/team-context-' || suffix, 'team-host-context-' || suffix,
                '{}'::jsonb, 'host', 'team-host-uid-' || suffix FROM ids
         UNION ALL
         SELECT 'context', $6 || '/team-context-' || suffix, 'includes_mcp_server',
                'mcp_server', $7 || '/team-mcp-' || suffix, 'team-context-mcp-' || suffix,
                '{}'::jsonb, 'context', 'team-context-uid-' || suffix FROM ids
         UNION ALL
         SELECT 'context', $6 || '/team-context-' || suffix, 'mounts_shared_filesystem',
                'shared_filesystem', $8 || '/team-files-' || suffix,
                'team-context-files-' || suffix,
                jsonb_build_object('mountPath', '/workspace/' || suffix, 'readOnly', TRUE),
                'context', 'team-context-uid-' || suffix FROM ids
         UNION ALL
         SELECT 'workflow_recipe', $9 || '/team-recipe-' || suffix,
                'exposes_sandbox_app', 'sandbox_app', $9 || '/team-recipe-' || suffix,
                'team-recipe-app-' || suffix,
                jsonb_build_object('workloadRef', 'app', 'port', 8080, 'defaultPath', '/'),
                'workflow_recipe', 'team-recipe-uid-' || suffix FROM ids
       )
       INSERT INTO operational_resource_relationships(
         environment_id, source_type, source_id, relationship_type, target_type, target_id,
         relationship_instance_id, behavior_attributes, source_family, source_provider_uid,
         source_resource_version, source_generation, content_bytes
       )
       SELECT $4, source_type, source_id, relationship_type, target_type, target_id,
              relationship_instance_id, behavior_attributes, source_family,
              source_provider_uid, '1', 1, 64 FROM relationships`,
      [
        teamIds,
        userId,
        resourcesPerTeam,
        environmentId,
        config.hostsNamespace,
        config.contextsNamespace,
        config.mcpServersNamespace,
        config.sharedFilesystemsNamespace,
        config.sandboxNamespace,
      ]
    )
    await databasePool.query(
      `WITH requester AS (SELECT $2::uuid AS user_id), requested AS (
         SELECT team_id, ordinal FROM UNNEST($1::uuid[]) WITH ORDINALITY value(team_id, ordinal)
       ), ids AS (
         SELECT team_id,
                REPLACE(team_id::text, '-', '') || '-' || LPAD(value::text, 3, '0') AS suffix
           FROM requested CROSS JOIN generate_series(1, $3::int) value
       )
       INSERT INTO workflow_runs(
         run_id, recipe_namespace, recipe_name, phase, actor_type, actor_id,
         team_id, trigger_source
       )
       SELECT gen_random_uuid(), $4, 'team-recipe-' || suffix,
              'Succeeded', 'user', $2, team_id, 'onDemand' FROM ids`,
      [teamIds, userId, resourcesPerTeam, config.sandboxNamespace]
    )
    await databasePool.query(
      `WITH requester AS (SELECT $2::uuid AS user_id), requested AS (
         SELECT team_id, ordinal FROM UNNEST($1::uuid[]) WITH ORDINALITY value(team_id, ordinal)
       ), ids AS (
         SELECT team_id,
                REPLACE(team_id::text, '-', '') || '-' || LPAD(value::text, 3, '0') AS suffix
           FROM requested CROSS JOIN generate_series(1, $3::int) value
       )
       INSERT INTO workflow_approval_requests(
         id, recipe_namespace, recipe_name, expires_at, status, target_team_id,
         payload, idempotency_key, payload_hash
       )
       SELECT gen_random_uuid(), $4, 'team-recipe-' || suffix,
              NOW() + INTERVAL '1 hour', 'pending', team_id, '{}'::jsonb,
              'team-load-' || gen_random_uuid()::text, 'hash' FROM ids`,
      [teamIds, userId, resourcesPerTeam, config.sandboxNamespace]
    )
    await databasePool.query(
      `WITH requester AS (SELECT $2::uuid AS user_id), requested AS (
         SELECT team_id, ordinal FROM UNNEST($1::uuid[]) WITH ORDINALITY value(team_id, ordinal)
       ), ids AS (
         SELECT team_id,
                REPLACE(team_id::text, '-', '') || '-' || LPAD(value::text, 3, '0') AS suffix
           FROM requested CROSS JOIN generate_series(1, $3::int) value
       )
       INSERT INTO notification_deliveries(
         id, event_type, dedupe_key, audience, payload, status, expires_at
       )
       SELECT gen_random_uuid(), 'catalog.team', 'team-load-' || gen_random_uuid()::text,
              jsonb_build_object('teamId', team_id::text), '{}'::jsonb, 'queued',
              NOW() + INTERVAL '1 hour' FROM ids`,
      [teamIds, userId, resourcesPerTeam]
    )
    await databasePool.query(
      `WITH requester AS (SELECT $2::uuid AS user_id), requested AS (
         SELECT team_id, ordinal FROM UNNEST($1::uuid[]) WITH ORDINALITY value(team_id, ordinal)
       ), ids AS (
         SELECT team_id,
                REPLACE(team_id::text, '-', '') || '-' || LPAD(value::text, 3, '0') AS suffix
           FROM requested CROSS JOIN generate_series(1, $3::int) value
       ), inserted AS (
         INSERT INTO gfs_resources(resource_id, drive, name, kind)
         SELECT gen_random_uuid(), 'team-drive-' || suffix, '/', 'directory' FROM ids
         RETURNING resource_id, drive
       )
       INSERT INTO gfs_grants(drive, resource_id, subject_type, subject_id, permissions)
       SELECT resource.drive, resource.resource_id, 'team', requested.team_id::text,
              ARRAY['read']::text[]
         FROM inserted resource
         JOIN requested ON resource.drive LIKE '%' || REPLACE(requested.team_id::text, '-', '') || '%'`,
      [teamIds, userId, resourcesPerTeam]
    )
  }

  async function seedDuplicateTeamGfs(teamIds: readonly string[]): Promise<void> {
    if (teamIds.length === 0) return
    await databasePool.query(
      `INSERT INTO gfs_resources(resource_id, drive, name, kind)
       VALUES
         ('00000000-0000-4000-8000-000000000001', 'team-plan-duplicate-1', '/', 'directory'),
         ('00000000-0000-4000-8000-000000000002', 'team-plan-duplicate-2', '/', 'directory')
       ON CONFLICT (resource_id) DO NOTHING`
    )
    await databasePool.query(
      `WITH requested AS (SELECT UNNEST($1::uuid[])::text AS subject_id),
            resources AS (
              SELECT resource_id, drive
                FROM gfs_resources
               WHERE resource_id IN (
                 '00000000-0000-4000-8000-000000000001',
                 '00000000-0000-4000-8000-000000000002'
               )
            )
       INSERT INTO gfs_grants(drive, resource_id, subject_type, subject_id, permissions)
       SELECT resource.drive, resource.resource_id, 'team', requested.subject_id,
              ARRAY['read']::text[]
         FROM requested CROSS JOIN resources resource
       ON CONFLICT (drive, resource_id, subject_type, subject_id) DO NOTHING`,
      [teamIds]
    )
    await databasePool.query(
      `WITH requested AS (SELECT UNNEST($1::uuid[])::text AS subject_id),
            resources AS (
              SELECT resource_id, drive
                FROM gfs_resources
               WHERE resource_id IN (
                 '00000000-0000-4000-8000-000000000001',
                 '00000000-0000-4000-8000-000000000002'
               )
            )
       INSERT INTO gfs_shares(drive, resource_id, subject_type, subject_id, permissions)
       SELECT resource.drive, resource.resource_id, 'team', requested.subject_id,
              ARRAY['read']::text[]
         FROM requested CROSS JOIN resources resource
       ON CONFLICT (drive, resource_id, subject_type, subject_id) DO NOTHING`,
      [teamIds]
    )
  }

  function teamGfsRequests(teamIds: readonly string[], take: number): TeamGfsStreamRequest[] {
    return teamIds.flatMap(subjectId =>
      (['grant', 'share'] as const).map(kind => ({
        kind,
        subjectId,
        afterId: '00000000-0000-0000-0000-000000000000',
        take,
      }))
    )
  }

  async function explainTeamGfs(
    profile: string,
    requests: readonly TeamGfsStreamRequest[]
  ): Promise<void> {
    const result = await databasePool.query(
      `EXPLAIN (ANALYZE, BUFFERS, WAL, FORMAT JSON) ${teamGfsTopKSql.streamHead}`,
      [
        JSON.stringify(
          requests.map(request => ({
            kind: request.kind,
            subject_id: request.subjectId,
            after_id: request.afterId,
            take: request.take,
          }))
        ),
      ]
    )
    const explained = queryPlan(result.rows[0])
    const nodes = planNodes(explained.Plan)
    const indexNames = new Set(
      nodes.flatMap(node => (typeof node['Index Name'] === 'string' ? [node['Index Name']] : []))
    )
    if (profile.startsWith('high-')) {
      expect(indexNames, `${profile}:grant-index`).toContain(
        'gfs_grants_subject_resource_catalog_idx'
      )
      expect(indexNames, `${profile}:share-index`).toContain(
        'gfs_shares_subject_resource_catalog_idx'
      )
    }
    const perStreamTake = Math.max(...requests.map(request => request.take), 0)
    const rowEnvelope = requests.length * perStreamTake
    const relationWork = (relation: string) =>
      nodes
        .filter(node => node['Relation Name'] === relation)
        .reduce(
          (total, node) =>
            total +
            numberField(node, 'Actual Loops') *
              (numberField(node, 'Actual Rows') + numberField(node, 'Rows Removed by Filter')),
          0
        )
    expect(relationWork('gfs_grants'), `${profile}:grant-work`).toBeLessThanOrEqual(rowEnvelope)
    expect(relationWork('gfs_shares'), `${profile}:share-work`).toBeLessThanOrEqual(rowEnvelope)
    if (profile.startsWith('high-')) {
      expect(relationWork('gfs_resources'), `${profile}:resource-work`).toBeLessThanOrEqual(
        rowEnvelope
      )
    }
    const sharedBlocks =
      numberField(explained.Plan, 'Shared Hit Blocks') +
      numberField(explained.Plan, 'Shared Read Blocks')
    expect(sharedBlocks, `${profile}:shared-blocks`).toBeLessThanOrEqual(rowEnvelope * 8 + 256)
    for (const node of nodes) {
      expect(String(node['Sort Method'] ?? ''), `${profile}:sort`).not.toContain('external')
      expect(numberField(node, 'Temp Read Blocks'), `${profile}:temp-read`).toBe(0)
      expect(numberField(node, 'Temp Written Blocks'), `${profile}:temp-write`).toBe(0)
    }
    console.info(
      `[access-catalog-team-gfs-plan:${profile}] ${JSON.stringify({
        streams: requests.length,
        perStreamTake,
        rows: numberField(explained.Plan, 'Actual Rows'),
        grantWork: relationWork('gfs_grants'),
        shareWork: relationWork('gfs_shares'),
        resourceWork: relationWork('gfs_resources'),
        sharedBlocks,
        tempReadBlocks: nodes.reduce(
          (total, node) => total + numberField(node, 'Temp Read Blocks'),
          0
        ),
        tempWrittenBlocks: nodes.reduce(
          (total, node) => total + numberField(node, 'Temp Written Blocks'),
          0
        ),
        planningMs: Number(explained['Planning Time'] ?? 0),
        executionMs: Number(explained['Execution Time'] ?? 0),
        indexes: [...indexNames].sort(),
      })}`
    )
  }

  async function measureTeamGfsTopK(
    profile: string,
    teamIds: readonly string[],
    take: number
  ): Promise<void> {
    let statementCount = 0
    const merged = await collectTeamGfsTopK({
      streams: teamGfsRequests(teamIds, 1).map(({ kind, subjectId, afterId }) => ({
        kind,
        subjectId,
        afterId,
      })),
      take,
      read: async requests => {
        statementCount += 1
        const result = await databasePool.query(teamGfsTopKSql.streamHead, [
          JSON.stringify(
            requests.map(request => ({
              kind: request.kind,
              subject_id: request.subjectId,
              after_id: request.afterId,
              take: request.take,
            }))
          ),
        ])
        const lastByStream = new Map<string, string>()
        for (const row of result.rows as Array<Record<string, string>>) {
          lastByStream.set(`${row.kind}:${row.subject_id}`, row.logical_id)
        }
        return (result.rows as Array<Record<string, string>>).map(row => ({
          kind: row.kind as 'grant' | 'share',
          subjectId: row.subject_id,
          logicalId: row.logical_id,
          batchLast: lastByStream.get(`${row.kind}:${row.subject_id}`) === row.logical_id,
        }))
      },
    })
    const expected = await databasePool.query<{ logical_id: string }>(
      `SELECT resource_id::text AS logical_id
         FROM (
           SELECT grant_row.resource_id
             FROM gfs_grants grant_row
            WHERE grant_row.subject_type = 'team'
              AND grant_row.subject_id = ANY($1::text[])
           UNION
           SELECT share.resource_id
             FROM gfs_shares share
            WHERE share.subject_type = 'team'
              AND share.subject_id = ANY($1::text[])
         ) authorized
         JOIN gfs_resources resource USING (resource_id)
        WHERE resource.deleted_at IS NULL
        ORDER BY resource_id
        LIMIT $2`,
      [teamIds, take + 1]
    )
    expect(merged.logicalIds, `${profile}:composition`).toEqual(
      expected.rows.map(row => row.logical_id)
    )
    expect(statementCount, `${profile}:statement-envelope`).toBeLessThanOrEqual(take + 2)
    console.info(
      `[access-catalog-team-gfs-merge:${profile}] ${JSON.stringify({
        memberships: teamIds.length,
        take,
        statements: statementCount,
        candidates: merged.logicalIds.length,
      })}`
    )
  }

  async function analyzeAndExplain(profile: string): Promise<void> {
    await databasePool.query(`ANALYZE`)
    const metrics: Array<Record<string, unknown>> = []
    const profileIndexes = new Set<string>()
    for (const family of CATALOG_FAMILIES) {
      const result = await databasePool.query(
        `EXPLAIN (ANALYZE, BUFFERS, WAL, FORMAT JSON) ${CATALOG_KEY_SQL[family]}`,
        [
          userId,
          '',
          environmentId,
          101,
          config.hostsNamespace,
          config.contextsNamespace,
          '',
          '{}',
          null,
        ]
      )
      const explained = queryPlan(result.rows[0])
      const nodes = planNodes(explained.Plan)
      const boundedEnvelope = armCounts[family] * 101
      const boundedNodes = nodes.filter(node =>
        /Sort|Aggregate|Unique/.test(String(node['Node Type'] ?? ''))
      )
      expect(
        numberField(explained.Plan, 'Actual Rows'),
        `${profile}:${family}:rows`
      ).toBeLessThanOrEqual(101)
      for (const node of boundedNodes) {
        expect(
          numberField(node, 'Actual Rows'),
          `${profile}:${family}:${node['Node Type']}`
        ).toBeLessThanOrEqual(boundedEnvelope)
        expect(String(node['Sort Method'] ?? '')).not.toContain('external')
      }
      const indexNames = nodes
        .flatMap(node => (typeof node['Index Name'] === 'string' ? [node['Index Name']] : []))
        .sort()
      indexNames.forEach(indexName => profileIndexes.add(indexName))
      metrics.push({
        family,
        rows: numberField(explained.Plan, 'Actual Rows'),
        planningMs: Number(explained['Planning Time'] ?? 0),
        executionMs: Number(explained['Execution Time'] ?? 0),
        sharedHitBlocks: nodes.reduce(
          (total, node) => total + numberField(node, 'Shared Hit Blocks'),
          0
        ),
        sharedReadBlocks: nodes.reduce(
          (total, node) => total + numberField(node, 'Shared Read Blocks'),
          0
        ),
        tempReadBlocks: nodes.reduce(
          (total, node) => total + numberField(node, 'Temp Read Blocks'),
          0
        ),
        tempWrittenBlocks: nodes.reduce(
          (total, node) => total + numberField(node, 'Temp Written Blocks'),
          0
        ),
        walRecords: nodes.reduce((total, node) => total + numberField(node, 'WAL Records'), 0),
        indexes: indexNames,
      })
    }
    if (profile === 'high-cardinality') {
      for (const requiredIndex of [
        'operational_relationship_source_idx',
        'operational_resource_index_pkey',
      ]) {
        expect(profileIndexes.has(requiredIndex), requiredIndex).toBe(true)
      }
    }
    console.info(`[access-catalog-plan:${profile}] ${JSON.stringify(metrics)}`)
  }

  it('measures every bounded producer on direct, typical, and high-cardinality data', async () => {
    await seedDirect(1, DIRECT_ONLY_RESOURCES)
    await analyzeAndExplain('direct-only')

    await seedTeams(allTeamIds.slice(0, TYPICAL_TEAMS), TYPICAL_RESOURCES_PER_TEAM)
    await seedDuplicateTeamGfs(allTeamIds.slice(0, TYPICAL_TEAMS))
    await analyzeAndExplain('typical-multi-team')
    await explainTeamGfs(
      'typical-multi-team',
      teamGfsRequests(allTeamIds.slice(0, TYPICAL_TEAMS), 8)
    )
    await measureTeamGfsTopK('typical-multi-team', allTeamIds.slice(0, TYPICAL_TEAMS), 2)

    await seedDirect(DIRECT_ONLY_RESOURCES + 1, HIGH_DIRECT_RESOURCES)
    await seedTeams(allTeamIds.slice(TYPICAL_TEAMS), HIGH_RESOURCES_PER_TEAM)
    await seedDuplicateTeamGfs(allTeamIds)
    await analyzeAndExplain('high-cardinality')
    await explainTeamGfs('high-dense-and-duplicate', teamGfsRequests(allTeamIds, 8))
    await explainTeamGfs('high-duplicate-saturated', teamGfsRequests(allTeamIds, 2))
    await explainTeamGfs(
      'high-sparse',
      teamGfsRequests(
        [allTeamIds[0]!, ...Array.from({ length: HIGH_TEAMS - 1 }, () => randomUUID())],
        2
      )
    )
    await measureTeamGfsTopK('high-duplicate-saturated', allTeamIds, 2)
    await measureTeamGfsTopK('high-maximum-page', allTeamIds, 100)
  }, 30_000)

  it('bounds coordinator query count and composes keyset pages', async () => {
    const observation = new CatalogQueryObservation()
    const measuredTransaction = async <T>(work: (db: DbClient) => Promise<T>): Promise<T> => {
      const client = (await databasePool.connect()) as PoolClient
      const measured: DbClient = {
        query: async (text, values) => {
          observation.observe(text)
          return client.query(text, values)
        },
      }
      try {
        await client.query('BEGIN')
        const value = await work(measured)
        await client.query('COMMIT')
        return value
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    }

    const first = await buildAccessCatalog(
      { session, families: CATALOG_FAMILIES, limit: 100 },
      {
        transaction: measuredTransaction,
        teamGfsMembershipAdmissionLimit: HIGH_TEAMS,
      }
    )
    expect(first.items).toHaveLength(100)
    expect(first.nextCursor).not.toBeNull()
    expect(observation.workCount).toBeLessThanOrEqual(40)
    expect(observation.unexpected).toEqual([])

    const nextObservation = new CatalogQueryObservation()
    const second = await buildAccessCatalog(
      { session, families: CATALOG_FAMILIES, limit: 100, cursor: first.nextCursor },
      {
        transaction: async work => {
          const client = (await databasePool.connect()) as PoolClient
          const measured: DbClient = {
            query: async (text, values) => {
              nextObservation.observe(text)
              return client.query(text, values)
            },
          }
          try {
            await client.query('BEGIN')
            const value = await work(measured)
            await client.query('COMMIT')
            return value
          } catch (error) {
            await client.query('ROLLBACK')
            throw error
          } finally {
            client.release()
          }
        },
        teamGfsMembershipAdmissionLimit: HIGH_TEAMS,
      }
    )
    expect(second.items).toHaveLength(100)
    expect(nextObservation.workCount).toBeLessThanOrEqual(40)
    expect(nextObservation.unexpected).toEqual([])
    const firstIds = new Set(first.items.map(item => item.resource.canonicalId))
    expect(second.items.every(item => !firstIds.has(item.resource.canonicalId))).toBe(true)

    await databasePool.query(
      `UPDATE operational_catalog_source_state
          SET generation = generation + 1, resource_version = '2'
        WHERE environment_id = $1 AND source_family = 'context'`,
      [environmentId]
    )
    await expect(
      buildAccessCatalog(
        { session, families: CATALOG_FAMILIES, limit: 100, cursor: first.nextCursor },
        {
          transaction: measuredTransaction,
          teamGfsMembershipAdmissionLimit: HIGH_TEAMS,
        }
      )
    ).rejects.toBeInstanceOf(AccessCatalogCursorError)
  })
})
