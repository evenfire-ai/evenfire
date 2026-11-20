import { DatabaseError } from 'pg'
import {
  ExternalSessionBackendUnavailableError,
  externalSessionDatabaseFailure,
} from '../auth/sessionDatabaseFailure.js'
import { isAccessExecutionBudgetError } from './accessExecutionBudget.js'

// SQLSTATE classes of a database outage: connection exception (08),
// insufficient resources (53), operator intervention (57), system error (58).
const DATABASE_UNAVAILABLE_SQLSTATE_CLASSES = new Set(['08', '53', '57', '58'])

/** An authority step's own dependency (its database) could not answer. */
export class AuthorityDependencyUnavailableError extends Error {
  constructor(
    readonly dependency: 'database',
    readonly cause: unknown
  ) {
    super(`Authority dependency unavailable: ${dependency}`, { cause })
    this.name = 'AuthorityDependencyUnavailableError'
  }
}

/**
 * `onDatabaseFailure` classifier for an authority step's database I/O. It
 * applies the rule the external-session boundary already uses: an outage
 * SQLSTATE class, a socket error, or the driver's plain `Error` (pool
 * connect timeout, terminated connection) becomes
 * `AuthorityDependencyUnavailableError`; every other error is returned as is.
 * Apply it only to the error of an actual database call.
 */
export function authorityDatabaseFailure(error: unknown): unknown {
  return externalSessionDatabaseFailure(error) instanceof ExternalSessionBackendUnavailableError
    ? new AuthorityDependencyUnavailableError('database', error)
    : error
}

/**
 * True when an authority step failed because a dependency could not answer:
 * its request budget ended, its database is unavailable, or a socket under it
 * failed. Only these are a retryable `authority_unavailable`; any other error
 * is a defect and must surface as one.
 */
export function isAuthorityDependencyUnavailable(error: unknown): boolean {
  if (isAccessExecutionBudgetError(error) || error instanceof AuthorityDependencyUnavailableError) {
    return true
  }
  if (error instanceof DatabaseError) {
    return DATABASE_UNAVAILABLE_SQLSTATE_CLASSES.has(String(error.code).slice(0, 2))
  }
  const code = error instanceof Error ? (error as { code?: unknown }).code : undefined
  return typeof code === 'string' && /^E[A-Z]+$/.test(code)
}
