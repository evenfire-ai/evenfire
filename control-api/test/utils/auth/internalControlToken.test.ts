import { describe, expect, it } from 'vitest'
import jwt from 'jsonwebtoken'
import { config } from '../../../src/config.js'
import { verifyInternalControlJwt } from '../../../src/utils/auth/internalControlToken.js'

function internalControlSecretForIssuer(iss: unknown): string {
  return iss === 'hcc'
    ? config.internalControlJwtHccHmacSecret
    : config.internalControlJwtWrcHmacSecret
}

function sign(
  overrides: Record<string, unknown> = {},
  secret = internalControlSecretForIssuer(overrides.iss)
) {
  return jwt.sign(
    {
      iss: 'wrc',
      aud: 'control-api',
      sub: 'wrc-provisioner',
      ...overrides,
    },
    secret,
    {
      algorithm: 'HS256',
      expiresIn: 60,
      jwtid: 'test-jti',
    }
  )
}

describe('verifyInternalControlJwt', () => {
  it('verifies a valid HS256 InternalControl JWT', () => {
    expect(verifyInternalControlJwt(sign())).toMatchObject({
      iss: 'wrc',
      aud: 'control-api',
      sub: 'wrc-provisioner',
      jti: 'test-jti',
    })
  })

  it('verifies a valid HCC InternalControl JWT with the HCC key', () => {
    expect(verifyInternalControlJwt(sign({ iss: 'hcc', sub: 'hcc-provisioner' }))).toMatchObject({
      iss: 'hcc',
      aud: 'control-api',
      sub: 'hcc-provisioner',
    })
  })

  it('rejects wrong audience', () => {
    expect(verifyInternalControlJwt(sign({ aud: 'other' }))).toBeNull()
  })

  it('rejects bad signatures', () => {
    expect(verifyInternalControlJwt(sign({}, 'wrong-secret'))).toBeNull()
  })

  it('rejects expired tokens', () => {
    const token = jwt.sign(
      { iss: 'wrc', aud: 'control-api', sub: 'wrc-provisioner' },
      config.internalControlJwtWrcHmacSecret,
      {
        algorithm: 'HS256',
        expiresIn: -1,
        jwtid: 'expired-jti',
      }
    )
    expect(verifyInternalControlJwt(token)).toBeNull()
  })

  it('rejects payloads missing required InternalControl claims', () => {
    const token = jwt.sign(
      { iss: 'wrc', aud: 'control-api', sub: 123 },
      config.internalControlJwtWrcHmacSecret,
      {
        algorithm: 'HS256',
        expiresIn: 60,
        jwtid: 'invalid-claims-jti',
      }
    )
    expect(verifyInternalControlJwt(token)).toBeNull()
  })

  it('rejects unknown issuers before route-level allowlists', () => {
    expect(verifyInternalControlJwt(sign({ iss: 'other' }))).toBeNull()
  })

  it('rejects HCC issuer tokens signed with the WRC key', () => {
    const token = sign(
      { iss: 'hcc', sub: 'hcc-provisioner' },
      config.internalControlJwtWrcHmacSecret
    )

    expect(verifyInternalControlJwt(token)).toBeNull()
  })

  it('rejects WRC issuer tokens signed with the HCC key', () => {
    const token = sign(
      { iss: 'wrc', sub: 'wrc-provisioner' },
      config.internalControlJwtHccHmacSecret
    )

    expect(verifyInternalControlJwt(token)).toBeNull()
  })
})
