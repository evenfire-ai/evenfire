import type { DbClient } from '../db.js'
import {
  MIGRATION_EXECUTION_POLICY,
  migrationSessionBoundsSql,
} from './migrationExecutionPolicy.js'

export type OnlineIndexDefinition = Readonly<{
  migrationVersion: '0107_user_access_foundation' | '0109_catalog_utf8_ordering'
  name: string
  table: string
  unique?: boolean
  createSql: string
}>

export const PR1_ONLINE_INDEX_PLAN: readonly OnlineIndexDefinition[] = Object.freeze([
  {
    migrationVersion: '0107_user_access_foundation',
    name: 'team_members_user_active_idx',
    table: 'team_members',
    createSql: `CREATE INDEX CONCURRENTLY team_members_user_active_idx
      ON team_members (user_id, status, team_id) INCLUDE (role, updated_at)`,
  },
  {
    migrationVersion: '0107_user_access_foundation',
    name: 'user_contexts_context_user_idx',
    table: 'user_contexts',
    createSql: `CREATE INDEX CONCURRENTLY user_contexts_context_user_idx
      ON user_contexts (context_id, user_id)`,
  },
  {
    migrationVersion: '0107_user_access_foundation',
    name: 'team_contexts_context_team_idx',
    table: 'team_contexts',
    createSql: `CREATE INDEX CONCURRENTLY team_contexts_context_team_idx
      ON team_contexts (context_id, team_id)`,
  },
  {
    migrationVersion: '0107_user_access_foundation',
    name: 'user_agents_agent_user_idx',
    table: 'user_agents',
    createSql: `CREATE INDEX CONCURRENTLY user_agents_agent_user_idx
      ON user_agents (agent_name, user_id)`,
  },
  {
    migrationVersion: '0107_user_access_foundation',
    name: 'team_agents_agent_team_idx',
    table: 'team_agents',
    createSql: `CREATE INDEX CONCURRENTLY team_agents_agent_team_idx
      ON team_agents (agent_name, team_id)`,
  },
  {
    migrationVersion: '0107_user_access_foundation',
    name: 'user_workflow_triggers_recipe_user_idx',
    table: 'user_workflow_triggers',
    createSql: `CREATE INDEX CONCURRENTLY user_workflow_triggers_recipe_user_idx
      ON user_workflow_triggers (recipe_namespace, recipe_name, user_id)`,
  },
  {
    migrationVersion: '0107_user_access_foundation',
    name: 'team_workflow_triggers_recipe_team_idx',
    table: 'team_workflow_triggers',
    createSql: `CREATE INDEX CONCURRENTLY team_workflow_triggers_recipe_team_idx
      ON team_workflow_triggers (recipe_namespace, recipe_name, team_id)`,
  },
  {
    migrationVersion: '0107_user_access_foundation',
    name: 'user_workflow_triggers_catalog_key_idx',
    table: 'user_workflow_triggers',
    createSql: `CREATE INDEX CONCURRENTLY user_workflow_triggers_catalog_key_idx
      ON user_workflow_triggers (user_id, ((recipe_namespace || '/'::text) || recipe_name))`,
  },
  {
    migrationVersion: '0107_user_access_foundation',
    name: 'team_workflow_triggers_catalog_key_idx',
    table: 'team_workflow_triggers',
    createSql: `CREATE INDEX CONCURRENTLY team_workflow_triggers_catalog_key_idx
      ON team_workflow_triggers (((recipe_namespace || '/'::text) || recipe_name), team_id)`,
  },
  {
    migrationVersion: '0107_user_access_foundation',
    name: 'workflow_runs_actor_catalog_idx',
    table: 'workflow_runs',
    createSql: `CREATE INDEX CONCURRENTLY workflow_runs_actor_catalog_idx
      ON workflow_runs (actor_id, run_id)
      INCLUDE (recipe_namespace, recipe_name, phase, team_id, usage_team_id)
      WHERE actor_type = 'user' AND actor_id IS NOT NULL`,
  },
  {
    migrationVersion: '0107_user_access_foundation',
    name: 'workflow_runs_team_catalog_idx',
    table: 'workflow_runs',
    createSql: `CREATE INDEX CONCURRENTLY workflow_runs_team_catalog_idx
      ON workflow_runs (team_id, run_id)
      INCLUDE (recipe_namespace, recipe_name, phase, actor_type, actor_id, usage_team_id)
      WHERE team_id IS NOT NULL`,
  },
  {
    migrationVersion: '0107_user_access_foundation',
    name: 'workflow_runs_usage_team_catalog_idx',
    table: 'workflow_runs',
    createSql: `CREATE INDEX CONCURRENTLY workflow_runs_usage_team_catalog_idx
      ON workflow_runs (usage_team_id, run_id)
      INCLUDE (recipe_namespace, recipe_name, phase, actor_type, actor_id, team_id)
      WHERE usage_team_id IS NOT NULL`,
  },
  {
    migrationVersion: '0107_user_access_foundation',
    name: 'workflow_approval_user_catalog_idx',
    table: 'workflow_approval_requests',
    createSql: `CREATE INDEX CONCURRENTLY workflow_approval_user_catalog_idx
      ON workflow_approval_requests (target_user_id, id)
      INCLUDE (status, expires_at, recipe_namespace, recipe_name)
      WHERE target_user_id IS NOT NULL`,
  },
  {
    migrationVersion: '0107_user_access_foundation',
    name: 'workflow_approval_team_catalog_idx',
    table: 'workflow_approval_requests',
    createSql: `CREATE INDEX CONCURRENTLY workflow_approval_team_catalog_idx
      ON workflow_approval_requests (target_team_id, id)
      INCLUDE (status, expires_at, recipe_namespace, recipe_name)
      WHERE target_team_id IS NOT NULL`,
  },
  {
    migrationVersion: '0107_user_access_foundation',
    name: 'notification_user_catalog_idx',
    table: 'notification_deliveries',
    createSql: `CREATE INDEX CONCURRENTLY notification_user_catalog_idx
      ON notification_deliveries ((audience->>'userId'), id)
      INCLUDE (expires_at, status, event_type) WHERE audience ? 'userId'`,
  },
  {
    migrationVersion: '0107_user_access_foundation',
    name: 'notification_team_catalog_idx',
    table: 'notification_deliveries',
    createSql: `CREATE INDEX CONCURRENTLY notification_team_catalog_idx
      ON notification_deliveries ((audience->>'teamId'), id)
      INCLUDE (expires_at, status, event_type) WHERE audience ? 'teamId'`,
  },
  {
    migrationVersion: '0107_user_access_foundation',
    name: 'gfs_grants_subject_resource_catalog_idx',
    table: 'gfs_grants',
    createSql: `CREATE INDEX CONCURRENTLY gfs_grants_subject_resource_catalog_idx
      ON gfs_grants (subject_type, subject_id, resource_id)
      INCLUDE (id, drive, permissions, inherit)`,
  },
  {
    migrationVersion: '0107_user_access_foundation',
    name: 'gfs_shares_subject_resource_catalog_idx',
    table: 'gfs_shares',
    createSql: `CREATE INDEX CONCURRENTLY gfs_shares_subject_resource_catalog_idx
      ON gfs_shares (subject_type, subject_id, resource_id)
      INCLUDE (id, drive, permissions, include_descendants)`,
  },
  {
    migrationVersion: '0109_catalog_utf8_ordering',
    name: 'user_agents_catalog_utf8_idx',
    table: 'user_agents',
    createSql: `CREATE INDEX CONCURRENTLY user_agents_catalog_utf8_idx
      ON user_agents (user_id, catalog_utf8_bytes(agent_name))`,
  },
  {
    migrationVersion: '0109_catalog_utf8_ordering',
    name: 'team_agents_catalog_utf8_idx',
    table: 'team_agents',
    createSql: `CREATE INDEX CONCURRENTLY team_agents_catalog_utf8_idx
      ON team_agents (catalog_utf8_bytes(agent_name), team_id)`,
  },
  {
    migrationVersion: '0109_catalog_utf8_ordering',
    name: 'user_contexts_catalog_utf8_idx',
    table: 'user_contexts',
    createSql: `CREATE INDEX CONCURRENTLY user_contexts_catalog_utf8_idx
      ON user_contexts (user_id, catalog_utf8_bytes(context_id))`,
  },
  {
    migrationVersion: '0109_catalog_utf8_ordering',
    name: 'team_contexts_catalog_utf8_idx',
    table: 'team_contexts',
    createSql: `CREATE INDEX CONCURRENTLY team_contexts_catalog_utf8_idx
      ON team_contexts (catalog_utf8_bytes(context_id), team_id)`,
  },
  {
    migrationVersion: '0109_catalog_utf8_ordering',
    name: 'user_workflow_triggers_catalog_utf8_idx',
    table: 'user_workflow_triggers',
    createSql: `CREATE INDEX CONCURRENTLY user_workflow_triggers_catalog_utf8_idx
      ON user_workflow_triggers
      (user_id, catalog_utf8_bytes(recipe_namespace || '/' || recipe_name))`,
  },
  {
    migrationVersion: '0109_catalog_utf8_ordering',
    name: 'team_workflow_triggers_catalog_utf8_idx',
    table: 'team_workflow_triggers',
    createSql: `CREATE INDEX CONCURRENTLY team_workflow_triggers_catalog_utf8_idx
      ON team_workflow_triggers
      (catalog_utf8_bytes(recipe_namespace || '/' || recipe_name), team_id)`,
  },
  {
    migrationVersion: '0109_catalog_utf8_ordering',
    name: 'operational_relationship_catalog_utf8_target_idx',
    table: 'operational_resource_relationships',
    createSql: `CREATE INDEX CONCURRENTLY operational_relationship_catalog_utf8_target_idx
      ON operational_resource_relationships
      (environment_id, target_type, relationship_type, catalog_utf8_bytes(target_id))`,
  },
])

