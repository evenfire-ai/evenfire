import { afterEach, describe, expect, it, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import { createPublicKey, randomUUID } from 'node:crypto'
import { config } from '../src/config.js'
import { hashCodexAttemptReceipt } from '../src/services/llmProviderAttemptReceipt.js'
import {
  CODEX_EXECUTION_TICKET_AUDIENCE,
  CODEX_EXECUTION_TICKET_TTL_SECONDS,
  issueRegisteredCodexExecutionTicket,
  verifyCodexExecutionTicket,
} from '../src/services/llmProviderAttemptTicket.js'

const binding = {
  sub: 'host/research-host',
  hostRef: 'research-host',
  recipeNamespace: 'sandbox-recipes',
  recipeName: 'prompt-notify',
  invocationId: 'invocation-1',
  attemptGeneration: 1,
  providerAttemptId: '33333333-3333-4333-8333-333333333333',
  providerAttemptIndex: 1,
  model: 'gpt-5.4',
  requestHash: 'a'.repeat(64),
  policyRevision: 7,
  policyHash: 'policy-hash',
  budgetReservationId: 'reservation-1',
  connectionRevision: 3,
}

function memoryDb(events: string[]) {
  return {
    query: async () => {
      events.push('register')
      return { rows: [] }
    },
  }
}

describe('Codex execution ticket', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('registers jti before returning an RS256 ticket bound to the authorized attempt', async () => {
    const events: string[] = []
    const issued = await issueRegisteredCodexExecutionTicket(memoryDb(events), binding)
    events.push('returned')
    expect(events).toEqual(['register', 'returned'])

    const publicKey = createPublicKey(config.adminJwtPrivateKey).export({
      type: 'spki',
      format: 'pem',
    })
    const header = jwt.decode(issued.executionTicket, { complete: true })?.header
    expect(header).toMatchObject({ alg: 'RS256', typ: 'JWT' })
    const claims = jwt.verify(issued.executionTicket, publicKey, {
      algorithms: ['RS256'],
      issuer: config.adminJwtIssuer,
      audience: CODEX_EXECUTION_TICKET_AUDIENCE,
    }) as jwt.JwtPayload
    expect(claims).toMatchObject({
      ...binding,
      typ: 'codex-execution-ticket',
      provider: 'codex-subscription',
      aud: CODEX_EXECUTION_TICKET_AUDIENCE,
    })
    expect(claims.jti).toBe(issued.claims.jti)
    expect(typeof claims.jti).toBe('string')
    expect(claims.exp! - claims.iat!).toBe(CODEX_EXECUTION_TICKET_TTL_SECONDS)
    expect(JSON.stringify(claims)).not.toContain('sk-')
    expect(JSON.stringify(claims)).not.toContain('refresh')
    expect(JSON.stringify(claims)).not.toContain('Authorization')
  })

  it('expires after 60 seconds so a captured ticket cannot be reused later', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-20T12:00:00.000Z'))
    const issued = await issueRegisteredCodexExecutionTicket(memoryDb([]), binding)
    expect(verifyCodexExecutionTicket(issued.executionTicket)).not.toBeNull()
    vi.advanceTimersByTime(60_001)
    expect(verifyCodexExecutionTicket(issued.executionTicket)).toBeNull()
  })

  it('reissues a fresh jti without changing the attempt binding', async () => {
    const original = await issueRegisteredCodexExecutionTicket(memoryDb([]), binding)
    const reissued = await issueRegisteredCodexExecutionTicket(memoryDb([]), binding)
    expect(reissued.claims.jti).not.toBe(original.claims.jti)
    expect(reissued.claims).toMatchObject({
      invocationId: original.claims.invocationId,
      providerAttemptId: original.claims.providerAttemptId,
      requestHash: original.claims.requestHash,
      policyHash: original.claims.policyHash,
    })
  })

  it('hashes a receipt without including prompt, completion, or token material', () => {
    const receipt = {
      schemaVersion: 'codex-attempt-receipt.v1' as const,
      providerAttemptId: randomUUID(),
      requestHash: 'b'.repeat(64),
      outcome: 'success' as const,
      usage: { inputTokens: 12, outputTokens: 4 },
    }
    const hash = hashCodexAttemptReceipt(receipt)
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
    expect(hash).toBe(
      hashCodexAttemptReceipt({
        usage: { outputTokens: 4, inputTokens: 12 },
        outcome: 'success',
        requestHash: receipt.requestHash,
        providerAttemptId: receipt.providerAttemptId,
        schemaVersion: 'codex-attempt-receipt.v1',
      })
    )
    expect(hash).not.toContain('prompt')
  })

  it('rejects a ticket that is missing a numeric exp claim', async () => {
    const token = jwt.sign(
      {
        ...binding,
        jti: randomUUID(),
        typ: 'codex-execution-ticket',
        provider: 'codex-subscription',
      },
      config.adminJwtPrivateKey,
      {
        algorithm: 'RS256',
        issuer: config.adminJwtIssuer,
        audience: CODEX_EXECUTION_TICKET_AUDIENCE,
      }
    )
    expect(typeof jwt.decode(token)).toBe('object')
    expect((jwt.decode(token) as jwt.JwtPayload).exp).toBeUndefined()
    expect(verifyCodexExecutionTicket(token)).toBeNull()
  })
})
