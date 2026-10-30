import { describe, expect, it } from 'vitest'
import { createHmac } from 'node:crypto'
import { signOAuthState, verifyOAuthStateSignature } from '../src/oauth/state.js'

/**
 * The Context a `context` grant is created for travels in the signed mcp state:
 * the callback has no other trustworthy source for it. The field is optional
 * (per-user states and states signed before it existed carry none) but, when
 * present, must be a non-empty string, or the whole state is malformed.
 */

const SECRET = 'x'.repeat(48)

function signRaw(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const sig = createHmac('sha256', SECRET).update(`v1.${payload}`).digest('base64url')
  return `v1.${payload}.${sig}`
}

const baseMcpClaims = () => ({
  subjectKind: 'mcp',
  mcpServerName: 'shared-drive',
  userId: 'u',
  oauthClientId: 'c',
  grantKind: 'user',
  background: false,
  expiresAt: Math.floor(Date.now() / 1000) + 600,
  nonce: 'n',
})

describe('mcp state contextId', () => {
  it('round-trips the contextId the signer was given', () => {
    const state = signOAuthState(SECRET, {
      subjectKind: 'mcp',
      mcpServerName: 'shared-drive',
      userId: 'u',
      oauthClientId: 'c',
      grantKind: 'user',
      background: false,
      contextId: 'c1',
    })
    const r = verifyOAuthStateSignature(SECRET, state)
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok' && r.claims.subjectKind === 'mcp') {
      expect(r.claims.contextId).toBe('c1')
    }
  })

  it('a state signed without contextId decodes with none', () => {
    const state = signOAuthState(SECRET, {
      subjectKind: 'mcp',
      mcpServerName: 'shared-drive',
      userId: 'u',
      oauthClientId: 'c',
      grantKind: 'user',
      background: false,
    })
    const r = verifyOAuthStateSignature(SECRET, state)
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok' && r.claims.subjectKind === 'mcp') {
      expect(r.claims).not.toHaveProperty('contextId')
    }
  })

  it.each([
    ['empty', ''],
    ['a number', 7],
    ['null', null],
    ['an object', { name: 'c1' }],
    ['an array', ['c1']],
  ])('rejects a validly signed state whose contextId is %s', (_label, contextId) => {
    const r = verifyOAuthStateSignature(SECRET, signRaw({ ...baseMcpClaims(), contextId }))
    expect(r.kind).toBe('invalid_format')
  })
})
