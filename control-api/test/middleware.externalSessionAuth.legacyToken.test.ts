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

function legacySessionToken(authGeneration?: number): string {
  return jwt.sign(
    {
      userId: '11111111-1111-4111-8111-111111111111',
      email: 'legacy@example.com',
      teamId: null,
      role: 'member',
      ...(authGeneration === undefined ? {} : { authGeneration }),
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
    poolQuery.mockImplementation(async (sql: string) =>
      sql.includes('clock_timestamp()')
        ? { rows: [{ db_now: new Date() }], rowCount: 1 }
        : {
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
          }
    )
  })

  it('denies a signature-valid token without a lifecycle generation', async () => {
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
    expect(response.body).not.toEqual({ ok: true })
    expect(poolQuery).not.toHaveBeenCalled()
  })

  it('accepts the same token shape carrying generation one', async () => {
    const token = legacySessionToken(1)

    expect(verifyExternalSessionToken(token)).toEqual(
      expect.objectContaining({
        userId: '11111111-1111-4111-8111-111111111111',
        authGeneration: 1,
      })
    )

    const response = await request(app()).get('/protected').set('x-user-session-token', token)

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ok: true })
    expect(poolQuery).toHaveBeenCalledTimes(2)
    expect(String(poolQuery.mock.calls[0]?.[0])).toContain('clock_timestamp()')
  })
})
