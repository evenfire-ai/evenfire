import type { DbClient } from '../../db.js'
import { runAccessDatabaseQuery } from './accessDatabaseQuery.js'
import type { AccessExecutionBudget } from './accessExecutionBudget.js'

export async function query(
  db: Pick<DbClient, 'query'>,
  budget: AccessExecutionBudget,
  text: string,
  values: unknown[]
) {
  return runAccessDatabaseQuery(db, budget, text, values)
}
