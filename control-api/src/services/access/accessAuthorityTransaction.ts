import type { DbClient } from '../../db.js'
import type { AccessExecutionBudget } from './accessExecutionBudget.js'

export async function configureAccessAuthorityTransaction(
  db: Pick<DbClient, 'query'>,
  budget: AccessExecutionBudget
): Promise<void> {
  await budget.runProducer(async () => {
    budget.assertActive()
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await db.query(`SELECT set_config('statement_timeout', $1, true)`, [
      `${budget.statementTimeoutMs()}ms`,
    ])
    budget.assertActive()
  })
}
