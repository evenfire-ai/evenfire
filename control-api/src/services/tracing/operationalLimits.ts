export const TRACING_JSON_BODY_LIMIT_BYTES = 512 * 1024
export const TRACING_MAX_BATCH_SIZE = 100
export const TRACING_DEFAULT_MAX_IN_FLIGHT = 32

const DEFAULT_INGEST_POOL_MAX = 4
const DEFAULT_READ_POOL_MAX = 3
const DEFAULT_MAINTENANCE_POOL_MAX = 1
const DEFAULT_IDLE_TIMEOUT_MS = 30_000
const DEFAULT_CONNECTION_TIMEOUT_MS = 2_000
const DEFAULT_INGEST_STATEMENT_TIMEOUT_MS = 5_000
const DEFAULT_READ_STATEMENT_TIMEOUT_MS = 2_000
const DEFAULT_RECENT_ERROR_SECONDS = 300

export type TracingPoolOperationalLimits = {
  ingestPoolMax: number
  readPoolMax: number
  idleTimeoutMs: number
  connectionTimeoutMs: number
  ingestStatementTimeoutMs: number
  readStatementTimeoutMs: number
}

function boundedEnvInteger(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback
}

export function getTracingMaxInFlight(): number {
  const raw = process.env.TRACING_MAX_IN_FLIGHT?.trim()
  if (!raw) return TRACING_DEFAULT_MAX_IN_FLIGHT
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1_000) {
    throw new Error('TRACING_MAX_IN_FLIGHT must be an integer between 1 and 1000')
  }
  return parsed
}

export function getTracingPoolOperationalLimits(): TracingPoolOperationalLimits {
  return {
    ingestPoolMax: boundedEnvInteger('TRACING_INGEST_POOL_MAX', DEFAULT_INGEST_POOL_MAX, 1, 16),
    readPoolMax: boundedEnvInteger('TRACING_READ_POOL_MAX', DEFAULT_READ_POOL_MAX, 1, 16),
    idleTimeoutMs: boundedEnvInteger(
      'TRACING_POOL_IDLE_TIMEOUT_MS',
      DEFAULT_IDLE_TIMEOUT_MS,
      1_000,
      120_000
    ),
    connectionTimeoutMs: boundedEnvInteger(
      'TRACING_POOL_CONNECTION_TIMEOUT_MS',
      DEFAULT_CONNECTION_TIMEOUT_MS,
      100,
      30_000
    ),
    ingestStatementTimeoutMs: DEFAULT_INGEST_STATEMENT_TIMEOUT_MS,
    readStatementTimeoutMs: boundedEnvInteger(
      'TRACING_READ_STATEMENT_TIMEOUT_MS',
      DEFAULT_READ_STATEMENT_TIMEOUT_MS,
      100,
      30_000
    ),
  }
}

export function getTracingMaintenancePoolMax(): number {
  return boundedEnvInteger('TRACING_MAINTENANCE_POOL_MAX', DEFAULT_MAINTENANCE_POOL_MAX, 1, 1)
}

export function getTracingOperationsRecentErrorSeconds(): number {
  return boundedEnvInteger(
    'TRACING_OPERATIONS_RECENT_ERROR_SECONDS',
    DEFAULT_RECENT_ERROR_SECONDS,
    60,
    3_600
  )
}
