/**
 * Generic database operations to reduce code duplication.
 *
 * Replaces copy-pasted functions like setUserContexts, setTeamContexts, etc.
 */
import { type DbClient, withTransaction } from '../db.js'

/** Junction-table columns that are PostgreSQL UUID (see `initDb` in db.ts). */
const UUID_LINK_COLUMNS = new Set(['user_id', 'team_id'])

function sqlParamForUuidColumn(column: string, placeholder: '$1' | '$2'): string {
  return UUID_LINK_COLUMNS.has(column) ? `${placeholder}::uuid` : placeholder
}

function deleteWhereParam(idColumn: string): string {
  return sqlParamForUuidColumn(idColumn, '$1')
}

function bulkSelectIdExpr(idColumn: string): string {
  return sqlParamForUuidColumn(idColumn, '$1')
}

function bulkUnnestExpr(itemColumn: string): string {
  return UUID_LINK_COLUMNS.has(itemColumn) ? 'unnest($2::uuid[])' : 'unnest($2::text[])'
}

export interface LinkedItemsResult {
  items: string[]
}

export type LinkedItemsChangeHandler = (
  db: DbClient,
  change: { added: string[]; removed: string[]; items: string[] }
) => Promise<void>

export class LinkedItemsPreconditionError extends Error {
  constructor() {
    super('linked items changed before replacement')
    this.name = 'LinkedItemsPreconditionError'
  }
}

export interface BulkSetLinkedItemsOptions {
  expectedItems?: string[]
}

function normalizeLinkedItems(items: string[]): string[] {
  return [...new Set(items.map(value => String(value).trim()).filter(Boolean))]
}

function linkedItemSetsEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  const rightSet = new Set(right)
  return left.every(item => rightSet.has(item))
}

/**
 * Replace all links for `id` in a many-to-many junction table with `items`.
 *
 * Destructive semantics: an empty `items` array clears all existing links.
 *
 * Used by:
 * - setUserContexts / setTeamContexts
 * - setUserAgents / setTeamAgents (and reverse directions)
 */
export async function bulkSetLinkedItems(
  tableName: string,
  idColumn: string,
  id: string,
  itemColumn: string,
  items: string[],
  onChange?: LinkedItemsChangeHandler,
  options: BulkSetLinkedItemsOptions = {}
): Promise<LinkedItemsResult> {
  const unique = normalizeLinkedItems(items)
  const expected = options.expectedItems ? normalizeLinkedItems(options.expectedItems) : undefined

  return withTransaction(async db => {
    await db.query(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [
      `linked_items:${tableName}:${idColumn}:${id}`,
    ])
    // CAS callers need serialization against every writer, including inverse
    // association routes and direct INSERTs that do not share this advisory key.
    // PostgreSQL's table lock is transaction-scoped and is taken before reading
    // the expected set, so a stale replacement cannot overwrite concurrent work.
    if (expected) {
      await db.query(`LOCK TABLE ${tableName} IN SHARE ROW EXCLUSIVE MODE`)
    }
    const beforeResult = await db.query(
      `SELECT ${itemColumn}::text AS item
         FROM ${tableName}
        WHERE ${idColumn} = ${deleteWhereParam(idColumn)}
     ORDER BY ${itemColumn} ASC
        FOR UPDATE`,
      [id]
    )
    const before = beforeResult.rows.map(row => String((row as { item: string }).item))

    if (expected && !linkedItemSetsEqual(before, expected)) {
      throw new LinkedItemsPreconditionError()
    }

    await db.query(`DELETE FROM ${tableName} WHERE ${idColumn} = ${deleteWhereParam(idColumn)}`, [
      id,
    ])

    if (unique.length > 0) {
      await db.query(
        `INSERT INTO ${tableName}(${idColumn}, ${itemColumn})
         SELECT ${bulkSelectIdExpr(idColumn)}, ${bulkUnnestExpr(itemColumn)}
         ON CONFLICT (${idColumn}, ${itemColumn}) DO NOTHING`,
        [id, unique]
      )
    }

    const beforeSet = new Set(before)
    const afterSet = new Set(unique)
    const added = unique.filter(item => !beforeSet.has(item))
    const removed = before.filter(item => !afterSet.has(item))
    if (onChange && (added.length > 0 || removed.length > 0)) {
      await onChange(db, { added, removed, items: unique })
    }

    return { items: unique }
  })
}
