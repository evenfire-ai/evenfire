import { describe, expect, it, vi } from 'vitest'
import {
  MCP_SECRET_DELETE_PROOF_TTL_SECONDS,
  createMcpSecretDeleteProof,
  mcpSecretDeleteProofCookieName,
  verifyMcpSecretDeleteProof,
} from '../src/utils/auth/mcpSecretDeleteProof.js'

const adminSession = 'test-admin-session'
const claims = {
  name: 'linear-credentials',
  namespace: 'mcp-server',
  uid: 'uid-linear-credentials',
  resourceVersion: '1',
}

describe('MCP Secret delete proof', () => {
  it('binds exactly the Secret identity claims to the admin session', () => {
    const now = 1_700_000_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now)

    try {
      const proof = createMcpSecretDeleteProof(claims, adminSession)

      expect(verifyMcpSecretDeleteProof(proof, adminSession)).toEqual({
        ...claims,
        exp: Math.floor(now / 1000) + MCP_SECRET_DELETE_PROOF_TTL_SECONDS,
      })
      expect(Object.keys(verifyMcpSecretDeleteProof(proof, adminSession) ?? {}).sort()).toEqual([
        'exp',
        'name',
        'namespace',
        'resourceVersion',
        'uid',
      ])
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('rejects a proof when its session binding, signature, or expiry is invalid', () => {
    const now = 1_700_000_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now)

    try {
      const proof = createMcpSecretDeleteProof(claims, adminSession)
      const [payload, signature] = proof.split('.')

      expect(verifyMcpSecretDeleteProof(proof, 'different-admin-session')).toBeNull()
      expect(verifyMcpSecretDeleteProof(`${payload}.${signature}x`, adminSession)).toBeNull()

      nowSpy.mockReturnValue(now + (MCP_SECRET_DELETE_PROOF_TTL_SECONDS + 1) * 1000)
      expect(verifyMcpSecretDeleteProof(proof, adminSession)).toBeNull()
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('uses a deterministic, HTTP-cookie-safe name derived from the Secret name', () => {
    const name = mcpSecretDeleteProofCookieName(claims.name)

    expect(name).toMatch(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/)
    expect(name).not.toBe(mcpSecretDeleteProofCookieName('other-credentials'))
  })
})
