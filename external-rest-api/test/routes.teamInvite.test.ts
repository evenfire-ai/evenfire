import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createTeamRouter } from '../src/routes/team.js'

const authTokenMock = vi.hoisted(() => ({
  verifyToken: vi.fn(),
}))

const controlApiClientMock = vi.hoisted(() => ({
  controlApiRequest: vi.fn(),
}))

vi.mock('../src/authToken.js', () => authTokenMock)
vi.mock('../src/controlApiClient.js', () => controlApiClientMock)

function claimsFor(role: 'admin' | 'inviter' | 'member') {
  return {
    userId: 'user-1',
    email: 'user@example.com',
    teamId: 'team-1',
    role,
    exp: 9999999999,
  }
}

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use(createTeamRouter())
  return app
}

describe('POST /team/members/invite role ceiling', () => {
  beforeEach(() => {
    authTokenMock.verifyToken.mockReset()
    controlApiClientMock.controlApiRequest.mockReset()
  })

  it('rejects an inviter granting the admin role without calling the Control API', async () => {
    authTokenMock.verifyToken.mockReturnValue(claimsFor('inviter'))

    await request(makeApp())
      .post('/team/members/invite')
      .set('authorization', 'Bearer good-token')
      .send({ email: 'new@example.com', role: 'admin' })
      .expect(403, { error: 'Only team admins can invite admins' })

    expect(controlApiClientMock.controlApiRequest).not.toHaveBeenCalled()
  })

  it.each(['member', 'inviter'] as const)('allows an inviter to grant the %s role', async role => {
    authTokenMock.verifyToken.mockReturnValue(claimsFor('inviter'))
    controlApiClientMock.controlApiRequest.mockResolvedValue({
      email: 'new@example.com',
      token: 'tok',
    })

    await request(makeApp())
      .post('/team/members/invite')
      .set('authorization', 'Bearer good-token')
      .send({ email: 'new@example.com', role })
      .expect(201)

    expect(controlApiClientMock.controlApiRequest).toHaveBeenCalledWith(
      'POST',
      '/external/teams/team-1/invitations',
      expect.objectContaining({ body: { email: 'new@example.com', role } })
    )
  })

  it('allows an admin to grant the admin role', async () => {
    authTokenMock.verifyToken.mockReturnValue(claimsFor('admin'))
    controlApiClientMock.controlApiRequest.mockResolvedValue({
      email: 'new@example.com',
      token: 'tok',
    })

    await request(makeApp())
      .post('/team/members/invite')
      .set('authorization', 'Bearer good-token')
      .send({ email: 'new@example.com', role: 'admin' })
      .expect(201)

    expect(controlApiClientMock.controlApiRequest).toHaveBeenCalledWith(
      'POST',
      '/external/teams/team-1/invitations',
      expect.objectContaining({ body: { email: 'new@example.com', role: 'admin' } })
    )
  })
})
