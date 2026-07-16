// test/services.registryPopSigner.test.ts
import { describe, expect, it } from 'vitest'
import jwt from 'jsonwebtoken'
import { generateKeyPairSync } from 'node:crypto'
import { signPop } from '../src/services/registryPopSigner.js'

const kp = () =>
  generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })

describe('signPop', () => {
  it('self-signs an aud=registry-api PoP with a unique jti and short exp; kid omitted for register', () => {
    const { privateKey, publicKey } = kp()
    const token = signPop({ privateKeyPem: privateKey, sub: 'admin-1' })
    const header = jwt.decode(token, { complete: true })!.header
    expect(header.alg).toBe('RS256')
    expect(header.kid).toBeUndefined() // register PoP carries no kid
    const payload = jwt.verify(token, publicKey, {
      algorithms: ['RS256'],
      audience: 'registry-api',
    }) as jwt.JwtPayload
    expect(payload.sub).toBe('admin-1')
    expect(typeof payload.jti).toBe('string')
    expect(payload.exp! - Math.floor(Date.now() / 1000)).toBeGreaterThan(0)
    expect(payload.exp! - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(120)
  })

  it('sets the kid header for status/claim PoPs', () => {
    const { privateKey, publicKey } = kp()
    const token = signPop({ privateKeyPem: privateKey, sub: 'admin-1', kid: 'key-uuid-9' })
    const header = jwt.decode(token, { complete: true })!.header
    expect(header.kid).toBe('key-uuid-9')
    jwt.verify(token, publicKey, { algorithms: ['RS256'], audience: 'registry-api' })
  })

  it('mints a distinct jti each call (replay defense)', () => {
    const { privateKey } = kp()
    const a = jwt.decode(signPop({ privateKeyPem: privateKey, sub: 's' })) as jwt.JwtPayload
    const b = jwt.decode(signPop({ privateKeyPem: privateKey, sub: 's' })) as jwt.JwtPayload
    expect(a.jti).not.toBe(b.jti)
  })
})
