import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { requireExternalWorkflowCaller } from '../src/routes/workflows/shared/auth.js'

const dbMocks = vi.hoisted(() => ({ query: vi.fn() }))
const tokenMocks = vi.hoisted(() => ({ verify: vi.fn() }))

vi.mock('../src/db.js', () => ({
  pool: { query: dbMocks.query },
  withTransaction: vi.fn(),
}))

vi.mock('../src/utils/auth/externalSessionAuthToken.js', () => ({
  verifyExternalSessionToken: tokenMocks.verify,
}))

function buildApp() {
  const app = express()
  app.get('/external/workflows', async (req, res) => {
    const caller = await requireExternalWorkflowCaller(req, res)
    if (!caller) return
    res.status(200).json({
      userId: caller.claims.userId,
      teamId: caller.claims.teamId,
      role: caller.claims.role,
    })
  })
  return app
}

describe('external workflow live team context', () => {
  beforeEach(() => {
    dbMocks.query.mockReset()
    tokenMocks.verify.mockReset()
    tokenMocks.verify.mockReturnValue({
      userId: 'user-1',
      email: 'user@example.com',
      teamId: 'team-1',
      role: 'admin',
    })
  })

  it('strips a removed team while preserving the authenticated user for direct grants', async () => {
    dbMocks.query.mockResolvedValue({ rows: [], rowCount: 0 })

    await request(buildApp())
      .get('/external/workflows')
      .set('x-user-session-token', 'session-token')
      .expect(200)
      .expect({ userId: 'user-1', teamId: null, role: 'member' })
  })

  it('replaces a stale claimed role with the current active role', async () => {
    dbMocks.query.mockResolvedValue({
      rows: [{ team_id: 'team-1', role: 'member', team_name: 'Team One' }],
      rowCount: 1,
    })

    await request(buildApp())
      .get('/external/workflows')
      .set('x-user-session-token', 'session-token')
      .expect(200)
      .expect({ userId: 'user-1', teamId: 'team-1', role: 'member' })
  })

  it('fails closed when workflow team-context reconciliation is unavailable', async () => {
    dbMocks.query.mockRejectedValue(new Error('database unavailable'))

    await request(buildApp())
      .get('/external/workflows')
      .set('x-user-session-token', 'session-token')
      .expect(503)
      .expect({ error: 'team_authorization_unavailable' })
  })
})
