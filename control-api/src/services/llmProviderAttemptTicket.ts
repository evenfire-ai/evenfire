import jwt from 'jsonwebtoken'
import { createPublicKey, randomUUID } from 'node:crypto'
import { config } from '../config.js'
import type { DbClient } from '../db.js'
import { registerLlmProviderAttemptTicket } from './llmProviderAttemptStore.js'

export const CODEX_EXECUTION_TICKET_TYP = 'codex-execution-ticket' as const
export const CODEX_EXECUTION_TICKET_AUDIENCE = 'codex-llm-proxy'
export const CODEX_EXECUTION_TICKET_TTL_SECONDS = 60

export type CodexExecutionTicketClaims = {
  jti: string
  typ: typeof CODEX_EXECUTION_TICKET_TYP
  sub: string
  hostRef: string
  recipeNamespace?: string
  recipeName?: string
  invocationId: string
  attemptGeneration: number
  providerAttemptId: string
  providerAttemptIndex: number
  provider: 'codex-subscription'
  model: string
  requestHash: string
  policyRevision: number
  policyHash: string
  budgetReservationId: string
  connectionRevision: number
}

export type IssuedCodexExecutionTicket = {
  executionTicket: string
  claims: CodexExecutionTicketClaims
  expiresAt: Date
}

export async function issueRegisteredCodexExecutionTicket(
  db: DbClient,
  input: Omit<CodexExecutionTicketClaims, 'jti' | 'typ' | 'provider'>
): Promise<IssuedCodexExecutionTicket> {
  const jti = randomUUID()
  const expiresAt = new Date(Date.now() + CODEX_EXECUTION_TICKET_TTL_SECONDS * 1000)
  await registerLlmProviderAttemptTicket(db, {
    jti,
    providerAttemptId: input.providerAttemptId,
    expiresAt,
  })
  const claims: CodexExecutionTicketClaims = {
    ...input,
    jti,
    typ: CODEX_EXECUTION_TICKET_TYP,
    provider: 'codex-subscription',
  }
  const executionTicket = jwt.sign(claims, config.adminJwtPrivateKey, {
    algorithm: 'RS256',
    issuer: config.adminJwtIssuer,
    audience: CODEX_EXECUTION_TICKET_AUDIENCE,
    expiresIn: CODEX_EXECUTION_TICKET_TTL_SECONDS,
  })
  return { executionTicket, claims, expiresAt }
}

export function verifyCodexExecutionTicket(ticket: string): CodexExecutionTicketClaims | null {
  try {
    const publicKey = createPublicKey(config.adminJwtPrivateKey).export({
      type: 'spki',
      format: 'pem',
    })
    const verified = jwt.verify(ticket, publicKey, {
      algorithms: ['RS256'],
      issuer: config.adminJwtIssuer,
      audience: CODEX_EXECUTION_TICKET_AUDIENCE,
    })
    if (typeof verified !== 'object' || verified === null) return null
    const claims = verified as jwt.JwtPayload
    if (
      typeof claims.jti !== 'string' ||
      claims.typ !== CODEX_EXECUTION_TICKET_TYP ||
      claims.provider !== 'codex-subscription' ||
      typeof claims.sub !== 'string' ||
      typeof claims.hostRef !== 'string' ||
      typeof claims.invocationId !== 'string' ||
      typeof claims.providerAttemptId !== 'string' ||
      typeof claims.model !== 'string' ||
      typeof claims.requestHash !== 'string' ||
      typeof claims.policyHash !== 'string' ||
      typeof claims.budgetReservationId !== 'string'
    ) {
      return null
    }
    return claims as unknown as CodexExecutionTicketClaims
  } catch {
    return null
  }
}
