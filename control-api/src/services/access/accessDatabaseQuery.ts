import { Client, type ClientConfig } from 'pg'
import type { DbClient } from '../../db.js'
import { AccessBudgetExceededError, type AccessExecutionBudget } from './accessExecutionBudget.js'

type PostgresConnectionParameters = Readonly<{
  user?: unknown
  database?: unknown
  port?: unknown
  host?: unknown
  password?: unknown
  ssl?: unknown
}>

type PostgresCancellationTarget = Pick<DbClient, 'query'> &
  Readonly<{
    processID?: unknown
    connectionParameters?: PostgresConnectionParameters
  }>

function boundedPort(value: unknown): number | undefined {
  const port = Number(value)
  return Number.isSafeInteger(port) && port > 0 && port <= 65_535 ? port : undefined
}

function connectionText(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

async function cancelPostgresBackend(db: PostgresCancellationTarget): Promise<void> {
  const processId = Number(db.processID)
  const parameters = db.connectionParameters
  if (!Number.isSafeInteger(processId) || processId <= 0 || !parameters) return
  const client = new Client({
    user: connectionText(parameters.user),
    database: connectionText(parameters.database),
    port: boundedPort(parameters.port),
    host: connectionText(parameters.host),
    password: parameters.password as ClientConfig['password'],
    ssl: parameters.ssl as ClientConfig['ssl'],
    connectionTimeoutMillis: 1_000,
  })
  try {
    await client.connect()
    await client.query('SELECT pg_cancel_backend($1)', [processId])
  } finally {
    await client.end().catch(() => undefined)
  }
}

function isStatementTimeout(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const value = error as { code?: unknown; message?: unknown }
  return (
    value.code === '57014' &&
    typeof value.message === 'string' &&
    value.message.toLowerCase().includes('statement timeout')
  )
}

/**
 * Runs one PostgreSQL statement under the request budget. Real PoolClients are
 * cancelled through a separate connection when the shared AbortSignal fires;
 * test doubles without backend identity still receive late-result rejection.
 */
export async function runAccessDatabaseQuery(
  db: Pick<DbClient, 'query'>,
  budget: AccessExecutionBudget,
  text: string,
  values: unknown[] = [],
  options: { chargeRows?: boolean } = {}
) {
  return budget.runProducer(async signal => {
    budget.assertActive()
    let cancellation: Promise<void> | undefined
    const onAbort = () => {
      cancellation ??= cancelPostgresBackend(db as PostgresCancellationTarget).catch(
        () => undefined
      )
    }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      const result = await db.query(text, values)
      budget.assertActive()
      if (options.chargeRows !== false && result.rows.length > 0) {
        budget.charge({ kind: 'dbRowsReturned', amount: result.rows.length })
      }
      return result
    } catch (error) {
      if (signal.aborted) budget.assertActive()
      if (isStatementTimeout(error)) {
        throw new AccessBudgetExceededError('deadline', true)
      }
      throw error
    } finally {
      signal.removeEventListener('abort', onAbort)
      void cancellation
    }
  })
}
