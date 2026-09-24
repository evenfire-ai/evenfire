import jwt from 'jsonwebtoken'
import { createPublicKey, randomUUID } from 'node:crypto'
import { config } from '../config.js'
import type { DbClient } from '../db.js'
import { GROK_EXECUTION_TICKET_TTL_SECONDS } from './llmProviderAttemptEnvelope.js'
import { registerLlmProviderAttemptTicket } from './llmProviderAttemptStore.js'

export const GROK_EXECUTION_TICKET_TYP = 'grok-execution-ticket' as const
export const GROK_EXECUTION_TICKET_AUDIENCE = 'grok-llm-proxy'
export { GROK_EXECUTION_TICKET_TTL_SECONDS }

export type GrokExecutionTicketClaims = {
  jti: string
  typ: typeof GROK_EXECUTION_TICKET_TYP
  sub: string
  hostRef: string
  recipeNamespace?: string
  recipeName?: string
  invocationId: string
  attemptGeneration: number
  providerAttemptId: string
  providerAttemptIndex: number
  provider: 'grok-subscription'
  model: string
  requestHash: string
  policyRevision: number
  policyHash: string
  budgetReservationId: string
  connectionRevision: number
  connectionId: string
}

export type IssuedGrokExecutionTicket = {
  executionTicket: string
  claims: GrokExecutionTicketClaims
  expiresAt: Date
}

export async function issueRegisteredGrokExecutionTicket(
  db: DbClient,
  input: Omit<GrokExecutionTicketClaims, 'jti' | 'typ' | 'provider'>
): Promise<IssuedGrokExecutionTicket> {
  if (!input.connectionId) {
    throw new Error('Grok execution tickets require connectionId')
  }
  const jti = randomUUID()
  const expiresAt = new Date(Date.now() + GROK_EXECUTION_TICKET_TTL_SECONDS * 1000)
  await registerLlmProviderAttemptTicket(db, {
    jti,
    providerAttemptId: input.providerAttemptId,
    expiresAt,
  })
  const claims: GrokExecutionTicketClaims = {
    ...input,
    jti,
    typ: GROK_EXECUTION_TICKET_TYP,
    provider: 'grok-subscription',
  }
  const executionTicket = jwt.sign(claims, config.adminJwtPrivateKey, {
    algorithm: 'RS256',
    issuer: config.adminJwtIssuer,
    audience: GROK_EXECUTION_TICKET_AUDIENCE,
    expiresIn: GROK_EXECUTION_TICKET_TTL_SECONDS,
  })
  return { executionTicket, claims, expiresAt }
}

export function verifyGrokExecutionTicket(ticket: string): GrokExecutionTicketClaims | null {
  try {
    const publicKey = createPublicKey(config.adminJwtPrivateKey).export({
      type: 'spki',
      format: 'pem',
    })
    const verified = jwt.verify(ticket, publicKey, {
      algorithms: ['RS256'],
      issuer: config.adminJwtIssuer,
      audience: GROK_EXECUTION_TICKET_AUDIENCE,
    })
    if (typeof verified !== 'object' || verified === null) return null
    const claims = verified as jwt.JwtPayload
    if (
      typeof claims.jti !== 'string' ||
      claims.typ !== GROK_EXECUTION_TICKET_TYP ||
      claims.provider !== 'grok-subscription' ||
      typeof claims.sub !== 'string' ||
      typeof claims.hostRef !== 'string' ||
      typeof claims.invocationId !== 'string' ||
      typeof claims.providerAttemptId !== 'string' ||
      typeof claims.model !== 'string' ||
      typeof claims.requestHash !== 'string' ||
      typeof claims.policyHash !== 'string' ||
      typeof claims.budgetReservationId !== 'string' ||
      typeof claims.connectionId !== 'string' ||
      typeof claims.exp !== 'number'
    ) {
      return null
    }
    return claims as unknown as GrokExecutionTicketClaims
  } catch {
    return null
  }
}
