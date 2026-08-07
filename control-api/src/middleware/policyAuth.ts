import { NextFunction, Request, Response } from 'express'

export type PolicyTokenType = 'service' | 'user'

export type PolicyAuthClaims = {
  iss: string
  aud: string | string[]
  sub: string
  typ: PolicyTokenType
  scopes: string[]
  hostRefs?: string[]
  service?: string
  teamId?: string
  role?: string
}

export type PolicyAuthedRequest = Request & {
  auth?: PolicyAuthClaims
}

export type VerifyPolicyToken = (token: string) => PolicyAuthClaims | null

export type ProtectedRoutePolicy = {
  requiredScope: string
  allowedServices?: string[]
  hostParam?: string
}

const DEFAULT_ERROR_BODY = {
  unauthorized: { error: 'Unauthorized' },
  forbidden: { error: 'Forbidden' },
}

function extractBearerToken(req: Request): string {
  const raw = String(req.headers.authorization || '').trim()
  if (!raw) return ''
  if (/^bearer\s+/i.test(raw)) {
    return raw.replace(/^bearer\s+/i, '').trim()
  }
  return ''
}

function extractServiceName(claims: PolicyAuthClaims): string {
  if (claims.service && claims.service.trim()) return claims.service.trim()
  if (claims.sub.startsWith('service:')) {
    return claims.sub.slice('service:'.length).trim()
  }
  return ''
}

export function requireAuth(verifyToken: VerifyPolicyToken, maxTokenLength = 4096) {
  return (req: PolicyAuthedRequest, res: Response, next: NextFunction): void => {
    const token = extractBearerToken(req)
    if (!token || token.length > maxTokenLength) {
      res.status(401).json(DEFAULT_ERROR_BODY.unauthorized)
      return
    }

    const claims = verifyToken(token)
    if (!claims) {
      res.status(401).json(DEFAULT_ERROR_BODY.unauthorized)
      return
    }

    req.auth = claims
    next()
  }
}

export function requireScope(scope: string) {
  return (req: PolicyAuthedRequest, res: Response, next: NextFunction): void => {
    const auth = req.auth
    if (!auth) {
      res.status(401).json(DEFAULT_ERROR_BODY.unauthorized)
      return
    }
    if (!auth.scopes.includes(scope)) {
      res.status(403).json({ error: 'Forbidden: missing scope' })
      return
    }
    next()
  }
}

export function requireService(service: string | string[]) {
  const allowed = new Set(Array.isArray(service) ? service : [service])
  return (req: PolicyAuthedRequest, res: Response, next: NextFunction): void => {
    const auth = req.auth
    if (!auth) {
      res.status(401).json(DEFAULT_ERROR_BODY.unauthorized)
      return
    }
    if (auth.typ !== 'service') {
      res.status(403).json({ error: 'Forbidden: service token required' })
      return
    }
    const serviceName = extractServiceName(auth)
    if (!serviceName || !allowed.has(serviceName)) {
      res.status(403).json({ error: 'Forbidden: service not allowed' })
      return
    }
    next()
  }
}

export function requireHostAccess(hostParam = 'host', allowWildcard = true) {
  return (req: PolicyAuthedRequest, res: Response, next: NextFunction): void => {
    const auth = req.auth
    if (!auth) {
      res.status(401).json(DEFAULT_ERROR_BODY.unauthorized)
      return
    }

    const requestedHost = String(req.params?.[hostParam] || req.body?.hostRef || '').trim()
    if (!requestedHost) {
      res.status(403).json({ error: 'Forbidden: missing host reference' })
      return
    }

    const hostRefs = Array.isArray(auth.hostRefs) ? auth.hostRefs : []
    if (hostRefs.includes(requestedHost)) {
      next()
      return
    }
    if (allowWildcard && hostRefs.includes('*')) {
      next()
      return
    }

    res.status(403).json({ error: 'Forbidden: host access denied' })
  }
}

export function requireMappedPolicy(getPolicy: (req: Request) => ProtectedRoutePolicy | null) {
  return (req: PolicyAuthedRequest, res: Response, next: NextFunction): void => {
    const policy = getPolicy(req)
    if (!policy) {
      res.status(403).json({ error: 'Forbidden: unmapped protected route' })
      return
    }

    const auth = req.auth
    if (!auth) {
      res.status(401).json(DEFAULT_ERROR_BODY.unauthorized)
      return
    }

    if (!auth.scopes.includes(policy.requiredScope)) {
      res.status(403).json({ error: 'Forbidden: missing scope' })
      return
    }

    if (policy.allowedServices && policy.allowedServices.length > 0) {
      if (auth.typ !== 'service') {
        res.status(403).json({ error: 'Forbidden: service token required' })
        return
      }
      const name = extractServiceName(auth)
      if (!name || !policy.allowedServices.includes(name)) {
        res.status(403).json({ error: 'Forbidden: service not allowed' })
        return
      }
    }

    if (policy.hostParam) {
      const requestedHost = String(req.params?.[policy.hostParam] || req.body?.hostRef || '').trim()
      const hostRefs = Array.isArray(auth.hostRefs) ? auth.hostRefs : []
      const hostAllowed =
        requestedHost && (hostRefs.includes(requestedHost) || hostRefs.includes('*'))
      if (!hostAllowed) {
        res.status(403).json({ error: 'Forbidden: host access denied' })
        return
      }
    }

    next()
  }
}
