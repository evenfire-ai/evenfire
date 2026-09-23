import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { rateLimit } from 'express-rate-limit'
import request from 'supertest'

const poolQuery = vi.hoisted(() => vi.fn())
const verifyToken = vi.hoisted(() => vi.fn())
const loggerWarn = vi.hoisted(() => vi.fn())

vi.mock('../src/db.js', () => ({
  pool: { query: (...args: unknown[]) => poolQuery(...args) },
}))
vi.mock('../src/observability/logger.js', () => ({
  rootLogger: { warn: (...args: unknown[]) => loggerWarn(...args) },
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
  server.use(
    (_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: 'internal' })
    }
  )
  return server
}

describe('external session lifecycle gate', () => {
  beforeEach(() => {
    poolQuery.mockReset()
    verifyToken.mockReset()
    loggerWarn.mockReset()
    poolQuery.mockResolvedValue({
      rows: [{ lifecycle_state: 'active', lifecycle_version: '4' }],
      rowCount: 1,
    })
  })

  it('accepts an active session whose generation matches the user row', async () => {
    verifyToken.mockReturnValueOnce(claims)
    poolQuery.mockResolvedValueOnce({
      rows: [{ lifecycle_state: 'active', lifecycle_version: '4' }],
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

  it('answers 503 with Retry-After when the lifecycle row cannot be read', async () => {
    verifyToken.mockReturnValueOnce(claims)
    poolQuery.mockRejectedValueOnce(new Error('timeout exceeded when trying to connect'))
    const response = await request(app()).get('/protected').set('x-user-session-token', 'session')
    expect(response.status).toBe(503)
    expect(response.body).toEqual({ error: 'session_backend_unavailable', retryAfterSeconds: 2 })
    expect(response.headers['retry-after']).toBe('2')
    expect(response.headers['cache-control']).toBe('no-store')
    // Witness: the lookup was attempted exactly once, for the token's user.
    expect(poolQuery).toHaveBeenCalledTimes(1)
    expect(poolQuery.mock.calls[0]?.[1]).toEqual([claims.userId])
    expect(loggerWarn).toHaveBeenCalledTimes(1)
    expect(loggerWarn.mock.calls[0]?.[0]).toEqual({
      event: 'external_session_backend_unavailable',
      err: 'timeout exceeded when trying to connect',
    })
  })

  it('keeps 401 for an invalid token while the lifecycle backend is failing', async () => {
    verifyToken.mockReturnValueOnce(null)
    poolQuery.mockRejectedValue(new Error('timeout exceeded when trying to connect'))
    const response = await request(app()).get('/protected').set('x-user-session-token', 'forged')
    expect(response.status).toBe(401)
    expect(response.body).toEqual({ error: 'Unauthorized' })
    // Witness: the token was verified; the rejection came before any lookup.
    expect(verifyToken).toHaveBeenCalledWith('forged')
    expect(poolQuery).not.toHaveBeenCalled()
    expect(loggerWarn).not.toHaveBeenCalled()
  })
})
