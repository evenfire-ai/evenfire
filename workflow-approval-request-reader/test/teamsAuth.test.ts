import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSign, generateKeyPairSync, type JsonWebKey, type KeyObject } from 'node:crypto'

const ISSUER = 'https://api.botframework.com'
const JWKS_URI = 'https://login.botframework.com/keys'
const APP_ID = '7e9cdb6c-87e8-4b1e-b291-76f7b8bdbe82'

function base64UrlJson(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function signedTeamsToken(params: {
  privateKey: KeyObject
  kid: string
  serviceUrl: string
}): string {
  const header = base64UrlJson({ alg: 'RS256', kid: params.kid, typ: 'JWT' })
  const now = Math.floor(Date.now() / 1000)
  const payload = base64UrlJson({
    aud: APP_ID,
    iss: ISSUER,
    exp: now + 300,
    nbf: now - 10,
    serviceurl: params.serviceUrl,
  })
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${payload}`)
  signer.end()
  return `${header}.${payload}.${signer.sign(params.privateKey).toString('base64url')}`
}

describe('verifyTeamsAuthorization', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('accepts matching activity and JWT serviceUrl values', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const jwk = publicKey.export({ format: 'jwk' }) as JsonWebKey & {
      alg?: string
      kid?: string
      use?: string
    }
    jwk.alg = 'RS256'
    jwk.kid = 'teams-key-1'
    jwk.use = 'sig'
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input)
        if (url === 'https://login.botframework.com/v1/.well-known/openidconfiguration') {
          return Response.json({ issuer: ISSUER, jwks_uri: JWKS_URI })
        }
        if (url === JWKS_URI) return Response.json({ keys: [jwk] })
        return Response.json({}, { status: 404 })
      })
    )
    const { verifyTeamsAuthorization } = await import('../src/teamsAuth.js')
    const token = signedTeamsToken({
      privateKey,
      kid: 'teams-key-1',
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
    })

    await expect(
      verifyTeamsAuthorization({
        authorizationHeader: `Bearer ${token}`,
        appId: APP_ID,
        serviceUrl: 'https://smba.trafficmanager.net/amer',
        timeoutMs: 1000,
      })
    ).resolves.toEqual({ ok: true })
  })

  it('rejects a signed Teams activity when the serviceUrl claim does not match the body', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const jwk = publicKey.export({ format: 'jwk' }) as JsonWebKey & {
      alg?: string
      kid?: string
      use?: string
    }
    jwk.alg = 'RS256'
    jwk.kid = 'teams-key-2'
    jwk.use = 'sig'
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input)
        if (url === 'https://login.botframework.com/v1/.well-known/openidconfiguration') {
          return Response.json({ issuer: ISSUER, jwks_uri: JWKS_URI })
        }
        if (url === JWKS_URI) return Response.json({ keys: [jwk] })
        return Response.json({}, { status: 404 })
      })
    )
    const { verifyTeamsAuthorization } = await import('../src/teamsAuth.js')
    const token = signedTeamsToken({
      privateKey,
      kid: 'teams-key-2',
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
    })

    await expect(
      verifyTeamsAuthorization({
        authorizationHeader: `Bearer ${token}`,
        appId: APP_ID,
        serviceUrl: 'https://attacker.example.com',
        timeoutMs: 1000,
      })
    ).resolves.toEqual({ ok: false, error: 'teams_service_url_mismatch' })
  })
})
