import type { DbClient } from '../db.js'
import { MIGRATION_EXECUTION_POLICY } from './migrationExecutionPolicy.js'
import { type RUNNER_MIGRATION_VERSIONS, runBoundedTransaction } from './migrationRunner.js'

export type OnlineIndexDefinition = Readonly<{
  migrationVersion: (typeof RUNNER_MIGRATION_VERSIONS)[number]
  // An after-schema index is built once its migration's schema transaction has
  // committed, because it indexes a column that transaction adds.
  phase?: 'after-schema'
  name: string
  table: string
  unique?: boolean
  keys: readonly string[]
  include?: readonly string[]
  // The predicate exactly as PostgreSQL 16's pg_get_indexdef prints it,
  // parentheses included. It is also the predicate the index is created with.
  where?: string
  // An index this one supersedes; it is dropped once this one is valid.
  replaces?: string
  createSql: string
}>

type OnlineIndexStructure = Omit<OnlineIndexDefinition, 'createSql'>

// Every planned index is a btree over bare columns. Quoted identifiers and
// expressions are unrepresentable, and a predicate is stored in its deparsed
// form, so PostgreSQL's definition can be compared byte for byte without a
// normalizer.
const PLAIN_IDENTIFIER = /^[a-z_][a-z0-9_]*$/

function assertPlainIdentifier(value: string, role: string, indexName: string): void {
  if (!PLAIN_IDENTIFIER.test(value)) {
    throw new Error(`Online index ${indexName} has a non-plain ${role}: ${JSON.stringify(value)}`)
  }
}

function indexColumnsSql(entry: OnlineIndexStructure): string {
  const include = entry.include ? ` INCLUDE (${entry.include.join(', ')})` : ''
  const where = entry.where === undefined ? '' : ` WHERE ${entry.where}`
  return `(${entry.keys.join(', ')})${include}${where}`
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
  if (
    structure.where !== undefined &&
    (!structure.where.startsWith('(') || !structure.where.endsWith(')'))
  ) {
    throw new Error(`Online index ${structure.name} has a predicate outside its deparsed form`)
  }
  if (structure.replaces !== undefined) {
    assertPlainIdentifier(structure.replaces, 'replaced index', structure.name)
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
    migrationVersion: '0137_user_access_foundation',
    name: 'team_members_user_active_idx',
    table: 'team_members',
    keys: ['user_id', 'status', 'team_id'],
    include: ['role', 'updated_at'],
  }),
  onlineIndex({
    migrationVersion: '0137_user_access_foundation',
    name: 'user_contexts_context_user_idx',
    table: 'user_contexts',
    keys: ['context_id', 'user_id'],
  }),
  onlineIndex({
    migrationVersion: '0137_user_access_foundation',
    name: 'team_contexts_context_team_idx',
    table: 'team_contexts',
    keys: ['context_id', 'team_id'],
  }),
  onlineIndex({
    migrationVersion: '0137_user_access_foundation',
    name: 'user_agents_agent_user_idx',
    table: 'user_agents',
    keys: ['agent_name', 'user_id'],
  }),
  onlineIndex({
    migrationVersion: '0137_user_access_foundation',
    name: 'team_agents_agent_team_idx',
    table: 'team_agents',
    keys: ['agent_name', 'team_id'],
  }),
])

export const PR2_ONLINE_INDEX_PLAN: readonly OnlineIndexDefinition[] = Object.freeze([
  onlineIndex({
    migrationVersion: '0139_workflow_authority_bindings',
    phase: 'after-schema',
    name: 'workflow_runs_initiating_authority_binding',
    table: 'workflow_runs',
    keys: ['initiating_authority_binding_id'],
    where: '(initiating_authority_binding_id IS NOT NULL)',
  }),
  onlineIndex({
    migrationVersion: '0144_workflow_authorization_pause',
    phase: 'after-schema',
    name: 'idx_wr_phase_v2',
    table: 'workflow_runs',
    keys: ['phase'],
    where: "(phase = ANY (ARRAY['Pending'::text, 'Running'::text, 'AuthorizationPaused'::text]))",
    replaces: 'idx_wr_phase',
  }),
  onlineIndex({
    migrationVersion: '0144_workflow_authorization_pause',
    phase: 'after-schema',
    name: 'idx_wr_owner_v2',
    table: 'workflow_runs',
    keys: ['owner_instance_id'],
    where: "(phase = ANY (ARRAY['Running'::text, 'AuthorizationPaused'::text]))",
    replaces: 'idx_wr_owner',
  }),
])

const ONLINE_INDEX_PLAN: readonly OnlineIndexDefinition[] = Object.freeze([
  ...PR1_ONLINE_INDEX_PLAN,
  ...PR2_ONLINE_INDEX_PLAN,
])

export type PostSchemaConstraintValidation = Readonly<{
  migrationVersion: (typeof RUNNER_MIGRATION_VERSIONS)[number]
  table: string
  constraint: string
}>

