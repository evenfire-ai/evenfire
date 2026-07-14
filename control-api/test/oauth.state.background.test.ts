import { createHmac } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { signOAuthState, verifyOAuthState } from '../src/oauth/state.js'

const SECRET = 'x'.repeat(40)
const BINDING = {
  recipeNamespace: 'sandbox-recipes',
  recipeName: 'leadforge',
  userId: 'user-1',
  oauthClientId: 'google-gmail',
}

describe('state background', () => {
  it('round-trips background=true through sign/verify', () => {
    const state = signOAuthState(SECRET, { ...BINDING, grantKind: 'user', background: true })
    const result = verifyOAuthState(SECRET, state, BINDING)
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') expect(result.claims.background).toBe(true)
  })

  it('defaults background to false when the field is absent (legacy state)', () => {
    // Mint a v1 token manually WITHOUT a `background` field to simulate a
    // legacy state produced before the background flag was introduced.
    const claims = {
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'leadforge',
      userId: 'user-1',
      oauthClientId: 'google-gmail',
      grantKind: 'user',
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      nonce: 'abc',
    } // NOTE: no `background` field
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
    const sig = createHmac('sha256', SECRET).update(`v1.${payload}`).digest('base64url')
    const state = `v1.${payload}.${sig}`
    const result = verifyOAuthState(SECRET, state, BINDING)
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') expect(result.claims.background).toBe(false)
  })
})
