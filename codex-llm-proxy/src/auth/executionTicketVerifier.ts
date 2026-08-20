import jwt from 'jsonwebtoken'
import type { CodexLlmProxyConfig } from '../config.js'

export type ExecutionTicketClaims = {
  jti: string
  typ: 'codex-execution-ticket'
  hostRef: string
  model: string
  requestHash: string
  providerAttemptId: string
}

export function verifyExecutionTicket(
  token: string,
  config: CodexLlmProxyConfig
): ExecutionTicketClaims | null {
  try {
    const verified = jwt.verify(token, config.jwtPublicKey, {
      algorithms: ['RS256'],
      issuer: config.jwtIssuer,
      audience: 'codex-llm-proxy',
    })
    if (typeof verified !== 'object' || verified === null) return null
    const claims = verified as jwt.JwtPayload
    if (claims.typ !== 'codex-execution-ticket') return null
    if (typeof claims.jti !== 'string' || typeof claims.hostRef !== 'string') return null
    if (typeof claims.model !== 'string' || typeof claims.requestHash !== 'string') return null
    if (typeof claims.providerAttemptId !== 'string') return null
    return {
      jti: claims.jti,
      typ: 'codex-execution-ticket',
      hostRef: claims.hostRef,
      model: claims.model,
      requestHash: claims.requestHash,
      providerAttemptId: claims.providerAttemptId,
    }
  } catch {
    return null
  }
}
