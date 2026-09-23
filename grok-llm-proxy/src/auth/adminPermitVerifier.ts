import jwt from 'jsonwebtoken'
import type { GrokLlmProxyConfig } from '../config.js'

export type AdminPermitOperation = 'catalog_list' | 'connection_test'

export type AdminPermitClaims = {
  sub: string
  typ: 'grok-admin-permit'
  operation: AdminPermitOperation
}

export function verifyAdminPermit(
  token: string,
  config: GrokLlmProxyConfig,
  operation?: AdminPermitOperation
): AdminPermitClaims | null {
  try {
    const verified = jwt.verify(token, config.jwtPublicKey, {
      algorithms: ['RS256'],
      issuer: config.jwtIssuer,
      audience: 'grok-llm-proxy-admin',
    })
    if (typeof verified !== 'object' || verified === null) return null
    const claims = verified as jwt.JwtPayload
    if (typeof claims.exp !== 'number') return null
    if (claims.typ !== 'grok-admin-permit' || typeof claims.sub !== 'string') return null
    if (claims.operation !== 'catalog_list' && claims.operation !== 'connection_test') return null
    if (operation && claims.operation !== operation) return null
    return { sub: claims.sub, typ: 'grok-admin-permit', operation: claims.operation }
  } catch {
    return null
  }
}
