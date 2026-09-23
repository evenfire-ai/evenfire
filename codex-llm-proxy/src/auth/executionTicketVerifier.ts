import jwt from 'jsonwebtoken'
import type { CodexLlmProxyConfig } from '../config.js'

export type ExecutionTicketClaims = {
  jti: string
  typ: 'codex-execution-ticket'
  hostRef: string
  model: string
  requestHash: string
  providerAttemptId: string
  /** The signed `exp` in epoch milliseconds (#739 D1-bis). */
  expiresAtMs: number
}

function readExecutionTicket(
  token: string,
  config: CodexLlmProxyConfig,
  ignoreExpiration: boolean
): ExecutionTicketClaims | null {
  const verified = jwt.verify(token, config.jwtPublicKey, {
    algorithms: ['RS256'],
    issuer: config.jwtIssuer,
    audience: 'codex-llm-proxy',
    ignoreExpiration,
  })
  if (typeof verified !== 'object' || verified === null) return null
  const claims = verified as jwt.JwtPayload
  if (typeof claims.exp !== 'number') return null
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
    expiresAtMs: claims.exp * 1000,
  }
}

export function verifyExecutionTicket(
  token: string,
  config: CodexLlmProxyConfig
): ExecutionTicketClaims | null {
  try {
    return readExecutionTicket(token, config, false)
  } catch {
    return null
  }
}

/**
 * True only for a ticket that `verifyExecutionTicket` refused because its
 * `exp` has passed (#739 R17-2). jsonwebtoken checks `exp` before audience and
 * issuer, so an expiry error alone does not prove the ticket is authentic: it
 * is re-read without the expiry and must pass every other check.
 */
export function isExpiredExecutionTicket(token: string, config: CodexLlmProxyConfig): boolean {
  try {
    readExecutionTicket(token, config, false)
    return false
  } catch (error) {
    if (!(error instanceof jwt.TokenExpiredError)) return false
  }
  try {
    return readExecutionTicket(token, config, true) !== null
  } catch {
    return false
  }
}
