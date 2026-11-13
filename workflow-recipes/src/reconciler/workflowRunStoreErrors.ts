/**
 * Closed classification of the errors that mean "the workflow run store
 * (Postgres) could not be reached", as opposed to errors the store answered.
 *
 * Only the kinds below make the running boundary answer 503
 * `workflow_run_state_unavailable` so the runtime waits and retries. Every
 * other error stays loud: SQL and constraint defects, authentication and
 * missing-database errors, `ENOTFOUND`, `08P01` (protocol violation), our own
 * `Connection terminated` from `end()`, serialization failures and
 * `WorkflowAuthorityCheckpointError`.
 *
 * The message-only entries are the exact texts of `pg` 8.21.0 and `pg-pool`
 * 3.14.0. The unit test produces three of them (pool acquire timeout, connect
 * timeout, connection dropped) from the real driver, so a driver upgrade that
 * changes one fails that test; the client-broken text is read from
 * `pg/lib/client.js` and tested with a hand-built error.
 */

export type WorkflowRunStoreErrorKind =
  | 'network'
  | 'pool_acquire_timeout'
  | 'connect_timeout'
  | 'connection_dropped'
  | 'client_broken'
  | 'server_connection_loss'
  | 'other'

const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'EAI_AGAIN',
])

// SQLSTATE codes carried by pg's DatabaseError.code. Explicit list: class 08
// minus 08P01, plus admin/crash shutdown, cannot-connect-now and
// too-many-connections.
const SERVER_CONNECTION_LOSS_SQLSTATES = new Set([
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '08007',
  '57P01',
  '57P02',
  '57P03',
  '53300',
])

// pg-pool: a checkout queued for a pool slot waited connectionTimeoutMillis.
const POOL_ACQUIRE_TIMEOUT_MESSAGE = 'timeout exceeded when trying to connect'
// pg-pool: a new connection did not finish its handshake in time.
const CONNECT_TIMEOUT_MESSAGE = 'Connection terminated due to connection timeout'
// pg: the server or the network closed the socket.
const CONNECTION_DROPPED_MESSAGE = 'Connection terminated unexpectedly'
// pg: a query on a client that already saw a connection error.
const CLIENT_BROKEN_MESSAGE = 'Client has encountered a connection error and is not queryable'

export function classifyWorkflowRunStoreError(error: unknown): WorkflowRunStoreErrorKind {
  if (typeof error !== 'object' || error === null) return 'other'
  const { code, message } = error as { code?: unknown; message?: unknown }
  if (typeof code === 'string') {
    if (NETWORK_ERROR_CODES.has(code)) return 'network'
    if (SERVER_CONNECTION_LOSS_SQLSTATES.has(code)) return 'server_connection_loss'
  }
  if (message === POOL_ACQUIRE_TIMEOUT_MESSAGE && code === undefined) {
    return 'pool_acquire_timeout'
  }
  if (message === CONNECT_TIMEOUT_MESSAGE) return 'connect_timeout'
  if (message === CONNECTION_DROPPED_MESSAGE) return 'connection_dropped'
  if (message === CLIENT_BROKEN_MESSAGE) return 'client_broken'
  return 'other'
}

export function isWorkflowRunStoreUnreachable(error: unknown): boolean {
  return classifyWorkflowRunStoreError(error) !== 'other'
}
