import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHmac } from 'node:crypto'
import {
  assertInternalControlJwtHmacSecret,
  signInternalControlJwt,
} from '../src/utils/internalControlSigner'

const ORIGINAL_SECRET = process.env.INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET

interface JwtHeader {
  alg: string
  typ: string
}

interface JwtClaims {
  iss: string
  aud: string
  sub: string
  iat: number
  exp: number
  jti: string
}

function decodeSegment<T>(token: string, index: number): T {
  return JSON.parse(Buffer.from(token.split('.')[index], 'base64url').toString('utf8')) as T
}

function expectedSignature(token: string, secret: string): string {
  const [header, payload] = token.split('.')
  return createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

describe('internalControlSigner (HCC)', () => {
  beforeEach(() => {
    process.env.INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET = 'test-hcc-internal-control-secret'
  })

  afterEach(() => {
    restoreEnv('INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET', ORIGINAL_SECRET)
  })

  it('signs HS256 JWTs with HCC provisioner claims and a 60s TTL', () => {
    const now = new Date('2026-04-30T12:00:00.000Z')
    const token = signInternalControlJwt(now)
    const parts = token.split('.')

    expect(parts).toHaveLength(3)
    expect(decodeSegment<JwtHeader>(token, 0)).toEqual({ alg: 'HS256', typ: 'JWT' })
    expect(parts[2]).toBe(expectedSignature(token, 'test-hcc-internal-control-secret'))

    const claims = decodeSegment<JwtClaims>(token, 1)
    expect(claims).toMatchObject({
      iss: 'hcc',
      aud: 'control-api',
      sub: 'hcc-provisioner',
      iat: 1777550400,
      exp: 1777550460,
    })
    expect(claims.jti).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it('generates a fresh jti for each token', () => {
    const first = decodeSegment<JwtClaims>(signInternalControlJwt(), 1)
    const second = decodeSegment<JwtClaims>(signInternalControlJwt(), 1)

    expect(first.jti).not.toBe(second.jti)
  })

  it('rejects missing or placeholder secrets', () => {
    expect(() => assertInternalControlJwtHmacSecret('')).toThrow(
      /INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET/
    )
    expect(() => assertInternalControlJwtHmacSecret('replace-with-secret')).toThrow(
      /placeholder value/
    )
  })

  it('rejects signing when the env secret is missing', () => {
    delete process.env.INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET

    expect(() => signInternalControlJwt()).toThrow(/INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET/)
  })
})
