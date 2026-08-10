import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import {
  requireExternalRole,
  requireExternalTeamParamMatch,
  requireValidExternalSessionToken,
} from '../src/middleware/externalSessionAuth.js'

const session = vi.hoisted(() => ({ verifyExternalSessionToken: vi.fn() }))
const authorization = vi.hoisted(() => ({ getLiveTeamMembership: vi.fn() }))
const userSessions = vi.hoisted(() => ({ validateUserSessionClaims: vi.fn() }))

vi.mock('../src/utils/auth/externalSessionAuthToken.js', () => session)
vi.mock('../src/services/access/liveTeamAuthorization.js', () => authorization)
vi.mock('../src/services/auth/userSessionService.js', () => userSessions)

function app() {
  const value = express()
  value.get(
    '/teams/:teamId',
    requireValidExternalSessionToken,
    requireExternalTeamParamMatch(),
    requireExternalRole(['admin']),
    (_req, res) => res.status(200).json({ ok: true })
  )
  return value
}

describe('external team authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    session.verifyExternalSessionToken.mockReturnValue({
      userId: 'user-1',
      email: 'user@example.com',
      teamId: 'team-1',
      role: 'admin',
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
  })

  it('rejects a revoked v2 session before team authorization', async () => {
    session.verifyExternalSessionToken.mockReturnValue({
      userId: 'user-1',
      email: 'user@example.com',
      teamId: null,
      role: 'member',
      exp: Math.floor(Date.now() / 1000) + 3600,
      sessionContract: 'v2',
      sid: 'session-1',
      jti: 'representation-1',
      sv: 1,
      authTime: Math.floor(Date.now() / 1000),
      amr: ['pwd'],
    })
    userSessions.validateUserSessionClaims.mockResolvedValue({
      status: 'revoked',
      reason: 'logout',
    })

    await request(app())
      .get('/teams/team-1')
      .set('x-user-session-token', 'revoked-v2-token')
      .expect(401)
    expect(authorization.getLiveTeamMembership).not.toHaveBeenCalled()
  })

  it('returns unavailable when the v2 session store cannot decide', async () => {
    session.verifyExternalSessionToken.mockReturnValue({
      userId: 'user-1',
      email: 'user@example.com',
      teamId: null,
      role: 'member',
      exp: Math.floor(Date.now() / 1000) + 3600,
      sessionContract: 'v2',
      sid: 'session-1',
      jti: 'representation-1',
      sv: 1,
      authTime: Math.floor(Date.now() / 1000),
      amr: ['pwd'],
    })
    userSessions.validateUserSessionClaims.mockRejectedValue(new Error('database unavailable'))

    await request(app())
      .get('/teams/team-1')
      .set('x-user-session-token', 'v2-token')
      .expect(503)
      .expect({ error: 'authority_unavailable' })
    expect(authorization.getLiveTeamMembership).not.toHaveBeenCalled()
  })

  it('uses the current database role instead of the token role', async () => {
    authorization.getLiveTeamMembership.mockResolvedValue({ teamId: 'team-1', role: 'member' })

    await request(app())
      .get('/teams/team-1')
      .set('x-user-session-token', 'stale-admin-token')
      .expect(403)

    expect(authorization.getLiveTeamMembership).toHaveBeenCalledWith('user-1', 'team-1')
  })

  it('allows a current admin even when the legacy token role is stale', async () => {
    session.verifyExternalSessionToken.mockReturnValue({
      userId: 'user-1',
      email: 'user@example.com',
      teamId: 'other-team',
      role: 'member',
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
    authorization.getLiveTeamMembership.mockResolvedValue({ teamId: 'team-1', role: 'admin' })

    await request(app())
      .get('/teams/team-1')
      .set('x-user-session-token', 'stale-member-token')
      .expect(200)
  })

  it('fails unavailable instead of trusting stale claims', async () => {
    authorization.getLiveTeamMembership.mockRejectedValue(new Error('database unavailable'))

    await request(app())
      .get('/teams/team-1')
      .set('x-user-session-token', 'stale-admin-token')
      .expect(503)
      .expect({ error: 'authority_unavailable' })
  })
})
