import jwt from 'jsonwebtoken'
import type { GrokLlmProxyConfig } from '../config.js'

export type PlatformJwtClaims = {
  sub: string
  hostRefs: string[]
  workflowControlScopes: string[]
}

export function verifyPlatformJwt(
  token: string,
  config: GrokLlmProxyConfig
): PlatformJwtClaims | null {
  try {
    const verified = jwt.verify(token, config.jwtPublicKey, {
      algorithms: ['RS256'],
      issuer: config.jwtIssuer,
      audience: 'workflow-approvals',
    })
    if (typeof verified !== 'object' || verified === null) return null
    const claims = verified as jwt.JwtPayload
    if (
      claims.typ === 'grok-admin-permit' ||
      claims.typ === 'grok-execution-ticket' ||
      claims.typ === 'codex-admin-permit' ||
      claims.typ === 'codex-execution-ticket'
    ) {
      return null
    }
    if (!Array.isArray(claims.hostRefs) || !Array.isArray(claims.workflowControlScopes)) {
      return null
    }
    // A11.7 V3: `sub` becomes part of the per-principal visual admission key,
    // so a missing, empty or non-string sub must fail verification instead of
    // collapsing every such caller onto the literal principal "undefined".
    const sub = claims.sub
    if (typeof sub !== 'string' || sub === '') return null
    if (typeof claims.exp !== 'number') return null
    if (claims.scope !== 'workflow:approval:request') return null
    if (claims.hostRefs.some(ref => String(ref) === '*')) return null
    if (!claims.workflowControlScopes.includes('llm:grok:execute')) return null
    return {
      sub,
      hostRefs: claims.hostRefs.map(String),
      workflowControlScopes: claims.workflowControlScopes.map(String),
    }
  } catch {
    return null
  }
}
