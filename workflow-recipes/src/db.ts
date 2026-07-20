/**
 * Postgres client for the Workflow Recipes Controller.
 *
 * This service does NOT own the schema — `control-api/src/db.ts` owns
 * `createSchema()` and is responsible for `workflow_runs`, `workflow_run_steps`,
 * `workflow_runs_audit`, and the `workflow_run_update` pg_notify trigger.
 *
 * WRC is a *consumer*: it acquires session-scoped `pg_advisory_lock` for
 * leader election, drains Pending/Running runs with `FOR UPDATE SKIP LOCKED`,
 * and listens on the `workflow_run_update` notification channel.
 *
 * Fase 4 (DB-first runs) — plan §ADR-001 (leader election with zero K8s-API
 * load) and §Fase 4 (WRC DB-driven).
 */
import { Pool, type PoolClient, type PoolConfig } from 'pg'
import type { DbConfig } from './config.js'
import { createLogger } from './observability/logger.js'

const log = createLogger('wrc', 'db')

let pool: Pool | null = null

export function createPoolConfig(cfg: DbConfig): PoolConfig {
  const endpoint: PoolConfig = cfg.connectionString
    ? { connectionString: cfg.connectionString }
    : {
        host: cfg.host,
        port: cfg.port,
        user: cfg.user,
        password: cfg.password,
        database: cfg.database,
      }

  return {
    ...endpoint,
    ...(cfg.ssl ? { ssl: { rejectUnauthorized: false } } : {}),
    max: cfg.poolMax,
    // Fail fast on connection attempts rather than hanging.
    connectionTimeoutMillis: 5_000,
    // Keep idle connections long enough to service LISTEN + bursty polls.
    idleTimeoutMillis: 60_000,
  }
}

export function initDb(cfg: DbConfig): Pool {
  if (pool) return pool

  const poolConfig = createPoolConfig(cfg)

  const p = new Pool(poolConfig)
  // Pool-level error listener is mandatory — a single client error without a
  // listener crashes the process via 'error' event propagation.
  p.on('error', (err: Error) => {
    log.error('pg pool error', { err: err.message })
  })

  pool = p
  log.info('pg pool initialized', {
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    poolMax: cfg.poolMax,
  })
  return p
}

export function getPool(): Pool {
  if (!pool) throw new Error('db: initDb() must be called before getPool()')
  return pool
}

/** Test seam — allow unit tests to swap the module-level pool. */
export function __setPoolForTests(p: Pool | null): void {
  pool = p
}

export async function closeDb(): Promise<void> {
  if (!pool) return
  const p = pool
  pool = null
  await p.end()
}

/**
 * Acquire a dedicated client for operations that must stay on one session.
 * Use for: `pg_advisory_lock` (session-scoped), `LISTEN`, long-running
 * transactions. The caller is responsible for `client.release()`.
 */
export async function connectDedicated(): Promise<PoolClient> {
  return getPool().connect()
}

/**
 * Run a short transaction on a pool-managed client. Mirrors the `withTransaction`
 * helper in `control-api/src/db.ts`. Do NOT use this for operations that hold
 * session-scoped advisory locks — the client is released back to the pool
 * after COMMIT/ROLLBACK, which releases the lock.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // Swallow rollback errors — the original error is the one worth raising.
    }
    throw err
  } finally {
    client.release()
  }
}
