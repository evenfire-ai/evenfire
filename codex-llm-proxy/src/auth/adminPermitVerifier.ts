import jwt from 'jsonwebtoken'
import type { CodexLlmProxyConfig } from '../config.js'

export type AdminPermitOperation = 'catalog_list' | 'connection_test'

export type AdminPermitClaims = {
  sub: string
  typ: 'codex-admin-permit'
  operation: AdminPermitOperation
}

export function verifyAdminPermit(
  token: string,
  config: CodexLlmProxyConfig,
  operation?: AdminPermitOperation
): AdminPermitClaims | null {
  try {
    const verified = jwt.verify(token, config.jwtPublicKey, {
      algorithms: ['RS256'],
      issuer: config.jwtIssuer,
      audience: 'codex-llm-proxy-admin',
    })
    if (typeof verified !== 'object' || verified === null) return null
    const claims = verified as jwt.JwtPayload
    if (claims.typ !== 'codex-admin-permit' || typeof claims.sub !== 'string') return null
    if (claims.operation !== 'catalog_list' && claims.operation !== 'connection_test') return null
    if (operation && claims.operation !== operation) return null
    return { sub: claims.sub, typ: 'codex-admin-permit', operation: claims.operation }
  } catch {
    return null
  }
}
