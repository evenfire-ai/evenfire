import { NextFunction, Request, Response } from 'express'
import { DatabaseError } from 'pg'
import { pool } from '../db.js'
import { rootLogger } from '../observability/logger.js'
import { AuthClaims, TeamRole } from '../profileTypes.js'
import { getLiveTeamMembership } from '../services/access/liveTeamAuthorization.js'
import { verifyExternalSessionToken } from '../utils/auth/externalSessionAuthToken.js'

/** Retry-After sent when the user row cannot be read to validate a session. */
export const SESSION_BACKEND_RETRY_AFTER_SECONDS = 2

// SQLSTATE classes that mean the server could not run the query: 08 connection
// exception, 53 insufficient resources, 57 operator intervention (includes
// 57014 statement timeout), 58 system error.
const BACKEND_UNAVAILABLE_SQLSTATE_CLASSES = new Set(['08', '53', '57', '58'])

// A Node system error code (ECONNREFUSED, ETIMEDOUT, EPIPE, ...). Node's own
// argument and state errors use ERR_* codes, which this does not match.
const SYSTEM_ERROR_CODE = /^E[A-Z]+$/

/**
 * True when the lookup failed because PostgreSQL could not be reached or could
 * not run it:
 * - a DatabaseError whose SQLSTATE class is 08, 53, 57 or 58;
 * - a plain Error, which is how pg and pg-pool report an acquire timeout or a
 *   dropped connection;
 * - an error carrying a Node system code, as socket failures do (including the
 *   AggregateError Node raises when every address of a host refuses).
 * Anything else is a defect: a DatabaseError in another class (22P02, 42P01,
 * ...) is in the query or the schema, and a TypeError or RangeError is in this
 * process's code. A 503 would hide either one.
 */
function isBackendUnavailableError(error: unknown): boolean {
  if (error instanceof DatabaseError) {
    return BACKEND_UNAVAILABLE_SQLSTATE_CLASSES.has(String(error.code).slice(0, 2))
  }
  if (!(error instanceof Error)) return false
  const code = (error as { code?: unknown }).code
  if (typeof code === 'string' && SYSTEM_ERROR_CODE.test(code)) return true
  return error.constructor === Error
}

export type ExternalAuthedRequest = Request & {
  externalAuth?: AuthClaims
  externalTeamAuth?: {
    teamId: string
    role: TeamRole
  }
}

/**
 * The session JWT is only a signed locator. The user row remains authoritative
 * for lifecycle and generation, so retirement takes effect before the token's
 * nominal expiry. A missing row and an inactive row intentionally share the
 * same denial to avoid user enumeration.
 */
export async function isCurrentExternalSession(claims: AuthClaims): Promise<boolean> {
  const authGeneration = claims.authGeneration
  if (
    typeof authGeneration !== 'number' ||
    !Number.isSafeInteger(authGeneration) ||
    authGeneration < 1
  )
    return false
  const result = await pool.query(
    `SELECT lifecycle_state, lifecycle_version
       FROM users
      WHERE id = $1
      LIMIT 1`,
    [claims.userId]
  )
  const row = result.rows[0] as
    | { lifecycle_state?: unknown; lifecycle_version?: unknown }
    | undefined
  if (row?.lifecycle_state !== 'active') return false
  return Number(row.lifecycle_version) === authGeneration
}

export async function assertCurrentExternalSession(claims: AuthClaims): Promise<void> {
  if (!(await isCurrentExternalSession(claims))) {
    throw new Error('external session is inactive or stale')
  }
}

function extractUserSessionToken(req: Request): string {
  return String(req.header('x-user-session-token') || '').trim()
}

export function requireValidExternalSessionToken(
  req: ExternalAuthedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  return requireValidExternalSessionTokenAsync(req, res, next)
}

async function requireValidExternalSessionTokenAsync(
  req: ExternalAuthedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const token = extractUserSessionToken(req)
    const claims = verifyExternalSessionToken(token)
    if (!claims) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    let current: boolean
    try {
      current = await isCurrentExternalSession(claims)
    } catch (error) {
      // A query or schema defect goes to the error handler (500).
      if (!isBackendUnavailableError(error)) throw error
      // The users-table lookup could not run (pool acquire timeout, connection
      // or statement timeout): the session could not be judged, which is
      // neither a denial (401) nor a defect in this request (500).
      rootLogger.warn(
        {
          event: 'external_session_backend_unavailable',
          err: error instanceof Error ? error.message : String(error),
        },
        'external session validation could not reach PostgreSQL'
      )
      res.setHeader('Retry-After', String(SESSION_BACKEND_RETRY_AFTER_SECONDS))
      res.setHeader('Cache-Control', 'no-store')
      res.status(503).json({
        error: 'session_backend_unavailable',
        retryAfterSeconds: SESSION_BACKEND_RETRY_AFTER_SECONDS,
      })
      return
    }
    if (!current) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    req.externalAuth = claims
    next()
  } catch (error) {
    next(error)
  }
}

export function requireExternalUserParamMatch(paramName = 'userId') {
  return (req: ExternalAuthedRequest, res: Response, next: NextFunction): void => {
    const claims = req.externalAuth
    const requestedUserId = String(req.params?.[paramName] || '').trim()
    if (!claims || !requestedUserId || claims.userId !== requestedUserId) {
      res.status(403).json({ error: 'Forbidden' })
      return
    }
    next()
  }
}

export function requireExternalTeamParamMatch(paramName = 'teamId') {
  return async (req: ExternalAuthedRequest, res: Response, next: NextFunction): Promise<void> => {
    const claims = req.externalAuth
    const requestedTeamId = String(req.params?.[paramName] || req.query?.[paramName] || '').trim()
    if (!claims || !requestedTeamId) {
      res.status(403).json({ error: 'Forbidden' })
      return
    }
    try {
      const membership = await getLiveTeamMembership(claims.userId, requestedTeamId)
      if (!membership) {
        res.status(403).json({ error: 'Forbidden' })
        return
      }
      req.externalTeamAuth = membership
      next()
    } catch {
      res.status(503).json({ error: 'authority_unavailable' })
    }
  }
}

export function rejectBodyUserTeamMismatch(
  req: ExternalAuthedRequest,
  res: Response,
  next: NextFunction
): void {
  const claims = req.externalAuth
  if (!claims) {
    res.status(403).json({ error: 'Forbidden' })
    return
  }

  const body = req.body ?? {}
  const bodyUserId = String((body as { userId?: unknown }).userId || '').trim()
  const bodyTeamId = String((body as { teamId?: unknown }).teamId || '').trim()
  if (
    (bodyUserId && bodyUserId !== claims.userId) ||
    (bodyTeamId && (!req.externalTeamAuth || bodyTeamId !== req.externalTeamAuth.teamId))
  ) {
    res.status(403).json({ error: 'Forbidden' })
    return
  }
  next()
}

export function requireExternalRole(allowedRoles: TeamRole[]) {
  return (req: ExternalAuthedRequest, res: Response, next: NextFunction): void => {
    const role = req.externalTeamAuth?.role
    if (!role || !allowedRoles.includes(role)) {
      res.status(403).json({ error: 'Forbidden' })
      return
    }
    next()
  }
}
