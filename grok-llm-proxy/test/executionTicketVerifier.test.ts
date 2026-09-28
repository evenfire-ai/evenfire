import { generateKeyPairSync } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { describe, expect, it } from 'vitest'
import { verifyExecutionTicket } from '../src/auth/executionTicketVerifier.js'
import type { GrokLlmProxyConfig } from '../src/config.js'

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

const verifierConfig = { jwtIssuer: 'control-api', jwtPublicKey: publicKey } as GrokLlmProxyConfig

const CLAIMS = {
  jti: '77777777-7777-4777-8777-777777777777',
  typ: 'grok-execution-ticket',
  hostRef: 'research-host',
  model: 'grok-4.6',
  requestHash: 'c'.repeat(64),
  providerAttemptId: 'att-verifier',
}

function signTicket(payload: Record<string, unknown>): string {
  return jwt.sign(payload, privateKey, {
    algorithm: 'RS256',
    issuer: 'control-api',
    audience: 'grok-llm-proxy',
  })
}

describe('verifyExecutionTicket (#739 D1-bis)', () => {
  it('T-AC-6-grok returns the signed exp as expiresAtMs and still refuses a ticket without exp', () => {
    const exp = Math.floor(Date.now() / 1000) + 45
    const verified = verifyExecutionTicket(signTicket({ ...CLAIMS, exp }), verifierConfig)
    expect(verified).toEqual({ ...CLAIMS, expiresAtMs: exp * 1000 })

    expect(verifyExecutionTicket(signTicket(CLAIMS), verifierConfig)).toBeNull()
  })
})
