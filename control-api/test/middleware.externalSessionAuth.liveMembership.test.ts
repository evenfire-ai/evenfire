import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import {
  requireExternalRole,
  requireExternalTeamParamMatch,
  requireValidExternalSessionToken,
} from '../src/middleware/externalSessionAuth.js'
import { signExternalSessionToken } from '../src/utils/auth/externalSessionAuthToken.js'

const dbMocks = vi.hoisted(() => ({ query: vi.fn() }))
const logMocks = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }))

vi.mock('../src/db.js', () => ({
  pool: { query: dbMocks.query },
  withTransaction: vi.fn(),
}))

vi.mock('../src/observability/logger.js', () => ({
  rootLogger: { child: () => logMocks },
}))

function sessionToken(role: 'admin' | 'inviter' | 'member' = 'member') {
  return signExternalSessionToken({
    userId: 'user-1',
    email: 'user@example.com',
    teamId: 'team-1',
    role,
  })
}

function buildApp(allowedRoles: Array<'admin' | 'inviter' | 'member'> = []) {
  const app = express()
  app.get(
    '/teams/:teamId',
    requireValidExternalSessionToken,
    requireExternalTeamParamMatch(),
    ...(allowedRoles.length > 0 ? [requireExternalRole(allowedRoles)] : []),
    (req, res) => res.status(200).json({ ok: true })
  )
  return app
}

describe('external session live team authorization', () => {
  beforeEach(() => {
    dbMocks.query.mockReset()
    logMocks.info.mockReset()
    logMocks.warn.mockReset()
  })

  it('denies a deleted membership through the repository active-state predicate', async () => {
    dbMocks.query.mockImplementation(async text =>
      String(text).includes("tm.status = 'active'")
        ? { rows: [], rowCount: 0 }
        : {
            rows: [{ team_id: 'team-1', role: 'admin', team_name: 'Team One' }],
            rowCount: 1,
          }
    )

    await request(buildApp())
      .get('/teams/team-1')
      .set('x-user-session-token', sessionToken())
      .expect(403)
      .expect({ error: 'team_membership_inactive' })

    expect(logMocks.info).toHaveBeenCalledWith(
      {
        event: 'live_team_authorization_denied',
        userId: 'user-1',
        teamId: 'team-1',
        code: 'team_membership_inactive',
      },
      'Live team authorization denied'
    )
  })

  it('enforces the current demoted role instead of the token role', async () => {
    dbMocks.query.mockResolvedValue({
      rows: [{ team_id: 'team-1', role: 'member', team_name: 'Team One' }],
      rowCount: 1,
    })

    await request(buildApp(['admin']))
      .get('/teams/team-1')
      .set('x-user-session-token', sessionToken('admin'))
      .expect(403)
      .expect({ error: 'team_role_insufficient' })
  })

  it('uses the current promoted role for a valid membership', async () => {
    dbMocks.query.mockResolvedValue({
      rows: [{ team_id: 'team-1', role: 'admin', team_name: 'Team One' }],
      rowCount: 1,
    })

    await request(buildApp(['admin']))
      .get('/teams/team-1')
      .set('x-user-session-token', sessionToken('member'))
      .expect(200)
      .expect({ ok: true })
  })

  it('fails closed when the live membership store is unavailable', async () => {
    dbMocks.query.mockRejectedValue(new Error('database unavailable'))

    await request(buildApp())
      .get('/teams/team-1')
      .set('x-user-session-token', sessionToken())
      .expect(503)
      .expect({ error: 'team_authorization_unavailable' })

    expect(logMocks.warn).toHaveBeenCalledWith(
      {
        event: 'live_team_authorization_unavailable',
        userId: 'user-1',
        teamId: 'team-1',
        code: 'team_authorization_unavailable',
      },
      'Live team authorization dependency unavailable'
    )
  })
})
