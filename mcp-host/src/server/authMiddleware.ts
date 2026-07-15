/**
 * JWT scope-based authorization middleware for mcp-host runtime API.
 *
 * Validates RS256 tokens per token-contract.md and enforces scopes per authz-policy.md.
 * Disabled when config.enableAuth is false (default).
 */
import type { NextFunction, Request, Response } from 'express'
import jwt from 'jsonwebtoken'
import { config } from '../config'

export interface ServiceClaims {
  sub: string
  typ: 'service' | 'user'
  scopes: string[]
  hostRefs?: string[]
  service?: string
  teamId?: string
}

export function requireScope(scope: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!config.enableAuth) {
      next()
      return
    }

    const token = extractBearer(req)
    if (!token) {
      res.status(401).json({ error: 'Missing token' })
      return
    }

    let claims: ServiceClaims
    try {
      const payload = jwt.verify(token, config.authJwtPublicKey, {
        algorithms: ['RS256'],
        issuer: config.authJwtIssuer,
        audience: config.authJwtAudience,
      }) as jwt.JwtPayload

      if (
        typeof payload.sub !== 'string' ||
        (payload.typ !== 'service' && payload.typ !== 'user') ||
        !Array.isArray(payload.scopes)
      ) {
        res.status(401).json({ error: 'Invalid token claims' })
        return
      }

      claims = {
        sub: payload.sub,
        typ: payload.typ as 'service' | 'user',
        scopes: payload.scopes as string[],
        hostRefs: Array.isArray(payload.hostRefs) ? (payload.hostRefs as string[]) : undefined,
        service: typeof payload.service === 'string' ? payload.service : undefined,
        teamId: typeof payload.teamId === 'string' ? payload.teamId : undefined,
      }
    } catch {
      res.status(401).json({ error: 'Invalid token' })
      return
    }

    if (!claims.scopes.includes(scope)) {
      res.status(403).json({ error: `Missing scope: ${scope}` })
      return
    }

    // Enforce token's bounded hostRefs against THIS mcp-host's identity.
    // Each mcp-host pod serves exactly one Host CRD (config.hostName), so a
    // token with bounded hostRefs that doesn't list this hostName has no
    // business reaching here regardless of method (GET/POST) or whether the
    // request body carries a hostRef field. Required because GET routes
    // (e.g. /v1/runtime/sessions, /v1/runtime/sessions/:agent/:chatId/messages)
    // never have a body, which would otherwise silently bypass the check.
    if (claims.hostRefs && !claims.hostRefs.includes('*')) {
      if (!claims.hostRefs.includes(config.hostName)) {
        res.status(403).json({ error: 'Host not in hostRefs' })
        return
      }
      // Backward-compat: still validate body.hostRef when present, for any
      // historical callers that pass a hostRef explicitly. The two checks are
      // independent — both must pass.
      const bodyHostRef = (req.body as Record<string, unknown>)?.hostRef as string | undefined
      if (bodyHostRef && !claims.hostRefs.includes(bodyHostRef)) {
        res.status(403).json({ error: 'Host not in hostRefs' })
        return
      }
    }

    ;(req as Request & { auth: ServiceClaims }).auth = claims
    next()
  }
}

function extractBearer(req: Request): string | null {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) return null
  return header.slice(7)
}
