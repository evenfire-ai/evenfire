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

vi.mock('../src/db.js', () => ({
  pool: { query: dbMocks.query },
  withTransaction: vi.fn(),
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
  })

  it.each(['pending', 'rejected', 'expired', 'inactive', 'removed'])(
    'denies a %s team state instead of trusting the unexpired token',
    async () => {
      dbMocks.query.mockResolvedValue({ rows: [], rowCount: 0 })

      await request(buildApp())
        .get('/teams/team-1')
        .set('x-user-session-token', sessionToken())
        .expect(403)
        .expect({ error: 'team_membership_inactive' })
    }
  )

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
  })
})
