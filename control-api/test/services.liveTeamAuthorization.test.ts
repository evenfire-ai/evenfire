import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { DatabaseError } from 'pg'
import request from 'supertest'
import { clerumErrorHandler } from '../src/http/errorHandler.js'
import {
  type ExternalAuthedRequest,
  requireExternalTeamParamMatch,
} from '../src/middleware/externalSessionAuth.js'
import { getLiveTeamMembership } from '../src/services/access/liveTeamAuthorization.js'

const pool = vi.hoisted(() => ({ query: vi.fn() }))

vi.mock('../src/db.js', () => ({ pool }))

const USER_ID = '6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a5b'
const TEAM_ID = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** PostgreSQL's answer to a non-UUID literal compared with a uuid column. */
function invalidUuidError(value: string): DatabaseError {
  const error = new DatabaseError(
    `synthetic invalid input syntax for type uuid: "${value}"`,
    0,
    'error'
  )
  error.code = '22P02'
  return error
}

/**
 * Emulates PostgreSQL for the live membership query: a non-UUID `$1` or `$2`
 * raises 22P02, a UUID pair returns the active member row.
 */
function emulatePostgresMembership(values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'string' && !UUID_PATTERN.test(value)) {
      throw invalidUuidError(value)
    }
  }
  return { rows: [{ team_id: values[1], role: 'admin' }], rowCount: 1 }
}

describe('getLiveTeamMembership', () => {
  it('answers no membership for a non-UUID team id without querying, and queries a UUID pair', async () => {
    const db = {
      query: vi.fn(async () => ({ rows: [{ team_id: TEAM_ID, role: 'member' }], rowCount: 1 })),
    }

    await expect(getLiveTeamMembership(USER_ID, 'abc', { db })).resolves.toBeNull()
    expect(db.query).not.toHaveBeenCalled()

    // Liveness witness: the same helper with a UUID team id reaches the database.
    await expect(getLiveTeamMembership(USER_ID, TEAM_ID, { db })).resolves.toEqual({
      teamId: TEAM_ID,
      role: 'member',
    })
    expect(db.query).toHaveBeenCalledTimes(1)
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("tm.status = 'active'"), [
      USER_ID,
      TEAM_ID,
    ])
  })

  it('answers no membership for a non-UUID user id without querying', async () => {
    const db = {
      query: vi.fn(async () => ({ rows: [{ team_id: TEAM_ID, role: 'member' }], rowCount: 1 })),
    }

    await expect(getLiveTeamMembership('user-1', TEAM_ID, { db })).resolves.toBeNull()
    expect(db.query).not.toHaveBeenCalled()

    // Liveness witness: a UUID user id with the same team id reaches the database.
    await expect(getLiveTeamMembership(USER_ID, TEAM_ID, { db })).resolves.not.toBeNull()
    expect(db.query).toHaveBeenCalledTimes(1)
  })
})

describe('requireExternalTeamParamMatch with a malformed team id', () => {
  function app() {
    const value = express()
    value.get(
      '/team',
      (req: ExternalAuthedRequest, _res, next) => {
        req.externalAuth = {
          userId: USER_ID,
          email: 'member@example.com',
          teamId: TEAM_ID,
          role: 'admin',
          exp: Math.floor(Date.now() / 1000) + 3600,
        }
        next()
      },
      requireExternalTeamParamMatch(),
      (req: ExternalAuthedRequest, res) => res.status(200).json({ team: req.externalTeamAuth })
    )
    value.use(clerumErrorHandler)
    return value
  }

  beforeEach(() => {
    pool.query.mockReset()
    pool.query.mockImplementation(async (_sql: string, values: unknown[]) =>
      emulatePostgresMembership(values)
    )
  })

  it('answers 403 Forbidden for a non-UUID teamId, as for any team the caller is not in', async () => {
    await request(app()).get('/team').query({ teamId: 'abc' }).expect(403).expect({
      error: 'Forbidden',
    })
    expect(pool.query).not.toHaveBeenCalled()

    // Liveness witness: a UUID teamId with a member row reaches the handler.
    await request(app())
      .get('/team')
      .query({ teamId: TEAM_ID })
      .expect(200)
      .expect({ team: { teamId: TEAM_ID, role: 'admin' } })
    expect(pool.query).toHaveBeenCalledTimes(1)
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('team_members'), [
      USER_ID,
      TEAM_ID,
    ])
  })
})
