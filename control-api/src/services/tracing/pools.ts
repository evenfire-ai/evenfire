import { Pool, type PoolClient } from 'pg'
import {
  type BoundedPoolBudget,
  type PoolConstructor,
  createBoundedPgPoolForConnection,
} from '../../boundedPgPool.js'
import type { DbClient } from '../../db.js'
import {
  governedTracePoolAcquisitionDurationSeconds,
  governedTracePoolConnections,
  governedTracePoolRejectionsTotal,
  governedTracePoolStatementTimeoutsTotal,
  recordGovernedTraceOperationalError,
} from '../../observability/metrics.js'
import {
  type TracingPoolOperationalLimits,
  getTracingMaintenancePoolMax,
  getTracingPoolOperationalLimits,
} from './operationalLimits.js'

export type TracingPools = {
  traceIngestPool: Pool
  traceReadPool: Pool
}

const DEFAULT_MAINTENANCE_STATEMENT_TIMEOUT_MS = 30_000

type TracePoolMetricLabel = 'ingest' | 'read' | 'maintenance'
type TracePoolKind = 'ingest' | 'read' | 'maintenance'

function poolBudget(
  max: number,
  statementTimeoutMillis: number,
  limits: Pick<TracingPoolOperationalLimits, 'idleTimeoutMs' | 'connectionTimeoutMs'>
): BoundedPoolBudget {
  return {
    max,
    idleTimeoutMillis: limits.idleTimeoutMs,
    connectionTimeoutMillis: limits.connectionTimeoutMs,
    statementTimeoutMillis,
  }
}

function fallbackRequestTracingConnectionString(): string {
  return (
    process.env.CONTROL_API_PG_CONNECTION_STRING ??
    (process.env.NODE_ENV === 'test' ? 'postgresql://localhost/tracing_test' : '')
  )
}

function tracingConnectionString(kind: TracePoolKind): string {
  const envName =
    kind === 'ingest'
      ? 'TRACING_INGEST_PG_CONNECTION_STRING'
      : kind === 'read'
        ? 'TRACING_READ_PG_CONNECTION_STRING'
        : 'TRACING_MAINTENANCE_PG_CONNECTION_STRING'
  const connectionString =
    kind === 'maintenance'
      ? process.env[envName]
      : (process.env[envName] ?? fallbackRequestTracingConnectionString())
  if (!connectionString?.trim()) {
    const requirement =
      kind === 'maintenance' ? envName : `${envName} or CONTROL_API_PG_CONNECTION_STRING`
    throw new Error(`${requirement} is required`)
  }
  return connectionString
}

function createTraceIngestPool(
  PoolClass: PoolConstructor = Pool,
  limits = getTracingPoolOperationalLimits()
): Pool {
  return createBoundedPgPoolForConnection(
    tracingConnectionString('ingest'),
    poolBudget(limits.ingestPoolMax, limits.ingestStatementTimeoutMs, limits),
    PoolClass
  )
}

function createTraceReadPool(
  PoolClass: PoolConstructor = Pool,
  limits = getTracingPoolOperationalLimits()
): Pool {
  return createBoundedPgPoolForConnection(
    tracingConnectionString('read'),
    poolBudget(limits.readPoolMax, limits.readStatementTimeoutMs, limits),
    PoolClass
  )
}

export function createTraceMaintenancePool(PoolClass: PoolConstructor = Pool): Pool {
  const limits = getTracingPoolOperationalLimits()
  return createBoundedPgPoolForConnection(
    tracingConnectionString('maintenance'),
    poolBudget(getTracingMaintenancePoolMax(), DEFAULT_MAINTENANCE_STATEMENT_TIMEOUT_MS, limits),
    PoolClass
  )
}

export function createTracingPools(PoolClass: PoolConstructor = Pool): TracingPools {
  const limits = getTracingPoolOperationalLimits()
  return {
    traceIngestPool: createTraceIngestPool(PoolClass, limits),
    traceReadPool: createTraceReadPool(PoolClass, limits),
  }
}

