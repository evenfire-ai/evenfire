import jwt from 'jsonwebtoken'
import type { CodexLlmProxyConfig } from '../config.js'

export type AdminPermitClaims = {
  sub: string
  typ: 'codex-admin-permit'
}

export function verifyAdminPermit(
  token: string,
  config: CodexLlmProxyConfig
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
    return { sub: claims.sub, typ: 'codex-admin-permit' }
  } catch {
    return null
  }
}
