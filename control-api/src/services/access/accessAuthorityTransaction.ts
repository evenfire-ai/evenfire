import type { DbClient } from '../../db.js'
import { runAccessDatabaseQuery } from './accessDatabaseQuery.js'
import type { AccessExecutionBudget } from './accessExecutionBudget.js'

export async function configureAccessAuthorityTransaction(
  db: Pick<DbClient, 'query'>,
  budget: AccessExecutionBudget
): Promise<void> {
  await runAccessDatabaseQuery(
    db,
    budget,
    'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
    [],
    { chargeRows: false }
  )
  await runAccessDatabaseQuery(
    db,
    budget,
    `SELECT set_config('statement_timeout', $1, true)`,
    [`${budget.statementTimeoutMs()}ms`],
    { chargeRows: false }
  )
}
