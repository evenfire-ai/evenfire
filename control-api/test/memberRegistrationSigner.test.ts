import { describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import { signMemberRegistrationJwt } from '../src/utils/auth/memberRegistrationSigner.js'

const CREDENTIAL = {
  secret: 'test-hmac-secret',
  kid: 'ext-abc123-deadbeef',
  tenantId: 'ext-abc123',
}

describe('signMemberRegistrationJwt', () => {
  it('produces a verifiable HS256 token from the supplied credential', () => {
    const token = signMemberRegistrationJwt(CREDENTIAL, new Date(1_700_000_000_000))
    const [h, p, sig] = token.split('.')

    const expected = crypto
      .createHmac('sha256', CREDENTIAL.secret)
      .update(`${h}.${p}`)
      .digest('base64url')
    expect(sig).toBe(expected)

    const header = JSON.parse(Buffer.from(h, 'base64url').toString())
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString())
    expect(header).toMatchObject({ alg: 'HS256', typ: 'JWT', kid: CREDENTIAL.kid })
    expect(payload).toMatchObject({
      iss: 'control-api',
      aud: 'member-registration-service',
      sub: CREDENTIAL.tenantId,
    })
    expect(payload.exp - payload.iat).toBe(60)
    expect(typeof payload.jti).toBe('string')
  })

  it('mints a fresh jti each call', () => {
    const a = signMemberRegistrationJwt(CREDENTIAL)
    const b = signMemberRegistrationJwt(CREDENTIAL)
    const jtiA = JSON.parse(Buffer.from(a.split('.')[1], 'base64url').toString()).jti
    const jtiB = JSON.parse(Buffer.from(b.split('.')[1], 'base64url').toString()).jti
    expect(jtiA).not.toBe(jtiB)
  })
})
