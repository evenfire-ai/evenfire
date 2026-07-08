/**
 * Generic database operations to reduce code duplication.
 *
 * Replaces copy-pasted functions like setUserContexts, setTeamContexts, etc.
 */
import { withTransaction } from '../db.js'

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
  items: string[]
): Promise<LinkedItemsResult> {
  const unique = [...new Set(items.map(v => String(v).trim()).filter(Boolean))]

  return withTransaction(async db => {
    await db.query(`DELETE FROM ${tableName} WHERE ${idColumn} = ${deleteWhereParam(idColumn)}`, [
      id,
    ])

    if (unique.length === 0) {
      return { items: [] }
    }

    await db.query(
      `INSERT INTO ${tableName}(${idColumn}, ${itemColumn})
       SELECT ${bulkSelectIdExpr(idColumn)}, ${bulkUnnestExpr(itemColumn)}
       ON CONFLICT (${idColumn}, ${itemColumn}) DO NOTHING`,
      [id, unique]
    )

    return { items: unique }
  })
}
