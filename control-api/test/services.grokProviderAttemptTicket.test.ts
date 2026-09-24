import { afterEach, describe, expect, it, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import { createPublicKey, randomUUID } from 'node:crypto'
import { config } from '../src/config.js'
import {
  GROK_EXECUTION_TICKET_AUDIENCE,
  GROK_EXECUTION_TICKET_TTL_SECONDS,
  issueRegisteredGrokExecutionTicket,
  verifyGrokExecutionTicket,
} from '../src/services/grokProviderAttemptTicket.js'
import { CODEX_EXECUTION_TICKET_AUDIENCE } from '../src/services/llmProviderAttemptTicket.js'

const binding = {
  sub: 'host/research-host',
  hostRef: 'research-host',
  invocationId: 'invocation-1',
  attemptGeneration: 1,
  providerAttemptId: '33333333-3333-4333-8333-333333333333',
  providerAttemptIndex: 1,
  model: 'grok-4.6',
  requestHash: 'a'.repeat(64),
  policyRevision: 7,
  policyHash: 'b'.repeat(64),
  budgetReservationId: 'unbudgeted',
  connectionRevision: 3,
  connectionId: '11111111-1111-4111-8111-111111111111',
}

function memoryDb() {
  return {
    query: async () => ({ rows: [] }),
  }
}

describe('Grok execution ticket', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('verifies an issued ticket and rejects Codex audience or typ', async () => {
    const issued = await issueRegisteredGrokExecutionTicket(memoryDb(), binding)
    expect(verifyGrokExecutionTicket(issued.executionTicket)).toMatchObject({
      typ: 'grok-execution-ticket',
      provider: 'grok-subscription',
      model: 'grok-4.6',
      connectionId: binding.connectionId,
    })

    const publicKey = createPublicKey(config.adminJwtPrivateKey).export({
      type: 'spki',
      format: 'pem',
    })
    const claims = jwt.verify(issued.executionTicket, publicKey, {
      algorithms: ['RS256'],
      issuer: config.adminJwtIssuer,
      audience: GROK_EXECUTION_TICKET_AUDIENCE,
    }) as jwt.JwtPayload
    expect(claims.aud).toBe(GROK_EXECUTION_TICKET_AUDIENCE)
    expect(claims.aud).not.toBe(CODEX_EXECUTION_TICKET_AUDIENCE)

    const sign = (claims: Record<string, unknown>, audience: string) =>
      jwt.sign(claims, config.adminJwtPrivateKey, {
        algorithm: 'RS256',
        issuer: config.adminJwtIssuer,
        audience,
        expiresIn: GROK_EXECUTION_TICKET_TTL_SECONDS,
      })
    expect(
      verifyGrokExecutionTicket(
        sign(
          {
            ...binding,
            jti: randomUUID(),
            typ: 'codex-execution-ticket',
            provider: 'grok-subscription',
          },
          GROK_EXECUTION_TICKET_AUDIENCE
        )
      )
    ).toBeNull()
    expect(
      verifyGrokExecutionTicket(
        sign(
          {
            ...binding,
            jti: randomUUID(),
            typ: 'grok-execution-ticket',
            provider: 'codex-subscription',
          },
          GROK_EXECUTION_TICKET_AUDIENCE
        )
      )
    ).toBeNull()
    expect(
      verifyGrokExecutionTicket(
        sign(
          {
            ...binding,
            jti: randomUUID(),
            typ: 'grok-execution-ticket',
            provider: 'grok-subscription',
          },
          CODEX_EXECUTION_TICKET_AUDIENCE
        )
      )
    ).toBeNull()
  })

  it('expires after 60 seconds', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-20T12:00:00.000Z'))
    const issued = await issueRegisteredGrokExecutionTicket(memoryDb(), binding)
    expect(verifyGrokExecutionTicket(issued.executionTicket)).not.toBeNull()
    vi.advanceTimersByTime(60_001)
    expect(verifyGrokExecutionTicket(issued.executionTicket)).toBeNull()
  })
})
