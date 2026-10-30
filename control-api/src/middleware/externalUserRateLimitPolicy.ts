import type { NextFunction, Request, Response } from 'express'
import { sendPublicApiError } from '../http/publicApiError.js'

type AuthenticatedRequest = Request & { externalAuth?: { userId?: string } }

/** Fail closed if authenticated route composition omitted the user context. */
export function requireAuthenticatedExternalUserRateLimitContext(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  if (!req.externalAuth?.userId) {
    sendPublicApiError(req, res, 401, 'invalid_session', 'The session is not valid.')
    return
  }
  next()
}
