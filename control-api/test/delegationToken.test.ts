import { describe, expect, it } from 'vitest'
import jwt from 'jsonwebtoken'
import { createPublicKey } from 'node:crypto'
import { config } from '../src/config.js'
import {
  getControlApiPublicKeyPem,
  signWrcDelegationToken,
} from '../src/utils/auth/delegationToken.js'

// Derive the verifier public key the same way the module under test does,
// so we can independently validate signatures without trusting the helper
// to return a correct PEM.
const publicKey = createPublicKey(config.adminJwtPrivateKey).export({
  type: 'spki',
  format: 'pem',
})

describe('utils/auth/delegationToken', () => {
  describe('signWrcDelegationToken', () => {
    it('produces a verifiable RS256 JWT with the expected claims', () => {
      const token = signWrcDelegationToken({
        adminUserId: 'user-123',
        recipeName: 'market-report',
        scope: 'admin:artifact_read',
      })

      const decoded = jwt.verify(token, publicKey, {
        algorithms: ['RS256'],
        issuer: 'control-api',
        audience: 'clerum-wrc',
      }) as jwt.JwtPayload

      expect(decoded.iss).toBe('control-api')
      expect(decoded.aud).toBe('clerum-wrc')
      expect(decoded.sub).toBe('admin:user-123')
      expect(decoded.recipeName).toBe('market-report')
      expect(decoded.scopes).toEqual(['admin:artifact_read'])
      expect(typeof decoded.jti).toBe('string')
      expect((decoded.jti as string).length).toBeGreaterThan(10)
      expect(typeof decoded.exp).toBe('number')
      expect(typeof decoded.iat).toBe('number')
    })

    it('sets exp to iat + 60s (short-lived delegation)', () => {
      const token = signWrcDelegationToken({
        adminUserId: 'user-abc',
        recipeName: 'recipe-1',
        scope: 'admin:artifact_read',
      })
      const decoded = jwt.decode(token) as jwt.JwtPayload
      expect(decoded.exp).toBeDefined()
      expect(decoded.iat).toBeDefined()
      // Allow 1s tolerance for clock drift inside jsonwebtoken
      const ttl = (decoded.exp as number) - (decoded.iat as number)
      expect(ttl).toBeGreaterThanOrEqual(59)
      expect(ttl).toBeLessThanOrEqual(61)
    })

    it('emits a unique jti for every call (audit traceability)', () => {
      const jtis = new Set<string>()
      for (let i = 0; i < 10; i++) {
        const token = signWrcDelegationToken({
          adminUserId: 'u',
          recipeName: 'r',
          scope: 'admin:artifact_read',
        })
        const decoded = jwt.decode(token) as jwt.JwtPayload
        jtis.add(decoded.jti as string)
      }
      expect(jtis.size).toBe(10)
    })

    it('is signed with RS256 (never HS256 or none)', () => {
      const token = signWrcDelegationToken({
        adminUserId: 'u',
        recipeName: 'r',
        scope: 'admin:artifact_read',
      })
      const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf-8'))
      expect(header.alg).toBe('RS256')
      expect(header.typ).toBe('JWT')
    })

    it('rejects a token if verified with a wrong audience', () => {
      const token = signWrcDelegationToken({
        adminUserId: 'u',
        recipeName: 'r',
        scope: 'admin:artifact_read',
      })
      expect(() =>
        jwt.verify(token, publicKey, {
          algorithms: ['RS256'],
          issuer: 'control-api',
          audience: 'some-other-aud',
        })
      ).toThrow()
    })

    it('rejects a token if verified with a wrong issuer', () => {
      const token = signWrcDelegationToken({
        adminUserId: 'u',
        recipeName: 'r',
        scope: 'admin:artifact_read',
      })
      expect(() =>
        jwt.verify(token, publicKey, {
          algorithms: ['RS256'],
          issuer: 'not-control-api',
          audience: 'clerum-wrc',
        })
      ).toThrow()
    })

    it('supports the admin:artifact_delete scope as well', () => {
      const token = signWrcDelegationToken({
        adminUserId: 'u',
        recipeName: 'r',
        scope: 'admin:artifact_delete',
      })
      const decoded = jwt.decode(token) as jwt.JwtPayload
      expect(decoded.scopes).toEqual(['admin:artifact_delete'])
    })

    it('can bind artifact-read delegation to a run and artifact name', () => {
      const token = signWrcDelegationToken({
        adminUserId: 'user-123',
        subject: 'user:user-123',
        recipeName: 'child-run-recipe',
        recipeNamespace: 'sandbox-recipes',
        runId: 'run-123',
        artifactName: 'custom-sdk-result.json',
        scope: 'artifact_read',
      })
      const decoded = jwt.decode(token) as jwt.JwtPayload
      expect(decoded.sub).toBe('user:user-123')
      expect(decoded.recipeName).toBe('child-run-recipe')
      expect(decoded.recipeNamespace).toBe('sandbox-recipes')
      expect(decoded.runId).toBe('run-123')
      expect(decoded.artifactName).toBe('custom-sdk-result.json')
      expect(decoded.scopes).toEqual(['artifact_read'])
    })
  })

  describe('getControlApiPublicKeyPem', () => {
    it('returns a valid SPKI PEM', () => {
      const pem = getControlApiPublicKeyPem()
      expect(pem).toContain('-----BEGIN PUBLIC KEY-----')
      expect(pem).toContain('-----END PUBLIC KEY-----')
    })

    it('returns a key that verifies signatures from signWrcDelegationToken', () => {
      const pem = getControlApiPublicKeyPem()
      const token = signWrcDelegationToken({
        adminUserId: 'u',
        recipeName: 'r',
        scope: 'admin:artifact_read',
      })
      // Must not throw when using the helper's own exported PEM as verifier
      const decoded = jwt.verify(token, pem, {
        algorithms: ['RS256'],
        issuer: 'control-api',
        audience: 'clerum-wrc',
      }) as jwt.JwtPayload
      expect(decoded.recipeName).toBe('r')
    })

    it('is idempotent across calls', () => {
      const pem1 = getControlApiPublicKeyPem()
      const pem2 = getControlApiPublicKeyPem()
      expect(pem1).toBe(pem2)
    })
  })
})
