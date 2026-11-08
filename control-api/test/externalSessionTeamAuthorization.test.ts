import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { DatabaseError } from 'pg'
import request from 'supertest'
import { clerumErrorHandler } from '../src/http/errorHandler.js'
import {
  requireExternalRole,
  requireExternalTeamParamMatch,
  requireValidExternalSessionToken,
} from '../src/middleware/externalSessionAuth.js'

const session = vi.hoisted(() => ({ authenticateExternalUserSession: vi.fn() }))
const db = vi.hoisted(() => ({ query: vi.fn() }))

vi.mock('../src/services/auth/externalSessionAuthentication.js', () => session)
vi.mock('../src/db.js', () => ({ pool: db }))

// team_members.user_id and team_id are UUID columns, so the ids are UUIDs.
const USER_ID = '1d2e3f4a-5b6c-4d7e-8f9a-0b1c2d3e4f5a'
const TEAM_ID = '7e6d5c4b-3a29-4f18-8e7d-6c5b4a392817'
const OTHER_TEAM_ID = 'c0ffee00-1234-4abc-9def-0123456789ab'

/** A server-side error as pg raises it: a DatabaseError carrying a SQLSTATE. */
function databaseError(sqlstate: string): DatabaseError {
  const error = new DatabaseError(`synthetic database failure ${sqlstate}`, 0, 'error')
  error.code = sqlstate
  return error
}

function app() {
  const value = express()
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
        userId: USER_ID,
        email: 'user@example.com',
        teamId: TEAM_ID,
        role: 'admin',
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
    })
  })

  it('uses the current database role instead of the token role', async () => {
    db.query.mockResolvedValue({
      rows: [{ team_id: TEAM_ID, role: 'member' }],
      rowCount: 1,
    })

    await request(app())
      .get(`/teams/${TEAM_ID}`)
      .set('x-user-session-token', 'stale-admin-token')
      .expect(403)

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("tm.status = 'active'"), [
      USER_ID,
      TEAM_ID,
    ])
  })

  it('allows a current admin even when the legacy token team and role are stale', async () => {
    session.authenticateExternalUserSession.mockResolvedValue({
      status: 'authenticated',
      contract: 'v1',
      claims: {
        userId: USER_ID,
        email: 'user@example.com',
        teamId: OTHER_TEAM_ID,
        role: 'member',
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
    })
    db.query.mockResolvedValue({
      rows: [{ team_id: TEAM_ID, role: 'admin' }],
      rowCount: 1,
    })

    await request(app())
      .get(`/teams/${TEAM_ID}`)
      .set('x-user-session-token', 'stale-member-token')
      .expect(200)
  })

  it('classifies a bare pool error as an outage at the database boundary', async () => {
    db.query.mockRejectedValue(new Error('database unavailable'))

    await request(app())
      .get(`/teams/${TEAM_ID}`)
      .set('x-user-session-token', 'stale-admin-token')
      .expect(503)
      .expect({ error: 'authority_unavailable' })

    // Liveness witness: the live membership query reached the pool, so the
    // database-outage provenance came from the real boundary.
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('team_members'), [
      USER_ID,
      TEAM_ID,
    ])
  })

  it('keeps a plain database error on the sanitized 500 path', async () => {
    db.query.mockRejectedValue(databaseError('42P01'))

    const response = await request(app())
      .get(`/teams/${TEAM_ID}`)
      .set('x-user-session-token', 'stale-admin-token')

    expect(response.status).toBe(500)
    expect(response.body.error).toBe('Internal Server Error')
    expect(response.headers['retry-after']).toBeUndefined()
    // Liveness witness: the live membership query reached the pool.
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('team_members'), [
      USER_ID,
      TEAM_ID,
    ])
  })
})
