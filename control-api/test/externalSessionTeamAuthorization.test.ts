import { beforeEach, describe, expect, it, vi } from 'vitest'
import express, { type NextFunction, type Request, type Response } from 'express'
import { DatabaseError } from 'pg'
import request from 'supertest'
import { clerumErrorHandler } from '../src/http/errorHandler.js'
import {
  requireExternalRole,
  requireExternalTeamParamMatch,
  requireValidExternalSessionToken,
} from '../src/middleware/externalSessionAuth.js'
import { AccessExecutionBudget } from '../src/services/access/accessExecutionBudget.js'

const session = vi.hoisted(() => ({ authenticateExternalUserSession: vi.fn() }))
const db = vi.hoisted(() => ({ query: vi.fn() }))

vi.mock('../src/services/auth/externalSessionAuthentication.js', () => session)
vi.mock('../src/db.js', () => ({ pool: db }))

/** A server-side error as pg raises it: a DatabaseError carrying a SQLSTATE. */
function databaseError(sqlstate: string): DatabaseError {
  const error = new DatabaseError(`synthetic database failure ${sqlstate}`, 0, 'error')
  error.code = sqlstate
  return error
}

function app(budget?: AccessExecutionBudget) {
  const value = express()
  if (budget) {
    value.use((req: Request, _res: Response, next: NextFunction) => {
      ;(req as Request & { accessExecutionBudget?: AccessExecutionBudget }).accessExecutionBudget =
        budget
      next()
    })
  }
  value.get(
    '/teams/:teamId',
    requireValidExternalSessionToken,
    requireExternalTeamParamMatch(),
    requireExternalRole(['admin']),
    (_req, res) => res.status(200).json({ ok: true })
  )
  value.use(clerumErrorHandler)
  return value
}

describe('external team authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    session.authenticateExternalUserSession.mockResolvedValue({
      status: 'authenticated',
      contract: 'v1',
      claims: {
        userId: 'user-1',
        email: 'user@example.com',
        teamId: 'team-1',
        role: 'admin',
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
    })
  })

  it('uses the current database role instead of the token role', async () => {
    db.query.mockResolvedValue({
      rows: [{ team_id: 'team-1', role: 'member' }],
      rowCount: 1,
    })

    await request(app())
      .get('/teams/team-1')
      .set('x-user-session-token', 'stale-admin-token')
      .expect(403)

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("tm.status = 'active'"), [
      'user-1',
      'team-1',
    ])
  })

  it('allows a current admin even when the legacy token team and role are stale', async () => {
    session.authenticateExternalUserSession.mockResolvedValue({
      status: 'authenticated',
      contract: 'v1',
      claims: {
        userId: 'user-1',
        email: 'user@example.com',
        teamId: 'other-team',
        role: 'member',
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
    })
    db.query.mockResolvedValue({
      rows: [{ team_id: 'team-1', role: 'admin' }],
      rowCount: 1,
    })

    await request(app())
      .get('/teams/team-1')
      .set('x-user-session-token', 'stale-member-token')
      .expect(200)
  })

  it('classifies a bare pool error as an outage at the database boundary', async () => {
    db.query.mockRejectedValue(new Error('database unavailable'))

    await request(app())
      .get('/teams/team-1')
      .set('x-user-session-token', 'stale-admin-token')
      .expect(503)
      .expect({ error: 'authority_unavailable' })

    // Liveness witness: the live membership query reached the pool, so the
    // database-outage provenance came from the real boundary.
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('team_members'), [
      'user-1',
      'team-1',
    ])
  })

  it('keeps a plain database error on the sanitized 500 path', async () => {
    db.query.mockRejectedValue(databaseError('42P01'))

    const response = await request(app())
      .get('/teams/team-1')
      .set('x-user-session-token', 'stale-admin-token')

    expect(response.status).toBe(500)
    expect(response.body.error).toBe('Internal Server Error')
    expect(response.headers['retry-after']).toBeUndefined()
    // Liveness witness: the live membership query reached the pool.
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('team_members'), [
      'user-1',
      'team-1',
    ])
  })

  it('keeps an exhausted access budget on the sanitized 500 path', async () => {
    const budget = AccessExecutionBudget.create('action', { limits: { producerCalls: 1 } })
    budget.charge({ kind: 'producerCalls' })

    const response = await request(app(budget))
      .get('/teams/team-1')
      .set('x-user-session-token', 'stale-admin-token')
    budget.close()

    expect(response.status).toBe(500)
    expect(response.body.error).toBe('Internal Server Error')
    expect(response.headers['retry-after']).toBeUndefined()
    // A budget refusal is not a database outage: the query never ran.
    expect(db.query).not.toHaveBeenCalled()
  })
})
