import { generateKeyPairSync } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { describe, expect, it } from 'vitest'
import { verifyExecutionTicket } from '../src/auth/executionTicketVerifier.js'
import type { CodexLlmProxyConfig } from '../src/config.js'

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

const verifierConfig = { jwtIssuer: 'control-api', jwtPublicKey: publicKey } as CodexLlmProxyConfig

const CLAIMS = {
  jti: '66666666-6666-4666-8666-666666666666',
  typ: 'codex-execution-ticket',
  hostRef: 'research-host',
  model: 'gpt-5.1',
  requestHash: 'c'.repeat(64),
  providerAttemptId: 'att-verifier',
}

function signTicket(payload: Record<string, unknown>): string {
  return jwt.sign(payload, privateKey, {
    algorithm: 'RS256',
    issuer: 'control-api',
    audience: 'codex-llm-proxy',
  })
}

describe('verifyExecutionTicket (#739 D1-bis)', () => {
  it('T-AC-6 returns the signed exp as expiresAtMs and still refuses a ticket without exp', () => {
    const exp = Math.floor(Date.now() / 1000) + 45
    const verified = verifyExecutionTicket(signTicket({ ...CLAIMS, exp }), verifierConfig)
    expect(verified).toEqual({ ...CLAIMS, expiresAtMs: exp * 1000 })

    expect(verifyExecutionTicket(signTicket(CLAIMS), verifierConfig)).toBeNull()
  })
})
