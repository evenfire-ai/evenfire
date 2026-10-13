import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { ControlApiError } from '../src/controlApiClient.js'
import { createTeamRouter } from '../src/routes/team.js'

const authTokenMock = vi.hoisted(() => ({
  verifyToken: vi.fn(),
}))

const controlApiClientMock = vi.hoisted(() => ({
  controlApiRequest: vi.fn(),
}))

vi.mock('../src/authToken.js', () => authTokenMock)
vi.mock('../src/controlApiClient.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/controlApiClient.js')>()),
  controlApiRequest: controlApiClientMock.controlApiRequest,
}))

const adminClaims = {
  userId: 'user-1',
  email: 'user@example.com',
  teamId: 'team-1',
  role: 'admin' as const,
  exp: 9999999999,
}

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use(createTeamRouter())
  return app
}

describe('DELETE /team/members/:userId', () => {
  beforeEach(() => {
    authTokenMock.verifyToken.mockReset()
    authTokenMock.verifyToken.mockReturnValue(adminClaims)
    controlApiClientMock.controlApiRequest.mockReset()
  })

  it('reports a Control API refusal as forbidden', async () => {
    controlApiClientMock.controlApiRequest.mockRejectedValue(
      new ControlApiError('forbidden', 403, { error: 'forbidden' })
    )

    await request(makeApp())
      .delete('/team/members/user-2')
      .set('authorization', 'Bearer good-token')
      .expect(403, { error: 'You are not allowed to delete members' })
  })

  it('reports a missing member as not found', async () => {
    controlApiClientMock.controlApiRequest.mockRejectedValue(
      new ControlApiError('not_found', 404, { error: 'not_found' })
    )

    await request(makeApp())
      .delete('/team/members/user-2')
      .set('authorization', 'Bearer good-token')
      .expect(404, { error: 'Team member not found' })
  })
})
