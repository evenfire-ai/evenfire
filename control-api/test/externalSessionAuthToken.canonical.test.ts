import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  signExternalSessionToken,
  verifyExternalSessionToken,
} from '../src/utils/auth/externalSessionAuthToken.js'
import { jwsAliasVariants } from './helpers/jwsBase64UrlAliases.js'

const userId = randomUUID()

function signedToken(): string {
  return signExternalSessionToken({
    userId,
    email: `${userId}@canonical-representation.test`,
    teamId: null,
    role: 'member',
    authGeneration: 1,
  })
}

describe('external session V1 token canonical representation', () => {
  it('rejects the signature aliases whose unused bits the JWT library tolerates', () => {
    const token = signedToken()
    // Liveness witness: the canonical representation reaches the claims.
    expect(verifyExternalSessionToken(token)).toMatchObject({ userId, authGeneration: 1 })

    const signatureAliases = jwsAliasVariants(token).filter(
      variant => variant.segment === 'signature' && variant.kind === 'unused-bits'
    )
    expect(signatureAliases.length).toBeGreaterThan(0)
    for (const variant of signatureAliases) {
      expect(variant.token).not.toBe(token)
      expect(
        verifyExternalSessionToken(variant.token),
        `${variant.segment}/${variant.kind} alias`
      ).toBeNull()
    }
  })

  it('accepts the canonical JWS and rejects every generated alias and malformed representation', () => {
    const token = signedToken()
    expect(verifyExternalSessionToken(token)).toMatchObject({ userId, authGeneration: 1 })

    const variants = jwsAliasVariants(token)
    expect(variants.length).toBeGreaterThan(0)
    expect(new Set(variants.map(variant => variant.token)).size).toBe(variants.length)
    expect(new Set(variants.map(variant => variant.segment))).toEqual(
      new Set(['header', 'payload', 'signature'])
    )

    for (const variant of variants) {
      expect(variant.token).not.toBe(token)
      expect(
        verifyExternalSessionToken(variant.token),
        `${variant.segment}/${variant.kind} alias`
      ).toBeNull()
    }

    // Pre-existing malformed forms stay rejected. They do not distinguish the
    // canonical check by themselves, so they live in this mutation-killing test
    // instead of a separate test that could never go red.
    const malformed = [
      `${token}.`,
      `${token}.extra`,
      `.${token}`,
      token.replace('.', '..'),
      `${token}\n`,
      ` ${token}`,
    ]
    for (const candidate of malformed) {
      expect(candidate).not.toBe(token)
      expect(verifyExternalSessionToken(candidate)).toBeNull()
    }
  })
})