export const canonicalOnlineIndexDefinition = (value: string): string =>
  value
    .toLowerCase()
    .replaceAll('"', '')
    .replace(/\bconcurrently\b/g, '')
    .replace(/\bif\s+not\s+exists\b/g, '')
    .replace(/\bpublic\./g, '')
    .replace(/\busing\s+btree\b/g, '')
    .replace(/::text\b/g, '')
    .replace(/;\s*$/, '')
    // PostgreSQL's deparser adds redundant grouping around expressions and
    // predicates. The complete token order, commas, operators, table, and
    // uniqueness remain, so different keys/includes/predicates still differ.
    .replace(/[()]/g, ' ')
    .replace(/\s*,\s*/g, ',')
    .replace(/\s+/g, ' ')
    .trim()

type IndexState = {
  table_name: string
  indisunique: boolean
  indisvalid: boolean
  definition: string
}

async function readIndexState(db: DbClient, name: string): Promise<IndexState | undefined> {
  const result = await db.query(
    `SELECT table_rel.relname AS table_name,
            index_meta.indisunique,
            index_meta.indisvalid,
            pg_get_indexdef(index_meta.indexrelid) AS definition
       FROM pg_class index_rel
       JOIN pg_namespace index_ns ON index_ns.oid = index_rel.relnamespace
       JOIN pg_index index_meta ON index_meta.indexrelid = index_rel.oid
       JOIN pg_class table_rel ON table_rel.oid = index_meta.indrelid
      WHERE index_ns.nspname = current_schema()
        AND index_rel.relname = $1`,
    [name]
  )
  return result.rows[0] as IndexState | undefined
}

