import { Pool, type PoolConfig } from 'pg'

export type PoolConstructor = new (config: PoolConfig) => Pool

export type BoundedPoolBudget = {
  max: number
  idleTimeoutMillis: number
  connectionTimeoutMillis: number
  statementTimeoutMillis: number
}

const LIMITS: Record<keyof BoundedPoolBudget, readonly [number, number]> = {
  max: [1, 64],
  idleTimeoutMillis: [1_000, 120_000],
  connectionTimeoutMillis: [100, 30_000],
  statementTimeoutMillis: [100, 30_000],
}

export function createBoundedPgPoolForConnection(
  connectionString: string,
  budget: BoundedPoolBudget,
  PoolClass: PoolConstructor = Pool
): Pool {
  for (const [name, value] of Object.entries(budget) as Array<[keyof BoundedPoolBudget, number]>) {
    const [min, max] = LIMITS[name]
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`Invalid bounded Postgres pool budget: ${name}`)
    }
  }
  return new PoolClass({
    connectionString,
    max: budget.max,
    idleTimeoutMillis: budget.idleTimeoutMillis,
    connectionTimeoutMillis: budget.connectionTimeoutMillis,
    statement_timeout: budget.statementTimeoutMillis,
  })
}
