import type { DbClient } from '../../db.js'
import { runAccessDatabaseQuery } from './accessDatabaseQuery.js'
import type { AccessExecutionBudget } from './accessExecutionBudget.js'

/** Shared request-scoped database execution boundary for catalog producers. */
export async function catalogQuery(
  db: Pick<DbClient, 'query'>,
  budget: AccessExecutionBudget,
  text: string,
  values: unknown[],
  options: { chargeProducer?: boolean } = {}
) {
  return runAccessDatabaseQuery(db, budget, text, values, options)
}
