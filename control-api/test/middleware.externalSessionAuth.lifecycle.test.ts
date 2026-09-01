import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { DatabaseError } from 'pg'
import request from 'supertest'
import { AccessExecutionBudget } from '../src/services/access/accessExecutionBudget.js'

const poolQuery = vi.hoisted(() => vi.fn())
const poolConnect = vi.hoisted(() => vi.fn())
const verifyToken = vi.hoisted(() => vi.fn())
let authorityRows: Array<Record<string, unknown>> = []
const loggerWarn = vi.hoisted(() => vi.fn())

vi.mock('../src/db.js', () => ({
  pool: {
    query: (...args: unknown[]) => poolQuery(...args),
    connect: (...args: unknown[]) => poolConnect(...args),
  },
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
  iat: Math.floor(Date.now() / 1000) - 60,
  exp: Math.floor(Date.now() / 1000) + 3600,
}

/** A server-side error as pg raises it: a DatabaseError carrying a SQLSTATE. */
function databaseError(sqlstate: string): DatabaseError {
  const error = new DatabaseError(`server error ${sqlstate}`, 0, 'error')
  error.code = sqlstate
  return error
}

function app(budget?: AccessExecutionBudget) {
  const server = express()
  server.get(
    '/protected',
    rateLimit({ windowMs: 60_000, limit: 100, standardHeaders: 'draft-7', legacyHeaders: false }),
    async (req, res, next) => {
      if (budget) {
        const budgetedRequest = req as express.Request & {
          accessExecutionBudget?: AccessExecutionBudget
        }
        budgetedRequest.accessExecutionBudget = budget
      }
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
    poolConnect.mockReset()
    verifyToken.mockReset()
    loggerWarn.mockReset()
    authorityRows = [
      {
        id: claims.userId,
        lifecycle_state: 'active',
        lifecycle_version: '4',
        valid_after: null,
        token_revoked: false,
      },
    ]
    poolQuery.mockImplementation(async (sql: string) =>
      sql.includes('clock_timestamp()')
        ? { rows: [{ db_now: new Date() }], rowCount: 1 }
        : { rows: authorityRows, rowCount: authorityRows.length }
    )
  })

  it('accepts an active session whose generation matches the user row', async () => {
    verifyToken.mockReturnValueOnce(claims)
    const response = await request(app()).get('/protected').set('x-user-session-token', 'session')
    expect(response.status).toBe(200)
  })

  it.each([
    [{ lifecycle_state: 'retired', lifecycle_version: '5' }],
    [{ lifecycle_state: 'active', lifecycle_version: '5' }],
    [[]],
  ])('denies retired, stale, or missing authoritative rows', async row => {
    verifyToken.mockReturnValueOnce(claims)
    authorityRows = row
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
    // Witness: session validation reached the database-authoritative clock.
    expect(poolQuery).toHaveBeenCalledTimes(1)
    expect(String(poolQuery.mock.calls[0]?.[0])).toContain('clock_timestamp()')
    expect(loggerWarn).toHaveBeenCalledTimes(1)
    expect(loggerWarn.mock.calls[0]?.[0]).toMatchObject({
      event: 'external_session_backend_unavailable',
      err: expect.objectContaining({ message: 'timeout exceeded when trying to connect' }),
    })
  })

  it('answers 503 for a no-SQLSTATE database connection-acquire failure', async () => {
    verifyToken.mockReturnValueOnce(claims)
    const acquireFailure = new Error('private pg-pool acquire timeout sentinel')
    poolConnect.mockRejectedValueOnce(acquireFailure)
    const budget = AccessExecutionBudget.create('action')

    const response = await request(app(budget))
      .get('/protected')
      .set('x-user-session-token', 'session-with-budget')
    budget.close()

    expect(response.status).toBe(503)
    expect(response.body).toEqual({ error: 'session_backend_unavailable', retryAfterSeconds: 2 })
    expect(response.headers['retry-after']).toBe('2')
    expect(JSON.stringify(response.body)).not.toContain(acquireFailure.message)
    expect(JSON.stringify(response.headers)).not.toContain(acquireFailure.message)
    expect(poolConnect).toHaveBeenCalledTimes(1)
    expect(verifyToken).toHaveBeenCalledWith('session-with-budget')
    expect(loggerWarn).toHaveBeenCalledTimes(1)
  })

  it('keeps a successful-query session clock invariant failure on the ordinary 500 path', async () => {
    verifyToken.mockReturnValueOnce(claims)
    poolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })

    const response = await request(app()).get('/protected').set('x-user-session-token', 'session')

    expect(response.status).toBe(500)
    expect(response.body).toEqual({ error: 'internal' })
    expect(JSON.stringify(response.body)).not.toContain('database session clock unavailable')
    expect(response.headers['retry-after']).toBeUndefined()
    expect(response.headers['cache-control']).toBeUndefined()
    expect(String(poolQuery.mock.calls[0]?.[0])).toContain('clock_timestamp()')
    expect(loggerWarn).not.toHaveBeenCalled()
  })

  it.each([
    ['a pool acquire timeout', new Error('timeout exceeded when trying to connect')],
    ['a dropped connection', new Error('Connection terminated unexpectedly')],
    [
      'a refused socket',
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' }),
    ],
    // Five characters, like a SQLSTATE, but a socket error: no SQLSTATE class.
    ['a broken pipe', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })],
    // Node raises this when every address of a multi-address host refuses.
    [
      'a refused socket on every address',
      Object.assign(new AggregateError([], 'connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    ],
    ['SQLSTATE 08006 connection_failure', databaseError('08006')],
    ['SQLSTATE 53300 too_many_connections', databaseError('53300')],
    ['SQLSTATE 57P01 admin_shutdown', databaseError('57P01')],
    ['SQLSTATE 57014 query_canceled (statement timeout)', databaseError('57014')],
    ['SQLSTATE 58000 system_error', databaseError('58000')],
  ])('answers 503 for %s', async (_label, error) => {
    verifyToken.mockReturnValueOnce(claims)
    poolQuery.mockRejectedValueOnce(error)
    const response = await request(app()).get('/protected').set('x-user-session-token', 'session')
    expect(response.status).toBe(503)
    expect(response.body).toEqual({ error: 'session_backend_unavailable', retryAfterSeconds: 2 })
    expect(poolQuery).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['SQLSTATE 22P02 invalid_text_representation', databaseError('22P02')],
    ['SQLSTATE 42P01 undefined_table', databaseError('42P01')],
    ['SQLSTATE 42703 undefined_column', databaseError('42703')],
    // Defects in this process's code, not in the connection to PostgreSQL.
    ['a TypeError', new TypeError("Cannot read properties of undefined (reading 'query')")],
    ['a RangeError', new RangeError('Invalid array length')],
    [
      'a Node argument error',
      Object.assign(new TypeError('The "string" argument must be of type string'), {
        code: 'ERR_INVALID_ARG_TYPE',
      }),
    ],
  ])('passes %s to the error handler as a 500, not a 503', async (_label, error) => {
    verifyToken.mockReturnValueOnce(claims)
    poolQuery.mockRejectedValueOnce(error)
    const response = await request(app()).get('/protected').set('x-user-session-token', 'session')
    expect(response.status).toBe(500)
    expect(response.headers['retry-after']).toBeUndefined()
    // Witness: the lookup ran and failed; the defect was not relabelled.
    expect(poolQuery).toHaveBeenCalledTimes(1)
    expect(loggerWarn).not.toHaveBeenCalled()
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
