import { afterEach, describe, expect, it, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import {
  signExternalSessionToken,
  verifyExternalSessionToken,
} from '../src/utils/auth/externalSessionAuthToken.js'

const fixture = await vi.hoisted(async () => {
  const { generateKeyPairSync } = await import('node:crypto')
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
})

vi.mock('../src/config.js', () => ({
  config: {
    sessionJwtPrivateKey: fixture.privateKey,
    jwtIssuer: 'control-api',
    jwtAudience: 'profile-ui',
  },
}))

const issuedAt = 2_000_000_000
const claims = {
  userId: 'session-ttl-user',
  email: 'session-ttl@example.invalid',
  teamId: 'session-ttl-team',
  role: 'member' as const,
  authGeneration: 1,
}

afterEach(() => vi.restoreAllMocks())

describe('V1 external session lifetime', () => {
  it('issues a seven-day default JWT and enforces its exact expiration boundary', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(issuedAt * 1000)
    const token = signExternalSessionToken(claims)
    const signed = jwt.decode(token) as jwt.JwtPayload

    expect(signed.exp! - signed.iat!).toBe(604_800)
    now.mockReturnValue((issuedAt + 604_800 - 1) * 1000)
    expect(verifyExternalSessionToken(token)).not.toBeNull()
    now.mockReturnValue((issuedAt + 604_800) * 1000)
    expect(verifyExternalSessionToken(token)).toBeNull()
  })

  it('honors an explicit 43,200-second signer TTL through expiration', () => {
    vi.spyOn(Date, 'now').mockReturnValue(issuedAt * 1000)
    const token = signExternalSessionToken(claims, 43_200)
    const signed = jwt.decode(token) as jwt.JwtPayload

    expect(signed.exp! - signed.iat!).toBe(43_200)
    expect(verifyExternalSessionToken(token)).not.toBeNull()

    vi.spyOn(Date, 'now').mockReturnValue((issuedAt + 43_200) * 1000)
    expect(verifyExternalSessionToken(token)).toBeNull()
  })

  it('keeps an explicit signer TTL authoritative', () => {
    vi.spyOn(Date, 'now').mockReturnValue(issuedAt * 1000)
    const token = signExternalSessionToken(claims, 7_200)
    const signed = jwt.decode(token) as jwt.JwtPayload

    expect(signed.exp! - signed.iat!).toBe(7_200)
  })
})
