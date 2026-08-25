import jwt from 'jsonwebtoken'
import type { CodexLlmProxyConfig } from '../config.js'

export type PlatformJwtClaims = {
  sub: string
  hostRefs: string[]
  workflowControlScopes: string[]
}

export function verifyPlatformJwt(
  token: string,
  config: CodexLlmProxyConfig
): PlatformJwtClaims | null {
  try {
    const verified = jwt.verify(token, config.jwtPublicKey, {
      algorithms: ['RS256'],
      issuer: config.jwtIssuer,
      audience: 'workflow-approvals',
    })
    if (typeof verified !== 'object' || verified === null) return null
    const claims = verified as jwt.JwtPayload
    if (claims.typ === 'codex-admin-permit' || claims.typ === 'codex-execution-ticket') {
      return null
    }
    if (!Array.isArray(claims.hostRefs) || !Array.isArray(claims.workflowControlScopes)) {
      return null
    }
    if (typeof claims.exp !== 'number') return null
    if (claims.hostRefs.some(ref => String(ref) === '*')) return null
    if (!claims.workflowControlScopes.includes('llm:codex:execute')) return null
    return {
      sub: String(claims.sub),
      hostRefs: claims.hostRefs.map(String),
      workflowControlScopes: claims.workflowControlScopes.map(String),
    }
  } catch {
    return null
  }
}