function constraintValidation(
  entry: PostSchemaConstraintValidation
): PostSchemaConstraintValidation {
  for (const [role, value] of [
    ['table', entry.table],
    ['constraint', entry.constraint],
  ] as const) {
    if (!PLAIN_IDENTIFIER.test(value)) {
      throw new Error(
        `Constraint validation ${entry.constraint} has a non-plain ${role}: ${JSON.stringify(value)}`
      )
    }
  }
  return Object.freeze({ ...entry })
}

// Constraints that PR2 adds NOT VALID to tables readers already use. Adding a
// constraint NOT VALID skips the scan that a validating ADD CONSTRAINT runs
// under ACCESS EXCLUSIVE; each is validated after its migration's schema
// transaction commits, under SHARE UPDATE EXCLUSIVE, so reads and writes
// continue during the scan.
export const PR2_POST_SCHEMA_CONSTRAINT_VALIDATIONS: readonly PostSchemaConstraintValidation[] =
  Object.freeze([
    constraintValidation({
      migrationVersion: '0139_workflow_authority_bindings',
      table: 'workflow_runs',
      constraint: 'workflow_runs_initiating_authority_binding_id_fkey',
    }),
    constraintValidation({
      migrationVersion: '0139_workflow_authority_bindings',
      table: 'workflow_approval_requests',
      constraint: 'workflow_approval_requests_trigger_authority_binding_id_fkey',
    }),
    constraintValidation({
      migrationVersion: '0139_workflow_authority_bindings',
      table: 'workflow_approval_requests',
      constraint: 'workflow_approval_requests_decision_authority_binding_id_fkey',
    }),
    constraintValidation({
      migrationVersion: '0139_workflow_authority_bindings',
      table: 'workflow_approval_requests',
      constraint: 'workflow_approval_requests_consume_authority_binding_id_fkey',
    }),
    constraintValidation({
      migrationVersion: '0140_gfs_upload_authority_bindings',
      table: 'gfs_upload_sessions',
      constraint: 'gfs_upload_sessions_action_authority_object',
    }),
    constraintValidation({
      migrationVersion: '0143_workflow_run_failure_reason',
      table: 'workflow_runs',
      constraint: 'workflow_runs_failure_reason_check',
    }),
    constraintValidation({
      migrationVersion: '0144_workflow_authorization_pause',
      table: 'workflow_runs',
      constraint: 'workflow_runs_phase_check',
    }),
    constraintValidation({
      migrationVersion: '0144_workflow_authorization_pause',
      table: 'workflow_runs',
      constraint: 'workflow_runs_failure_reason_check',
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

/**
 * True when a migration has work that must follow its schema transaction: an
 * after-schema online index or a constraint validation.
 */
export function hasPostSchemaWork(version: string): boolean {
  return (
    ONLINE_INDEX_PLAN.some(
      entry => entry.migrationVersion === version && entry.phase === 'after-schema'
    ) || PR2_POST_SCHEMA_CONSTRAINT_VALIDATIONS.some(entry => entry.migrationVersion === version)
  )
}

/**
 * Runs the planned online work of one migration and phase. With no phase it
 * builds the indexes that precede the schema transaction. With 'after-schema'
 * it builds the ones that follow it, drops each index they replace, and then
 * validates the migration's NOT VALID constraints, each in its own bounded
 * transaction. VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE, so it must
 * run after the schema transaction has released the ACCESS EXCLUSIVE lock its
 * ADD CONSTRAINT took; on a valid constraint it is a no-op, so a rerun passes.
 */
export async function preparePr1Migration(
  db: DbClient,
  version: string,
  phase?: 'after-schema'
): Promise<void> {
  const indexes = ONLINE_INDEX_PLAN.filter(
    entry => entry.migrationVersion === version && entry.phase === phase
  )
  for (const index of indexes) {
    await ensureOnlineIndex(db, index)
    const replaced = index.replaces
    if (replaced !== undefined) {
      // IF EXISTS: a rerun after a crash between the build and the drop must pass.
      await withOnlineStatementBound(db, async () => {
        await db.query(`DROP INDEX CONCURRENTLY IF EXISTS ${replaced}`)
      })
    }
  }
  if (phase !== 'after-schema') return
  const validations = PR2_POST_SCHEMA_CONSTRAINT_VALIDATIONS.filter(
    entry => entry.migrationVersion === version
  )
  for (const validation of validations) {
    await runBoundedTransaction(db, async () => {
      // The online bound, scoped to this transaction: a session-level reset
      // after a failed VALIDATE would itself fail in the aborted transaction
      // and replace the VALIDATE error.
      await db.query(
        `SET LOCAL statement_timeout = '${MIGRATION_EXECUTION_POLICY.onlineIndexStatementTimeoutMs}ms'`
      )
      await db.query(`ALTER TABLE ${validation.table} VALIDATE CONSTRAINT ${validation.constraint}`)
    })
  }
}
