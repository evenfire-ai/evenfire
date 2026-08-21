import { NextFunction, Request, Response } from 'express'
import { isCurrentExternalSession } from '../../../middleware/externalSessionAuth.js'
import { authenticateAdminSession } from '../../../services/adminSessionAuth.js'
import type { WorkflowCaller } from '../../../services/workflows/types.js'
import { verifyExternalSessionToken } from '../../../utils/auth/externalSessionAuthToken.js'
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
  const caller = await requireAdminWorkflowCaller(req, res)
  if (!caller) return
  req.adminWorkflowCaller = caller
  next()
}

export async function requireExternalWorkflowCaller(
  req: Request,
  res: Response
): Promise<Extract<WorkflowCaller, { kind: 'user-session' }> | null> {
  const userSessionToken = getUserSessionToken(req)
  if (!userSessionToken || userSessionToken.length > 4096) return unauthorized(res)

  const claims = verifyExternalSessionToken(userSessionToken)
  if (!claims) return unauthorized(res)
  if (!(await isCurrentExternalSession(claims))) {
    return unauthorized(res)
  }
  return { kind: 'user-session', claims }
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
