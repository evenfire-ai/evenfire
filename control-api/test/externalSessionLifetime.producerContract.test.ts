import { afterEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { Request, Response } from 'express'
import jwt from 'jsonwebtoken'
import { createPublicKey } from 'node:crypto'
import request from 'supertest'
import { config as controlApiConfig } from '../src/config.js'
import { signExternalSessionToken } from '../src/utils/auth/externalSessionAuthToken.js'

const COOKIE_TTL_ENV = 'EXTERNAL_REST_API_PROFILE_SESSION_COOKIE_TTL_SECONDS'
const EXTERNAL_REST_JWT_PUBLIC_KEY_ENV = 'EXTERNAL_REST_API_JWT_PUBLIC_KEY'
// external-rest-api requires its control-api service token at config load (no code default).
const EXTERNAL_REST_SERVICE_TOKEN_ENV = 'EXTERNAL_REST_API_CONTROL_API_SERVICE_TOKEN'
const claims = {
  userId: 'session-lifetime-user',
  email: 'session-lifetime@example.invalid',
  teamId: 'session-lifetime-team',
  role: 'member' as const,
  authGeneration: 1,
}
const issuedAt = 2_000_000_000

type SetProfileSessionCookie = (req: Request, res: Response, token: string) => void

async function withExternalCookieProducer(
  ttlOverride: string | undefined,
  run: (cookieTtlSeconds: number, setCookie: SetProfileSessionCookie) => Promise<void>
): Promise<void> {
  const previousCookieTtl = process.env[COOKIE_TTL_ENV]
  const previousPublicKey = process.env[EXTERNAL_REST_JWT_PUBLIC_KEY_ENV]
  const previousServiceToken = process.env[EXTERNAL_REST_SERVICE_TOKEN_ENV]

  process.env[EXTERNAL_REST_SERVICE_TOKEN_ENV] = 'session-lifetime-service-token'
  if (ttlOverride === undefined) {
    delete process.env[COOKIE_TTL_ENV]
  } else {
    process.env[COOKIE_TTL_ENV] = ttlOverride
  }
  process.env[EXTERNAL_REST_JWT_PUBLIC_KEY_ENV] = createPublicKey(
    controlApiConfig.sessionJwtPrivateKey
  )
    .export({ type: 'spki', format: 'pem' })
    .toString()

  vi.resetModules()
  try {
    const [{ config: externalRestConfig }, { setProfileSessionCookie }] = await Promise.all([
      import('../../external-rest-api/src/config.js'),
      import('../../external-rest-api/src/sessionCookie.js'),
    ])
    await run(externalRestConfig.profileSessionCookieTtlSeconds, setProfileSessionCookie)
  } finally {
    if (previousCookieTtl === undefined) {
      delete process.env[COOKIE_TTL_ENV]
    } else {
      process.env[COOKIE_TTL_ENV] = previousCookieTtl
    }
    if (previousPublicKey === undefined) {
      delete process.env[EXTERNAL_REST_JWT_PUBLIC_KEY_ENV]
    } else {
      process.env[EXTERNAL_REST_JWT_PUBLIC_KEY_ENV] = previousPublicKey
    }
    if (previousServiceToken === undefined) {
      delete process.env[EXTERNAL_REST_SERVICE_TOKEN_ENV]
    } else {
      process.env[EXTERNAL_REST_SERVICE_TOKEN_ENV] = previousServiceToken
    }
    vi.resetModules()
  }
}

function signDefaultToken(): { token: string; ttlSeconds: number } {
  vi.spyOn(Date, 'now').mockReturnValue(issuedAt * 1000)
  const token = signExternalSessionToken(claims)
  const signed = jwt.decode(token) as jwt.JwtPayload
  if (typeof signed.exp !== 'number' || typeof signed.iat !== 'number') {
    throw new Error('The real session signer did not emit exp and iat')
  }
  return { token, ttlSeconds: signed.exp - signed.iat }
}

async function emitProfileSessionCookie(
  setCookie: SetProfileSessionCookie,
  token: string
): Promise<request.Response> {
  const app = express()
  app.set('trust proxy', 1)
  app.get('/session-cookie', (req, res) => {
    setCookie(req, res, token)
    res.status(204).end()
  })
  return request(app).get('/session-cookie').set('x-forwarded-proto', 'https').expect(204)
}

afterEach(() => vi.restoreAllMocks())

describe('V1 JWT and Profile session-cookie lifetime contract', () => {
  it('matches the real default JWT and Set-Cookie lifetimes at seven days', async () => {
    await withExternalCookieProducer(undefined, async (cookieTtlSeconds, setCookie) => {
      const { token, ttlSeconds } = signDefaultToken()

      expect(ttlSeconds).toBe(cookieTtlSeconds)
      expect(ttlSeconds).toBe(604_800)

      const response = await emitProfileSessionCookie(setCookie, token)
      expect(String(response.headers['set-cookie'])).toContain('Max-Age=' + cookieTtlSeconds)
    })
  })

  it('keeps a shorter explicit cookie override independent from the JWT default', async () => {
    await withExternalCookieProducer('7200', async (cookieTtlSeconds, setCookie) => {
      const { token, ttlSeconds } = signDefaultToken()

      expect(cookieTtlSeconds).toBe(7_200)
      expect(ttlSeconds).toBe(604_800)

      const response = await emitProfileSessionCookie(setCookie, token)
      expect(String(response.headers['set-cookie'])).toContain('Max-Age=7200')
    })
  })
})
