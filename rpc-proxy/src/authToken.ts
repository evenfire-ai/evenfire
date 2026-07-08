import jwt from 'jsonwebtoken'
import { config } from './config.js'
import { RpcAccessClaims, RpcAccessScope, RpcScope } from './types.js'

const ALLOWED_SCOPES = new Set<RpcScope>([
  'mcp:servers:list',
  'mcp:server:invoke',
  'host:health:read',
  'host:status:read',
  'host:activity:read',
  'host:message:invoke',
  'host:task:read',
  'host:approval:write',
  'host:session:read',
  'desktop:view',
  'sandbox:ui:view',
])

export function verifyRpcToken(token: string): RpcAccessClaims | null {
  try {
    const payload = jwt.verify(token, config.jwtPublicKey, {
      algorithms: ['RS256'],
      issuer: config.jwtIssuer,
      audience: config.jwtAudience,
    }) as jwt.JwtPayload

    if (
      typeof payload?.sub !== 'string' ||
      (payload?.typ !== 'user' && payload?.typ !== 'service') ||
      !Array.isArray(payload?.scopes) ||
      !Array.isArray(payload?.hostRefs) ||
      typeof payload?.jti !== 'string' ||
      typeof payload?.iat !== 'number' ||
      typeof payload?.exp !== 'number'
    ) {
      return null
    }

    const rawTeamId = payload.teamId
    const rawAccessScope = payload.accessScope
    let accessScope: RpcAccessScope
    let teamId: string | null
    if (payload.typ === 'service') {
      if (
        (rawAccessScope !== undefined && rawAccessScope !== 'service') ||
        typeof rawTeamId !== 'string' ||
        !rawTeamId.trim()
      ) {
        return null
      }
      accessScope = 'service'
      teamId = rawTeamId.trim()
    } else if (rawAccessScope === 'user') {
      if (rawTeamId !== null) return null
      accessScope = 'user'
      teamId = null
    } else if (rawAccessScope === 'team' || rawAccessScope === undefined) {
      if (typeof rawTeamId !== 'string' || !rawTeamId.trim()) return null
      accessScope = 'team'
      teamId = rawTeamId.trim()
    } else {
      return null
    }

    const scopes = payload.scopes.filter((entry): entry is RpcScope => {
      return typeof entry === 'string' && ALLOWED_SCOPES.has(entry as RpcScope)
    })
    if (scopes.length === 0) {
      return null
    }

    const hostRefs: string[] = []
    for (const entry of payload.hostRefs) {
      if (typeof entry !== 'string') return null
      const hostRef = entry.trim()
      if (!hostRef || hostRef === '*') return null
      hostRefs.push(hostRef)
    }
    if (hostRefs.length === 0) {
      return null
    }

    return {
      sub: payload.sub,
      typ: payload.typ,
      accessScope,
      teamId,
      scopes,
      hostRefs,
      jti: payload.jti,
      iat: payload.iat,
      exp: payload.exp,
      ...(typeof payload.service === 'string' ? { service: payload.service } : {}),
      ...(typeof payload.role === 'string' ? { role: payload.role } : {}),
    }
  } catch {
    return null
  }
}
