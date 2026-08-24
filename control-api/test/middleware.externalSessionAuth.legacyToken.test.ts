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

vi.mock('../src/services/access/userAccessRuntimePolicy.js', () => ({
  resolveEffectiveUserAccessPolicy: vi.fn().mockResolvedValue({
    acceptV1: true,
    issueV1: true,
    acceptV2: true,
    issueV2: false,
    renewV2: false,
    switchCompatibility: true,
    minimumClientVersion: null,
    enforceMinimumClient: false,
  }),
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
      rows: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          lifecycle_state: 'active',
          lifecycle_version: '1',
          valid_after: null,
          token_revoked: false,
        },
      ],
      rowCount: 1,
    })
  })

  it('accepts a producer-shaped pre-generation token only as lifecycle generation one', async () => {
    const token = legacySessionToken()

    const cryptographicallyValidClaims = jwt.verify(token, sessionJwtPublicKey, {
      algorithms: ['RS256'],
      issuer: config.jwtIssuer,
      audience: config.jwtAudience,
    }) as jwt.JwtPayload
    expect(cryptographicallyValidClaims.authGeneration).toBeUndefined()
    const parsed = verifyExternalSessionToken(token)
    expect(parsed).toEqual(
      expect.objectContaining({ userId: '11111111-1111-4111-8111-111111111111' })
    )
    expect(parsed?.authGeneration).toBeUndefined()

    const response = await request(app()).get('/protected').set('x-user-session-token', token)

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ok: true })
    expect(poolQuery).toHaveBeenCalledTimes(1)
  })
})
