import { NextFunction, Request, Response } from 'express'
import { authenticateAdminSession } from '../../../services/adminSessionAuth.js'
import { authenticateExternalUserSession } from '../../../services/auth/externalSessionAuthentication.js'
import type { WorkflowCaller } from '../../../services/workflows/types.js'
import {
  type McpHostControlScope,
  verifyMcpHostControlJwt,
} from '../../../utils/auth/mcpHostJwtToken.js'
import { CONTROL_UI_ADMIN_SESSION_COOKIE, readCookie } from '../../../utils/auth/sessionCookies.js'
import { extractBearerToken } from '../../../utils/extractBearerToken.js'

function getUserSessionToken(req: Request): string {
  return String(req.header('x-user-session-token') || '').trim()
}

// The admin workflow routes bypass requireAuthForControlUI (they resolve a
// multi-kind WorkflowCaller), so they must read the same control-ui credential
// the rest of the UI uses. Since PR #649 the browser sends an HttpOnly session
// cookie and no Authorization header; the legacy bearer is still accepted for
// service/automation callers.
function getAdminUiToken(req: Request): string {
  return extractBearerToken(req) || readCookie(req, CONTROL_UI_ADMIN_SESSION_COOKIE)
}

function unauthorized(res: Response): null {
  res.status(401).json({ error: 'Unauthorized' })
  return null
}

export type AdminWorkflowAuthedRequest = Request & {
  adminWorkflowCaller?: Extract<WorkflowCaller, { kind: 'admin-ui' }>
}

export type ExternalWorkflowAuthedRequest = Request & {
  externalWorkflowCaller?: Extract<WorkflowCaller, { kind: 'user-session' }>
}

export async function requireAdminWorkflowCaller(
  req: Request,
  res: Response
): Promise<Extract<WorkflowCaller, { kind: 'admin-ui' }> | null> {
  const adminToken = getAdminUiToken(req)
  const adminClaims = await authenticateAdminSession(adminToken)
  if (!adminClaims) return unauthorized(res)
  return { kind: 'admin-ui', userId: adminClaims.sub }
}

/** Express middleware — keeps authorization out of business handlers for SAST. */
export async function requireAdminWorkflowCallerMiddleware(
  req: AdminWorkflowAuthedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const caller = await requireAdminWorkflowCaller(req, res)
    if (!caller) return
    req.adminWorkflowCaller = caller
    next()
  } catch (error) {
    next(error)
  }
}

export function adminWorkflowCaller(
  req: Request
): AdminWorkflowAuthedRequest['adminWorkflowCaller'] {
  return (req as AdminWorkflowAuthedRequest).adminWorkflowCaller
}

export function requireBoundAdminWorkflowCaller(req: Request, res: Response) {
  const caller = adminWorkflowCaller(req)
  if (!caller) {
    if (!res.headersSent) {
      res.status(401).json({ error: 'Unauthorized' })
    }
    return null
  }
  return caller
}

export function bindAdminWorkflowAuth(req: Request, res: Response, next: NextFunction): void {
  void requireAdminWorkflowCallerMiddleware(req as AdminWorkflowAuthedRequest, res, next).catch(
    next
  )
}

export async function requireExternalWorkflowCaller(
  req: Request,
  res: Response
): Promise<Extract<WorkflowCaller, { kind: 'user-session' }> | null> {
  const userSessionToken = getUserSessionToken(req)
  if (!userSessionToken || userSessionToken.length > 4096) return unauthorized(res)

  try {
    const authentication = await authenticateExternalUserSession(userSessionToken, {
      purpose: 'workflow_user',
      client: { version: req.header('x-evenfire-client-version') || undefined },
    })
    if (authentication.status === 'upgrade_required') {
      res.status(426).json({ error: 'upgrade_required' })
      return null
    }
    if (authentication.status !== 'authenticated') return unauthorized(res)
    return {
      kind: 'user-session',
      claims: authentication.claims,
      session: authentication.authorityContext,
    }
  } catch {
    res.status(503).json({ error: 'authority_unavailable' })
    return null
  }
}

export async function requireExternalWorkflowCallerMiddleware(
  req: ExternalWorkflowAuthedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const caller = await requireExternalWorkflowCaller(req, res)
    if (!caller) return
    req.externalWorkflowCaller = caller
    next()
  } catch (error) {
    next(error)
  }
}

export function externalWorkflowCaller(
  req: Request
): ExternalWorkflowAuthedRequest['externalWorkflowCaller'] {
  return (req as ExternalWorkflowAuthedRequest).externalWorkflowCaller
}

export function requireBoundExternalWorkflowCaller(req: Request, res: Response) {
  const caller = externalWorkflowCaller(req)
  if (!caller) {
    if (!res.headersSent) {
      res.status(401).json({ error: 'Unauthorized' })
    }
    return null
  }
  return caller
}

export function bindExternalWorkflowAuth(req: Request, res: Response, next: NextFunction): void {
  void requireExternalWorkflowCallerMiddleware(
    req as ExternalWorkflowAuthedRequest,
    res,
    next
  ).catch(next)
}

export function requireMcpHostControlWorkflowCaller(
  req: Request,
  res: Response
): Extract<WorkflowCaller, { kind: 'mcp-host-control' }> | null {
  const bearerToken = extractBearerToken(req)
  if (!bearerToken || bearerToken.length > 4096) return unauthorized(res)

  const claims = verifyMcpHostControlJwt(bearerToken)
  if (!claims) return unauthorized(res)
  return { kind: 'mcp-host-control', claims }
}

export function requireMcpHostControlScope(
  caller: Extract<WorkflowCaller, { kind: 'mcp-host-control' }>,
  res: Response,
  requiredScope: McpHostControlScope
): boolean {
  if (caller.claims.scopes.includes(requiredScope)) return true

  res.status(403).json({ error: 'insufficient_scope' })
  return false
}
