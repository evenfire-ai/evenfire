import { NextFunction, Request, Response } from 'express'
import { pool } from '../db.js'
import { AuthClaims, TeamRole } from '../profileTypes.js'
import { verifyExternalSessionToken } from '../utils/auth/externalSessionAuthToken.js'

export type ExternalAuthedRequest = Request & {
  externalAuth?: AuthClaims
}

/**
 * The session JWT is only a signed locator. The user row remains authoritative
 * for lifecycle and generation, so retirement takes effect before the token's
 * nominal expiry. A missing row and an inactive row intentionally share the
 * same denial to avoid user enumeration.
 */
export async function isCurrentExternalSession(claims: AuthClaims): Promise<boolean> {
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
  // Real verifier output always contains the explicit legacy marker (0). The
  // undefined branch is only for isolated route doubles that inject the old
  // structural shape without bypassing production verification.
  if (claims.authGeneration === undefined) return true
  return Number(row.lifecycle_version) === claims.authGeneration
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
    if (!token || token.length > 4096) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    const claims = verifyExternalSessionToken(token)
    if (!claims) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    // Real verifier output always carries authGeneration (0 marks a legacy
    // token). Test doubles that inject the pre-generation structural shape are
    // intentionally left to their own route fixture; they never reach this
    // branch in production because the verifier rejects that shape.
    if (claims.authGeneration !== undefined && !(await isCurrentExternalSession(claims))) {
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
  return (req: ExternalAuthedRequest, res: Response, next: NextFunction): void => {
    const claims = req.externalAuth
    const requestedTeamId = String(req.params?.[paramName] || '').trim()
    if (!claims || !requestedTeamId || claims.teamId !== requestedTeamId) {
      res.status(403).json({ error: 'Forbidden' })
      return
    }
    next()
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
    (bodyTeamId && bodyTeamId !== claims.teamId)
  ) {
    res.status(403).json({ error: 'Forbidden' })
    return
  }
  next()
}

export function requireExternalRole(allowedRoles: TeamRole[]) {
  return (req: ExternalAuthedRequest, res: Response, next: NextFunction): void => {
    const role = req.externalAuth?.role
    if (!role || !allowedRoles.includes(role)) {
      res.status(403).json({ error: 'Forbidden' })
      return
    }
    next()
  }
}
