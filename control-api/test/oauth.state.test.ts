import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { signOAuthState, verifyOAuthState, verifyOAuthStateSignature } from '../src/oauth/state.js'

const SECRET = 'unit-test-state-hmac-secret-32-bytes-pad'

const BINDING = {
  recipeNamespace: 'sandbox-recipes',
  recipeName: 'crm',
  userId: 'user-uuid-1',
  oauthClientId: 'salesforce',
  grantKind: 'user' as const,
}

describe('signOAuthState / verifyOAuthState (O3.1)', () => {
  it('round-trips a freshly signed state', () => {
    const state = signOAuthState(SECRET, BINDING)
    const result = verifyOAuthState(SECRET, state, BINDING)
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.claims.recipeNamespace).toBe('sandbox-recipes')
      expect(result.claims.userId).toBe('user-uuid-1')
      expect(result.claims.oauthClientId).toBe('salesforce')
      expect(result.claims.grantKind).toBe('user')
      expect(result.claims.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000))
    }
  })

  it('round-trips a service-kind state and carries grantKind in the claims', () => {
    const state = signOAuthState(SECRET, { ...BINDING, grantKind: 'service' as const })
    // grantKind is NOT part of the verify binding — it comes only from the
    // signed state, so the same 4-field BINDING is used as `expected`.
    const result = verifyOAuthState(SECRET, state, BINDING)
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.claims.grantKind).toBe('service')
    }
  })

  it('produces distinct state values for identical bindings (nonce)', () => {
    const a = signOAuthState(SECRET, BINDING)
    const b = signOAuthState(SECRET, BINDING)
    expect(a).not.toBe(b)
  })

  it('rejects a state signed with a different secret', () => {
    const state = signOAuthState(SECRET, BINDING)
    const r = verifyOAuthState('different-secret-32-bytes-padding-here', state, BINDING)
    expect(r.kind).toBe('invalid_signature')
  })

  it('rejects a non-canonical signature even when it decodes to the same bytes', () => {
    const state = signOAuthState(SECRET, BINDING)
    const [version, payload, signature] = state.split('.')
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    const lastIndex = alphabet.indexOf(signature.at(-1) ?? '')
    expect(lastIndex).toBeGreaterThanOrEqual(0)

    // SHA-256 base64url output has a partial final character. Flipping an
    // unused low bit can decode to the same bytes, so verification must compare
    // the canonical base64url text, not only decoded bytes.
    const nonCanonicalLast = alphabet[lastIndex ^ 1]
    const nonCanonicalSignature = `${signature.slice(0, -1)}${nonCanonicalLast}`
    expect(Buffer.from(nonCanonicalSignature, 'base64url')).toEqual(
      Buffer.from(signature, 'base64url')
    )

    const r = verifyOAuthState(SECRET, [version, payload, nonCanonicalSignature].join('.'), BINDING)
    expect(r.kind).toBe('invalid_signature')
  })

  it('rejects a state with a tampered payload (signature mismatch)', () => {
    const state = signOAuthState(SECRET, BINDING)
    const [version, payload, signature] = state.split('.')
    const tampered = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload, 'base64url').toString()),
        userId: 'attacker',
      })
    ).toString('base64url')
    const r = verifyOAuthState(SECRET, [version, tampered, signature].join('.'), BINDING)
    expect(r.kind).toBe('invalid_signature')
  })

  it('rejects a malformed state value', () => {
    expect(verifyOAuthState(SECRET, 'not-a-state', BINDING).kind).toBe('invalid_format')
    expect(verifyOAuthState(SECRET, 'v1.payload', BINDING).kind).toBe('invalid_format')
    expect(verifyOAuthState(SECRET, 'v9.x.y', BINDING).kind).toBe('invalid_version')
  })

  it('rejects a state whose binding does not match expected', () => {
    const state = signOAuthState(SECRET, BINDING)

    const wrongNs = verifyOAuthState(SECRET, state, { ...BINDING, recipeNamespace: 'attacker-ns' })
    expect(wrongNs.kind).toBe('binding_mismatch')

    const wrongName = verifyOAuthState(SECRET, state, { ...BINDING, recipeName: 'other' })
    expect(wrongName.kind).toBe('binding_mismatch')

    const wrongUser = verifyOAuthState(SECRET, state, { ...BINDING, userId: 'attacker' })
    expect(wrongUser.kind).toBe('binding_mismatch')

    const wrongClient = verifyOAuthState(SECRET, state, { ...BINDING, oauthClientId: 'slack' })
    expect(wrongClient.kind).toBe('binding_mismatch')
  })

  it('rejects an expired state', () => {
    const state = signOAuthState(SECRET, BINDING)
    const [version, payload, signature] = state.split('.')
    const expired = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload, 'base64url').toString()),
        expiresAt: Math.floor(Date.now() / 1000) - 60,
      })
    ).toString('base64url')
    // Re-sign with the right secret so it would otherwise verify — only the
    // expiry should fail. (We can't use the original signature because the
    // payload changed.) Using internal knowledge of the format here is fine
    // for an expiry-specific test.
    const expiredSig = require('node:crypto')
      .createHmac('sha256', SECRET)
      .update(`${version}.${expired}`)
      .digest('base64url')
    const r = verifyOAuthState(SECRET, [version, expired, expiredSig].join('.'), BINDING)
    expect(r.kind).toBe('expired')
    void signature
  })

  it('throws when the secret is too short to use', () => {
    expect(() => signOAuthState('short', BINDING)).toThrow(/at least 32 characters/)
  })
})

describe('verifyOAuthStateSignature (signature-only, for the path-less callback)', () => {
  it('verifies signature + expiry and returns claims with NO external binding check', () => {
    const state = signOAuthState(SECRET, BINDING)
    const r = verifyOAuthStateSignature(SECRET, state)
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') {
      expect(r.claims.recipeNamespace).toBe('sandbox-recipes')
      expect(r.claims.recipeName).toBe('crm')
      expect(r.claims.userId).toBe('user-uuid-1')
      expect(r.claims.oauthClientId).toBe('salesforce')
      expect(r.claims.grantKind).toBe('user')
    }
  })

  it('rejects a state signed with a different secret', () => {
    const state = signOAuthState(SECRET, BINDING)
    expect(verifyOAuthStateSignature('different-secret-32-bytes-padding-here', state).kind).toBe(
      'invalid_signature'
    )
  })

  it('rejects a tampered payload', () => {
    const state = signOAuthState(SECRET, BINDING)
    const [version, payload, signature] = state.split('.')
    const tampered = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload, 'base64url').toString()),
        recipeName: 'attacker-recipe',
      })
    ).toString('base64url')
    expect(verifyOAuthStateSignature(SECRET, [version, tampered, signature].join('.')).kind).toBe(
      'invalid_signature'
    )
  })

  it('rejects malformed and wrong-version values', () => {
    expect(verifyOAuthStateSignature(SECRET, 'not-a-state').kind).toBe('invalid_format')
    expect(verifyOAuthStateSignature(SECRET, 'v9.x.y').kind).toBe('invalid_version')
  })

  it('rejects an expired state even with a valid signature', () => {
    const state = signOAuthState(SECRET, BINDING)
    const [version, payload] = state.split('.')
    const expired = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload, 'base64url').toString()),
        expiresAt: Math.floor(Date.now() / 1000) - 60,
      })
    ).toString('base64url')
    const sig = createHmac('sha256', SECRET).update(`${version}.${expired}`).digest('base64url')
    expect(verifyOAuthStateSignature(SECRET, [version, expired, sig].join('.')).kind).toBe('expired')
  })
})
