import type { Mock } from 'vitest'
import { PR1_ONLINE_INDEX_PLAN } from '../../src/migrations/pr1OnlineIndexPlan.js'

type QueryResult = { rows: unknown[]; rowCount: number | null }

/**
 * Adds the minimum PostgreSQL index-catalog behavior to legacy initDb mocks.
 * The wrapped mock still records and owns every query/result outside the new
 * D34 catalog boundary.
 */
export function onlineIndexAwareQuery(
  query: Mock
): (sql: string, values?: unknown[]) => Promise<QueryResult> {
  const states = new Map<
    string,
    {
      table_name: string
      indisunique: boolean
      indisvalid: boolean
      definition: string
    }
  >()

  return async (sql: string, values?: unknown[]): Promise<QueryResult> => {
    const result = (await query(sql, values)) as QueryResult
    if (sql.includes('FROM pg_class index_rel')) {
      const state = states.get(String(values?.[0]))
      return { rows: state ? [state] : [], rowCount: state ? 1 : 0 }
    }
    if (sql.startsWith('DROP INDEX CONCURRENTLY')) {
      states.delete(sql.trim().split(/\s+/).at(-1) ?? '')
    }
    if (sql.startsWith('CREATE INDEX CONCURRENTLY')) {
      const entry = PR1_ONLINE_INDEX_PLAN.find(candidate => candidate.createSql === sql)
      if (entry) {
        states.set(entry.name, {
          table_name: entry.table,
          indisunique: Boolean(entry.unique),
          indisvalid: true,
          definition: entry.createSql,
        })
      }
    }
    return result
  }
}