let pools: TracingPools | undefined
let maintenancePool: Pool | undefined

export function getTracingPools(): TracingPools {
  pools ??= createTracingPools()
  return pools
}

export function getTraceMaintenancePool(): Pool {
  maintenancePool ??= createTraceMaintenancePool()
  return maintenancePool
}

export async function closeTraceMaintenancePool(): Promise<void> {
  const pool = maintenancePool
  if (!pool) return

  await pool.end()
  if (maintenancePool === pool) maintenancePool = undefined
}

async function releaseAfterRollback(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK')
  } finally {
    client.release()
  }
}

function observePoolConnections(pool: Pool, label: TracePoolMetricLabel): void {
  const total = Number(pool.totalCount ?? 0)
  const idle = Number(pool.idleCount ?? 0)
  governedTracePoolConnections.set({ pool: label, state: 'active' }, Math.max(0, total - idle))
  governedTracePoolConnections.set({ pool: label, state: 'idle' }, idle)
  governedTracePoolConnections.set(
    { pool: label, state: 'waiting' },
    Number(pool.waitingCount ?? 0)
  )
}

function recordStatementTimeout(error: unknown, label: TracePoolMetricLabel): void {
  const candidate = error as { code?: unknown; message?: unknown }
  if (
    candidate?.code === '57014' ||
    (typeof candidate?.message === 'string' && candidate.message.includes('statement timeout'))
  ) {
    governedTracePoolStatementTimeoutsTotal.inc({ pool: label })
    if (label !== 'maintenance') {
      recordGovernedTraceOperationalError(label === 'read' ? 'read' : 'pool', 'statement_timeout')
    }
  }
}

async function acquireTraceClient(pool: Pool, label: TracePoolMetricLabel): Promise<PoolClient> {
  const startedAt = process.hrtime.bigint()
  try {
    const pendingConnection = pool.connect()
    observePoolConnections(pool, label)
    return await pendingConnection
  } catch (error) {
    governedTracePoolRejectionsTotal.inc({ pool: label })
    if (label !== 'maintenance') {
      recordGovernedTraceOperationalError('pool', 'pool_rejected')
    }
    throw error
  } finally {
    governedTracePoolAcquisitionDurationSeconds.observe(
      { pool: label },
      Number(process.hrtime.bigint() - startedAt) / 1e9
    )
    observePoolConnections(pool, label)
  }
}

export async function withTraceIngestTransaction<T>(
  work: (db: DbClient) => Promise<T>
): Promise<T> {
  const client = await acquireTraceClient(getTracingPools().traceIngestPool, 'ingest')
  let released = false
  try {
    await client.query('BEGIN')
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    recordStatementTimeout(error, 'ingest')
    await releaseAfterRollback(client)
    released = true
    throw error
  } finally {
    if (!released) client.release()
    observePoolConnections(getTracingPools().traceIngestPool, 'ingest')
  }
}

export async function withTraceReadTransaction<T>(work: (db: DbClient) => Promise<T>): Promise<T> {
  const client = await acquireTraceClient(getTracingPools().traceReadPool, 'read')
  let released = false
  try {
    await client.query('BEGIN READ ONLY')
    await client.query("SELECT set_config('statement_timeout', $1, true)", [
      getTracingPoolOperationalLimits().readStatementTimeoutMs,
    ])
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    recordStatementTimeout(error, 'read')
    await releaseAfterRollback(client)
    released = true
    throw error
  } finally {
    if (!released) client.release()
    observePoolConnections(getTracingPools().traceReadPool, 'read')
  }
}

export async function withTraceMaintenanceClient<T>(
  work: (db: PoolClient) => Promise<T>
): Promise<T> {
  const pool = getTraceMaintenancePool()
  const client = await acquireTraceClient(pool, 'maintenance')
  try {
    return await work(client)
  } catch (error) {
    recordStatementTimeout(error, 'maintenance')
    throw error
  } finally {
    client.release()
    observePoolConnections(pool, 'maintenance')
  }
}
