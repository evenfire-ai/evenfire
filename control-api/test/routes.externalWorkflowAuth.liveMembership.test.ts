import { beforeEach, describe, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createExternalWorkflowsRouter } from '../src/routes/external/workflows/index.js'
import { MockGateway } from './mockGateway.js'

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
  app.use(createExternalWorkflowsRouter(new MockGateway('sandbox-recipes') as never))
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

  it('returns 503 from the real workflow router when membership authority is unavailable', async () => {
    dbMocks.query.mockRejectedValue(new Error('database unavailable'))

    await request(buildApp())
      .get('/external/workflows')
      .set('x-user-session-token', 'session-token')
      .expect(503)
      .expect({ error: 'team_authorization_unavailable' })
  })
})
