import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import {
  requireExternalRole,
  requireExternalTeamParamMatch,
  requireValidExternalSessionToken,
} from '../src/middleware/externalSessionAuth.js'

const session = vi.hoisted(() => ({ verifyExternalSessionToken: vi.fn() }))
const db = vi.hoisted(() => ({ query: vi.fn() }))

vi.mock('../src/utils/auth/externalSessionAuthToken.js', () => session)
vi.mock('../src/db.js', () => ({ pool: db }))

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
    session.verifyExternalSessionToken.mockReturnValue({
      userId: 'user-1',
      email: 'user@example.com',
      teamId: 'other-team',
      role: 'member',
      exp: Math.floor(Date.now() / 1000) + 3600,
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

  it('fails unavailable instead of trusting stale claims', async () => {
    db.query.mockRejectedValue(new Error('database unavailable'))

    await request(app())
      .get('/teams/team-1')
      .set('x-user-session-token', 'stale-admin-token')
      .expect(503)
      .expect({ error: 'authority_unavailable' })
  })
})