function assertEquivalentIndex(entry: OnlineIndexDefinition, state: IndexState): void {
  if (
    state.table_name !== entry.table ||
    state.indisunique !== Boolean(entry.unique) ||
    canonicalOnlineIndexDefinition(state.definition) !==
      canonicalOnlineIndexDefinition(entry.createSql)
  ) {
    throw new Error(`Non-equivalent existing index: ${entry.name}`)
  }
}

async function withOnlineStatementBound(db: DbClient, work: () => Promise<void>): Promise<void> {
  await db.query(
    `SET statement_timeout = '${MIGRATION_EXECUTION_POLICY.onlineIndexStatementTimeoutMs}ms'`
  )
  try {
    await work()
  } finally {
    await db.query(
      `SET statement_timeout = '${MIGRATION_EXECUTION_POLICY.ordinaryStatementTimeoutMs}ms'`
    )
  }
}

export async function ensureOnlineIndex(db: DbClient, entry: OnlineIndexDefinition): Promise<void> {
  const existing = await readIndexState(db, entry.name)
  if (existing) {
    assertEquivalentIndex(entry, existing)
    if (existing.indisvalid) return
    await withOnlineStatementBound(db, async () => {
      await db.query(`DROP INDEX CONCURRENTLY ${entry.name}`)
    })
  }

  await withOnlineStatementBound(db, async () => {
    await db.query(entry.createSql)
  })
  const created = await readIndexState(db, entry.name)
  if (!created) throw new Error(`Online index was not created: ${entry.name}`)
  assertEquivalentIndex(entry, created)
  if (!created.indisvalid) throw new Error(`Online index is invalid after creation: ${entry.name}`)
}

async function prepareCatalogUtf8Function(db: DbClient): Promise<void> {
  let started = false
  try {
    await db.query('BEGIN')
    started = true
    for (const sql of migrationSessionBoundsSql(true)) await db.query(sql)
    await db.query(`
      CREATE OR REPLACE FUNCTION catalog_utf8_bytes(value TEXT)
      RETURNS BYTEA
      LANGUAGE SQL
      IMMUTABLE
      STRICT
      PARALLEL SAFE
      AS $$
        SELECT convert_to(value, 'UTF8');
      $$
    `)
    await db.query('COMMIT')
    started = false
  } catch (error) {
    if (started) {
      try {
        await db.query('ROLLBACK')
      } catch {
        // The migration owner destroys the session on failure.
      }
    }
    throw error
  }
}

export async function preparePr1Migration(db: DbClient, version: string): Promise<void> {
  const indexes = PR1_ONLINE_INDEX_PLAN.filter(entry => entry.migrationVersion === version)
  if (indexes.length === 0) return
  if (version === '0109_catalog_utf8_ordering') await prepareCatalogUtf8Function(db)
  for (const index of indexes) await ensureOnlineIndex(db, index)
}
