import type { DbClient } from '../db.js'
import { MIGRATION_EXECUTION_POLICY } from './migrationExecutionPolicy.js'

export type OnlineIndexDefinition = Readonly<{
  migrationVersion: '0131_user_access_foundation'
  name: string
  table: string
  unique?: boolean
  keys: readonly string[]
  include?: readonly string[]
  createSql: string
}>

type OnlineIndexStructure = Omit<OnlineIndexDefinition, 'createSql'>

// Every planned index is a plain btree over bare columns. Quoted identifiers,
// expressions and predicates are unrepresentable, so PostgreSQL's deparsed
// definition can be compared byte for byte without a normalizer.
const PLAIN_IDENTIFIER = /^[a-z_][a-z0-9_]*$/

function assertPlainIdentifier(value: string, role: string, indexName: string): void {
  if (!PLAIN_IDENTIFIER.test(value)) {
    throw new Error(`Online index ${indexName} has a non-plain ${role}: ${JSON.stringify(value)}`)
  }
}

function indexColumnsSql(entry: OnlineIndexStructure): string {
  const include = entry.include ? ` INCLUDE (${entry.include.join(', ')})` : ''
  return `(${entry.keys.join(', ')})${include}`
}

export function onlineIndex(structure: OnlineIndexStructure): OnlineIndexDefinition {
  assertPlainIdentifier(structure.name, 'name', structure.name)
  assertPlainIdentifier(structure.table, 'table', structure.name)
  if (structure.keys.length === 0) throw new Error(`Online index ${structure.name} has no keys`)
  for (const key of structure.keys) assertPlainIdentifier(key, 'key', structure.name)
  if (structure.include && structure.include.length === 0) {
    throw new Error(`Online index ${structure.name} has an empty INCLUDE list`)
  }
  for (const column of structure.include ?? []) {
    assertPlainIdentifier(column, 'INCLUDE column', structure.name)
  }
  const unique = structure.unique ? 'UNIQUE ' : ''
  return Object.freeze({
    ...structure,
    keys: Object.freeze([...structure.keys]),
    ...(structure.include ? { include: Object.freeze([...structure.include]) } : {}),
    createSql: `CREATE ${unique}INDEX CONCURRENTLY ${structure.name} ON ${structure.table} ${indexColumnsSql(structure)}`,
  })
}

/** The exact text PostgreSQL 16's pg_get_indexdef returns for a planned index. */
export function expectedIndexDefinition(entry: OnlineIndexDefinition, schema: string): string {
  assertPlainIdentifier(schema, 'schema', entry.name)
  const unique = entry.unique ? 'UNIQUE ' : ''
  return `CREATE ${unique}INDEX ${entry.name} ON ${schema}.${entry.table} USING btree ${indexColumnsSql(entry)}`
}

export const PR1_ONLINE_INDEX_PLAN: readonly OnlineIndexDefinition[] = Object.freeze([
  onlineIndex({
    migrationVersion: '0131_user_access_foundation',
    name: 'team_members_user_active_idx',
    table: 'team_members',
    keys: ['user_id', 'status', 'team_id'],
    include: ['role', 'updated_at'],
  }),
  onlineIndex({
    migrationVersion: '0131_user_access_foundation',
    name: 'user_contexts_context_user_idx',
    table: 'user_contexts',
    keys: ['context_id', 'user_id'],
  }),
  onlineIndex({
    migrationVersion: '0131_user_access_foundation',
    name: 'team_contexts_context_team_idx',
    table: 'team_contexts',
    keys: ['context_id', 'team_id'],
  }),
  onlineIndex({
    migrationVersion: '0131_user_access_foundation',
    name: 'user_agents_agent_user_idx',
    table: 'user_agents',
    keys: ['agent_name', 'user_id'],
  }),
  onlineIndex({
    migrationVersion: '0131_user_access_foundation',
    name: 'team_agents_agent_team_idx',
    table: 'team_agents',
    keys: ['agent_name', 'team_id'],
  }),
])

type IndexState = {
  schema_name: string
  table_name: string
  indisunique: boolean
  indisvalid: boolean
  definition: string
}

async function readIndexState(db: DbClient, name: string): Promise<IndexState | undefined> {
  const result = await db.query(
    `SELECT index_ns.nspname AS schema_name,
            table_rel.relname AS table_name,
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
    state.definition !== expectedIndexDefinition(entry, state.schema_name)
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

export async function preparePr1Migration(db: DbClient, version: string): Promise<void> {
  const indexes = PR1_ONLINE_INDEX_PLAN.filter(entry => entry.migrationVersion === version)
  if (indexes.length === 0) return
  for (const index of indexes) await ensureOnlineIndex(db, index)
}
