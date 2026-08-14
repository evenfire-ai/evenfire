import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { rateLimit } from 'express-rate-limit'
import jwt from 'jsonwebtoken'
import { createPublicKey } from 'node:crypto'
import request from 'supertest'
import { config } from '../src/config.js'
import { requireValidExternalSessionToken } from '../src/middleware/externalSessionAuth.js'
import { verifyExternalSessionToken } from '../src/utils/auth/externalSessionAuthToken.js'

const poolQuery = vi.hoisted(() => vi.fn())

vi.mock('../src/db.js', () => ({
  pool: { query: (...args: unknown[]) => poolQuery(...args) },
}))

const sessionJwtPublicKey = createPublicKey(config.sessionJwtPrivateKey).export({
  type: 'spki',
  format: 'pem',
})

function legacySessionToken(): string {
  return jwt.sign(
    {
      userId: '11111111-1111-4111-8111-111111111111',
      email: 'legacy@example.com',
      teamId: null,
      role: 'member',
    },
    config.sessionJwtPrivateKey,
    {
      algorithm: 'RS256',
      expiresIn: 60 * 60,
      issuer: config.jwtIssuer,
      audience: config.jwtAudience,
    }
  )
}

function app() {
  const server = express()
  server.get(
    '/protected',
    rateLimit({ windowMs: 60_000, limit: 100, standardHeaders: 'draft-7', legacyHeaders: false }),
    requireValidExternalSessionToken,
    (_req, res) => {
      res.status(200).json({ ok: true })
    }
  )
  return server
}

describe('external session legacy token cut-over', () => {
  beforeEach(() => {
    poolQuery.mockClear()
    poolQuery.mockResolvedValue({
      rows: [{ lifecycle_state: 'active', lifecycle_version: '1' }],
      rowCount: 1,
    })
  })

  it('rejects a valid RS256 legacy token that has no auth generation', async () => {
    const token = legacySessionToken()

    const cryptographicallyValidClaims = jwt.verify(token, sessionJwtPublicKey, {
      algorithms: ['RS256'],
      issuer: config.jwtIssuer,
      audience: config.jwtAudience,
    }) as jwt.JwtPayload
    expect(cryptographicallyValidClaims.authGeneration).toBeUndefined()
    expect(verifyExternalSessionToken(token)).toBeNull()

    const response = await request(app()).get('/protected').set('x-user-session-token', token)

    expect(response.status).toBe(401)
    expect(response.body).toEqual({ error: 'Unauthorized' })
    expect(poolQuery).not.toHaveBeenCalled()
  })
})
