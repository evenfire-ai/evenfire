import { NextFunction, Request, Response } from 'express'
import { findAdminById, isAdminTokenRevoked } from '../services/adminAuthService.js'
import { verifyAdminToken } from '../utils/auth/adminAuthToken.js'
import { AdminAuthClaims } from '../utils/auth/adminAuthTypes.js'
import { CONTROL_UI_ADMIN_SESSION_COOKIE, readCookie } from '../utils/auth/sessionCookies.js'

export type UiAuthedRequest = Request & {
  adminAuth?: AdminAuthClaims
}

function extractControlUiSessionToken(req: Request): string {
  return readCookie(req, CONTROL_UI_ADMIN_SESSION_COOKIE)
}

export async function requireAuthForControlUI(
  req: UiAuthedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const token = extractControlUiSessionToken(req)
    if (!token || token.length > 4096) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    const claims = verifyAdminToken(token)
    if (!claims) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    if (await isAdminTokenRevoked(claims.jti)) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    const admin = await findAdminById(claims.sub)
    if (
      !admin ||
      admin.status !== 'active' ||
      Number(claims.sessionVersion || 0) !== admin.sessionVersion
    ) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    req.adminAuth = claims
    next()
  } catch (error) {
    next(error)
  }
}
