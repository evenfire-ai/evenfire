import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { rateLimit } from 'express-rate-limit'
import request from 'supertest'

const poolQuery = vi.hoisted(() => vi.fn())
const verifyToken = vi.hoisted(() => vi.fn())

vi.mock('../src/db.js', () => ({
  pool: { query: (...args: unknown[]) => poolQuery(...args) },
}))
vi.mock('../src/utils/auth/externalSessionAuthToken.js', () => ({
  verifyExternalSessionToken: (...args: unknown[]) => verifyToken(...args),
}))

const claims = {
  userId: '11111111-1111-4111-8111-111111111111',
  email: 'user@example.com',
  teamId: null,
  role: 'member' as const,
  authGeneration: 4,
  iat: Math.floor(Date.now() / 1000) - 60,
  exp: Math.floor(Date.now() / 1000) + 3600,
}

function app() {
  const server = express()
  server.get(
    '/protected',
    rateLimit({ windowMs: 60_000, limit: 100, standardHeaders: 'draft-7', legacyHeaders: false }),
    async (req, res, next) => {
      const { requireValidExternalSessionToken } =
        await import('../src/middleware/externalSessionAuth.js')
      await requireValidExternalSessionToken(req as never, res, next)
    },
    (_req, res) => res.status(200).json({ ok: true })
  )
  return server
}

describe('external session lifecycle gate', () => {
  beforeEach(() => {
    poolQuery.mockClear()
    verifyToken.mockClear()
    poolQuery.mockResolvedValue({
      rows: [
        {
          id: claims.userId,
          lifecycle_state: 'active',
          lifecycle_version: '4',
          valid_after: null,
          token_revoked: false,
        },
      ],
      rowCount: 1,
    })
  })

  it('accepts an active session whose generation matches the user row', async () => {
    verifyToken.mockReturnValueOnce(claims)
    poolQuery.mockResolvedValueOnce({
      rows: [
        {
          id: claims.userId,
          lifecycle_state: 'active',
          lifecycle_version: '4',
          valid_after: null,
          token_revoked: false,
        },
      ],
      rowCount: 1,
    })
    const response = await request(app()).get('/protected').set('x-user-session-token', 'session')
    expect(response.status).toBe(200)
  })

  it.each([
    [{ lifecycle_state: 'retired', lifecycle_version: '5' }],
    [{ lifecycle_state: 'active', lifecycle_version: '5' }],
    [[]],
  ])('denies retired, stale, or missing authoritative rows', async row => {
    verifyToken.mockReturnValueOnce(claims)
    poolQuery.mockResolvedValueOnce({ rows: row, rowCount: row.length })
    const response = await request(app()).get('/protected').set('x-user-session-token', 'session')
    expect(response.status).toBe(401)
  })

  it('denies a verified legacy marker before querying the lifecycle row', async () => {
    verifyToken.mockReturnValueOnce({ ...claims, authGeneration: 0 })
    const response = await request(app()).get('/protected').set('x-user-session-token', 'session')
    expect(response.status).toBe(401)
    expect(poolQuery).not.toHaveBeenCalled()
  })
})
