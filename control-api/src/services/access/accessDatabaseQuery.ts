import { Client, type ClientConfig, type PoolClient } from 'pg'
import { type DbClient, pool } from '../../db.js'
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
  options: { chargeRows?: boolean; chargeProducer?: boolean } = {}
) {
  const run =
    options.chargeProducer === false
      ? budget.runBoundedWork.bind(budget)
      : budget.runProducer.bind(budget)
  return run(async signal => {
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
      if (cancellation) await cancellation
    }
  })
}

async function acquireAccessDatabaseClient(
  budget: AccessExecutionBudget,
  connectionPool: Pick<typeof pool, 'connect'>
): Promise<PoolClient> {
  let acquired: PoolClient | undefined
  let acquiredReleased = false
  const releaseAcquired = (error?: Error | boolean) => {
    if (!acquired || acquiredReleased) return
    acquiredReleased = true
    acquired.release(error)
  }
  try {
    return await budget.runBoundedWork(
      signal =>
        new Promise<PoolClient>((resolve, reject) => {
          let settled = false
          const rejectForAbort = () => {
            if (settled) return
            settled = true
            try {
              budget.assertActive()
            } catch (error) {
              reject(error)
            }
          }
          signal.addEventListener('abort', rejectForAbort, { once: true })
          if (signal.aborted) rejectForAbort()
          Promise.resolve(connectionPool.connect()).then(
            client => {
              acquired = client as PoolClient
              if (settled) {
                releaseAcquired(true)
                return
              }
              settled = true
              signal.removeEventListener('abort', rejectForAbort)
              resolve(acquired)
            },
            error => {
              if (settled) return
              settled = true
              signal.removeEventListener('abort', rejectForAbort)
              reject(error)
            }
          )
        })
    )
  } catch (error) {
    releaseAcquired(error instanceof Error ? error : true)
    throw error
  }
}

export async function withAccessDatabaseTransaction<T>(
  budget: AccessExecutionBudget,
  work: (db: DbClient) => Promise<T>,
  options: {
    mode?: 'read_only' | 'read_write' | 'caller_configured'
    connectionPool?: Pick<typeof pool, 'connect'>
  } = {}
): Promise<T> {
  budget.assertActive()
  const client = await acquireAccessDatabaseClient(budget, options.connectionPool ?? pool)
  let transactionStarted = false
  let commitSent = false
  let releaseError: Error | boolean | undefined
  const query = (text: string, values?: unknown[]) =>
    runAccessDatabaseQuery(client, budget, text, values ?? [])
  const budgetedDb = Object.assign(Object.create(client), { query }) as DbClient
  try {
    budget.assertActive()
    await runAccessDatabaseQuery(client, budget, 'BEGIN', [], {
      chargeRows: false,
      chargeProducer: false,
    })
    transactionStarted = true
    if (options.mode !== 'caller_configured') {
      if (options.mode === 'read_only') {
        await runAccessDatabaseQuery(client, budget, 'SET TRANSACTION READ ONLY', [], {
          chargeRows: false,
          chargeProducer: false,
        })
      }
      await runAccessDatabaseQuery(
        client,
        budget,
        `SELECT set_config('statement_timeout', $1, true)`,
        [`${budget.statementTimeoutMs()}ms`],
        { chargeRows: false, chargeProducer: false }
      )
    }
    const result = await work(
      options.mode === 'caller_configured' ? (client as DbClient) : budgetedDb
    )
    budget.assertActive()
    commitSent = true
    await runAccessDatabaseQuery(client, budget, 'COMMIT', [], {
      chargeRows: false,
      chargeProducer: false,
    })
    return result
  } catch (error) {
    if (commitSent || !transactionStarted) {
      releaseError = error instanceof Error ? error : true
    } else {
      try {
        await runAccessDatabaseQuery(client, budget, 'ROLLBACK', [], {
          chargeRows: false,
          chargeProducer: false,
        })
      } catch (rollbackError) {
        releaseError = rollbackError instanceof Error ? rollbackError : true
      }
    }
    throw error
  } finally {
    client.release(releaseError)
  }
}
