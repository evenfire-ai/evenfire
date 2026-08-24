import { NextFunction, Request, Response } from 'express'
import { authenticateAdminSession } from '../services/adminSessionAuth.js'
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
    const claims = await authenticateAdminSession(token)
    if (!claims) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    req.adminAuth = claims
    next()
  } catch (error) {
    next(error)
  }
}
