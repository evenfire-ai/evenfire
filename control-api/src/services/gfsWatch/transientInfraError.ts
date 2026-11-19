import { DatabaseError } from 'pg'
import { ExternalGfsAuthorityError } from '../../gfs/externalAuthority.js'
import { ExternalSessionBackendUnavailableError } from '../../services/auth/sessionDatabaseFailure.js'

// Connection exceptions, insufficient resources, operator intervention and
// system errors: the server or the link failed, not the statement.
const TRANSIENT_SQLSTATE_CLASSES = new Set(['08', '53', '57', '58'])

// libuv/socket and getaddrinfo codes (ECONNRESET, ETIMEDOUT, EAI_AGAIN, ...).
// Node's own ERR_* codes are programming errors and deliberately do not match.
const SYSTEM_ERROR_CODE = /^E[A-Z]+$/
const DNS_ERROR_CODE = /^EAI_[A-Z]+$/

/**
 * Messages that pg@8.20 and pg-pool@3.13 attach to a plain `Error` when the
 * transport fails. They are matched by prefix and only on a raw plain `Error`,
 * because pg also throws plain errors for caller defects (for example
 * 'Query values must be an array'); classifying every raw plain error as an
 * outage would hide those defects behind a retry.
 */
export const PG_TRANSPORT_MESSAGES: readonly string[] = Object.freeze([
  'Connection terminated unexpectedly',
  'Connection terminated',
  'timeout expired',
  'Query read timeout',
  'timeout exceeded when trying to connect',
  'Connection terminated due to connection timeout',
])

/**
 * The only classifier of infrastructure failures for the GFS watch: true when
 * `error` comes from Postgres, the pool, the network or an abort and retrying
 * later can succeed; false for anything that indicates a defect.
 *
 * One deliberate exception to the plain-Error rule above: an
 * `ExternalSessionBackendUnavailableError` is transient whatever it wraps. The
 * session boundary already decided that every plain `Error` raised inside its
 * database operations is a database outage, so a caller defect thrown there
 * arrives wrapped and is classified transient. The watch inherits that decision
 * instead of unwrapping the cause and second-guessing it.
 */
export function isTransientInfraError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return true
  if (error instanceof ExternalSessionBackendUnavailableError) return true
  if (error instanceof ExternalGfsAuthorityError) return error.status === 503
  if (error instanceof DatabaseError) {
    return TRANSIENT_SQLSTATE_CLASSES.has(String(error.code ?? '').slice(0, 2))
  }
  const code = (error as { code?: unknown }).code
  if (typeof code === 'string' && (SYSTEM_ERROR_CODE.test(code) || DNS_ERROR_CODE.test(code))) {
    return true
  }
  return (
    error.constructor === Error &&
    PG_TRANSPORT_MESSAGES.some(message => error.message.startsWith(message))
  )
}
