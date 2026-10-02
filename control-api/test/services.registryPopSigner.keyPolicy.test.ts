import { afterEach, describe, expect, it, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import { createPrivateKey, generateKeyPairSync } from 'node:crypto'
import { publicKeyPemFingerprint } from '@clerum/jwt-key-policy'
import { signPop } from '../src/services/registryPopSigner.js'

const deniedIdentities = vi.hoisted(() => new Set<string>())
vi.mock('@clerum/jwt-key-policy', async importOriginal => {
  const actual = await importOriginal<typeof import('@clerum/jwt-key-policy')>()
  return {
    ...actual,
    parseSigningMaterial: (
      raw: string,
      source: string,
      options?: import('@clerum/jwt-key-policy').JwtFingerprintOptions
    ) =>
      actual.parseSigningMaterial(raw, source, {
        ...options,
        fingerprints: [...(options?.fingerprints ?? []), ...deniedIdentities],
      }),
  }
})

function pair() {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
}
afterEach(() => {
  deniedIdentities.clear()
  vi.restoreAllMocks()
})

describe('registry PoP signing policy', () => {
  it('canonicalizes an escaped-CR PKCS1 signer and preserves kid/audience/TTL/jti/noTimestamp', () => {
    const material = pair()
    const representation = createPrivateKey(material.privateKey)
      .export({ type: 'pkcs1', format: 'pem' })
      .toString()
      .replace(/\n/g, '\\r')
    const signedJwt = signPop({
      privateKeyPem: representation,
      sub: 'admin-contract',
      kid: 'key-contract',
    })
    const header = jwt.decode(signedJwt, { complete: true })!.header
    const claims = jwt.verify(signedJwt, material.publicKey, {
      algorithms: ['RS256'],
      audience: 'registry-api',
    }) as jwt.JwtPayload
    expect(header.kid).toBe('key-contract')
    expect(claims.sub).toBe('admin-contract')
    expect(typeof claims.jti).toBe('string')
    expect(claims.iat).toBeUndefined()
    expect(claims.exp! - Math.floor(Date.now() / 1000)).toBeGreaterThan(0)
    expect(claims.exp! - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(120)
  })

  it('rejects a scoped denied identity before invoking the JWT signer', () => {
    const material = pair()
    deniedIdentities.add(publicKeyPemFingerprint(material.publicKey))
    const signing = vi.spyOn(jwt, 'sign')
    expect(() => signPop({ privateKeyPem: material.privateKey, sub: 'admin-contract' })).toThrow(
      'registry_signing_material_unavailable'
    )
    expect(signing.mock.calls.length).toBe(0)
  })

  it('classifies malformed key material as a permanent safe failure before signing', () => {
    // Deliberately malformed input tests corruption rejection, not a key fixture.
    const corrupted = 'invalid signing material for a corruption fixture'
    const signing = vi.spyOn(jwt, 'sign')
    let failure: unknown
    try {
      signPop({ privateKeyPem: corrupted, sub: 'admin-contract' })
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({
      message: 'registry_signing_material_unavailable',
      reason: 'invalid_pem',
    })
    expect(signing.mock.calls.length).toBe(0)
  })

  it('rejects mixed public/private objects rather than signing a selected private half', () => {
    const material = pair()
    const other = pair()
    const signing = vi.spyOn(jwt, 'sign')
    for (const mixed of [
      material.privateKey + other.publicKey,
      other.publicKey + material.privateKey,
    ]) {
      expect(() => signPop({ privateKeyPem: mixed, sub: 'admin-contract' })).toThrow(
        'registry_signing_material_unavailable'
      )
    }
    expect(signing.mock.calls.length).toBe(0)
  })
})
