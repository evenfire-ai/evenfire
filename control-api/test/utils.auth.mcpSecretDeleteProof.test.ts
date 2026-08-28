import { describe, expect, it, vi } from 'vitest'
import {
  MCP_SECRET_DELETE_PROOF_TTL_SECONDS,
  createMcpSecretDeleteProof,
  mcpSecretDeleteProofCookieName,
  verifyMcpSecretDeleteProof,
} from '../src/utils/auth/mcpSecretDeleteProof.js'

const claims = {
  name: 'linear-credentials',
  namespace: 'mcp-server',
  uid: 'uid-linear-credentials',
  resourceVersion: '1',
  sessionJti: 'test-admin-session-jti',
}

describe('MCP Secret delete proof', () => {
  it('binds exactly the Secret identity claims to the admin session', () => {
    const now = 1_700_000_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now)

    try {
      const proof = createMcpSecretDeleteProof(claims)

      expect(verifyMcpSecretDeleteProof(proof)).toEqual({
        ...claims,
        exp: Math.floor(now / 1000) + MCP_SECRET_DELETE_PROOF_TTL_SECONDS,
      })
      expect(Object.keys(verifyMcpSecretDeleteProof(proof) ?? {}).sort()).toEqual([
        'exp',
        'name',
        'namespace',
        'resourceVersion',
        'sessionJti',
        'uid',
      ])
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('rejects a proof when its signature or expiry is invalid', () => {
    const now = 1_700_000_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now)

    try {
      const proof = createMcpSecretDeleteProof(claims)
      const tampered = proof.split('.')
      tampered[2] = `${tampered[2]}x`

      expect(verifyMcpSecretDeleteProof(tampered.join('.'))).toBeNull()

      nowSpy.mockReturnValue(now + (MCP_SECRET_DELETE_PROOF_TTL_SECONDS + 1) * 1000)
      expect(verifyMcpSecretDeleteProof(proof)).toBeNull()
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
