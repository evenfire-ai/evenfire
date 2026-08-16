import { describe, expect, it } from 'vitest'
import jwt from 'jsonwebtoken'
import { GFS_SCOPES, gfsSigningKeyId, signGfsToken } from '../src/auth/gfsToken.js'
import { config } from '../src/config.js'
import { parseRequestedGfsScopes } from '../src/routes/gfs/token.js'

const VERIFY = {
  algorithms: ['RS256'] as jwt.Algorithm[],
  audience: 'gfs-controller',
  issuer: 'control-api',
}

describe('signGfsToken', () => {
  it('mints a token that verifies under the platform public key with the right claims', () => {
    const { token, expiresInSeconds } = signGfsToken({
      subject: 'user-123',
      drive: 'main',
      scopes: ['gfs.read'],
    })
    expect(expiresInSeconds).toBe(config.gfsTokenTtlSeconds)

    const decoded = jwt.verify(token, config.rpcJwtPublicKey, VERIFY) as jwt.JwtPayload
    expect(decoded.sub).toBe('user-123')
    expect(decoded.drive).toBe('main')
    expect(decoded.scopes).toEqual(['gfs.read'])
    expect(decoded.pathBindings).toEqual([])
    expect(typeof decoded.iat).toBe('number')
    expect(typeof decoded.exp).toBe('number')
    expect(decoded.exp! - decoded.iat!).toBe(config.gfsTokenTtlSeconds)
  })

  it('sets a kid header equal to the RFC 7638 thumbprint of the platform key', () => {
    const { token } = signGfsToken({ subject: 'u', drive: 'main', scopes: ['gfs.read'] })
    const header = jwt.decode(token, { complete: true })?.header
    expect(header?.kid).toBeDefined()
    expect(header?.kid).toBe(gfsSigningKeyId())
    expect(header?.alg).toBe('RS256')
  })

  it('carries pathBindings exactly when supplied', () => {
    const { token } = signGfsToken({
      subject: 'u',
      drive: 'main',
      scopes: ['gfs.read', 'gfs.write'],
      pathBindings: [{ path: '/org/eng/scratch', permissions: ['read', 'write'] }],
    })
    const decoded = jwt.verify(token, config.rpcJwtPublicKey, VERIFY) as jwt.JwtPayload
    expect(decoded.pathBindings).toEqual([
      { path: '/org/eng/scratch', permissions: ['read', 'write'] },
    ])
  })

  it('signs linked-admin provenance without conflating Desktop actor and token subject', () => {
    const desktopUserId = '11111111-1111-4111-8111-111111111111'
    const controlAdminId = '22222222-2222-4222-8222-222222222222'
    const { token } = signGfsToken({
      subject: controlAdminId,
      drive: 'main',
      scopes: ['gfs.write'],
      principalType: 'control-admin',
      brokeredAuthority: {
        desktopUserId,
        controlAdminId,
        authoritySource: 'linked-admin',
      },
    })
    const decoded = jwt.verify(token, config.rpcJwtPublicKey, VERIFY) as jwt.JwtPayload
    expect(decoded.sub).toBe(controlAdminId)
    expect(decoded.principalType).toBe('control-admin')
    expect(decoded.brokeredAuthority).toEqual({
      desktopUserId,
      controlAdminId,
      authoritySource: 'linked-admin',
    })
  })

  it('FAILS verification under the wrong audience (fail-loud)', () => {
    const { token } = signGfsToken({ subject: 'u', drive: 'main', scopes: ['gfs.read'] })
    expect(() =>
      jwt.verify(token, config.rpcJwtPublicKey, { ...VERIFY, audience: 'rpc-proxy' })
    ).toThrow()
  })

  it('FAILS verification when the token is expired (fail-loud)', () => {
    const expired = jwt.sign(
      { sub: 'u', drive: 'main', scopes: ['gfs.read'], pathBindings: [] },
      config.rpcJwtPrivateKey,
      { algorithm: 'RS256', issuer: 'control-api', audience: 'gfs-controller', expiresIn: -10 }
    )
    expect(() => jwt.verify(expired, config.rpcJwtPublicKey, VERIFY)).toThrow(jwt.TokenExpiredError)
  })

  it('FAILS verification when signed by a different key (fail-loud)', () => {
    const wrong = jwt.sign(
      { sub: 'u', drive: 'main', scopes: ['gfs.read'], pathBindings: [] },
      config.sessionJwtPrivateKey, // different keypair than rpc/gfs
      { algorithm: 'RS256', issuer: 'control-api', audience: 'gfs-controller', expiresIn: 300 }
    )
    expect(() => jwt.verify(wrong, config.rpcJwtPublicKey, VERIFY)).toThrow()
  })
})

describe('parseRequestedGfsScopes', () => {
  it('defaults to read-only browse when no scopes are requested (P1)', () => {
    expect(parseRequestedGfsScopes(undefined)).toEqual(['gfs.read'])
  })

  it('accepts a valid subset of the canonical bits', () => {
    expect(parseRequestedGfsScopes(['gfs.read', 'gfs.write'])).toEqual(['gfs.read', 'gfs.write'])
  })

  it('rejects unknown bits, duplicates, empty arrays, and non-arrays (fail-loud)', () => {
    expect(parseRequestedGfsScopes(['gfs.superuser'])).toBeNull()
    expect(parseRequestedGfsScopes(['gfs.read', 'gfs.read'])).toBeNull()
    expect(parseRequestedGfsScopes([])).toBeNull()
    expect(parseRequestedGfsScopes('gfs.read')).toBeNull()
  })

  it('GFS_SCOPES is exactly the five canonical permission bits', () => {
    expect([...GFS_SCOPES]).toEqual([
      'gfs.read',
      'gfs.write',
      'gfs.delete',
      'gfs.manage_acl',
      'gfs.share',
    ])
  })
})
