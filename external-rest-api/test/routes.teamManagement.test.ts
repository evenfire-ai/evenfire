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

type Role = 'admin' | 'inviter' | 'member'

function claimsFor(role: Role) {
  return {
    userId: 'user-1',
    email: 'user@example.com',
    teamId: 'team-1',
    role,
    exp: 9999999999,
  }
}

function controlApiFailure(status: number) {
  return new ControlApiError(`Control API request failed (${status})`, status, {
    error: status === 403 ? 'forbidden' : 'not_found',
  })
}

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use(createTeamRouter())
  app.use(
    (_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: 'Internal Server Error' })
    }
  )
  return app
}

function asRole(req: request.Test) {
  return req.set('authorization', 'Bearer good-token')
}

describe('team management delegates authorization to the Control API', () => {
  beforeEach(() => {
    authTokenMock.verifyToken.mockReset()
    authTokenMock.verifyToken.mockReturnValue(claimsFor('member'))
    controlApiClientMock.controlApiRequest.mockReset()
  })

  describe('POST /team/members/invite', () => {
    it('forwards an admin invitation from a session with a lower role', async () => {
      controlApiClientMock.controlApiRequest.mockResolvedValue({
        email: 'new@example.com',
        token: 'tok',
      })

      await asRole(request(makeApp()).post('/team/members/invite'))
        .send({ email: 'new@example.com', role: 'admin' })
        .expect(201)

      expect(controlApiClientMock.controlApiRequest).toHaveBeenCalledWith(
        'POST',
        '/external/teams/team-1/invitations',
        expect.objectContaining({ body: { email: 'new@example.com', role: 'admin' } })
      )
    })

    it('reports a Control API refusal with the documented message', async () => {
      authTokenMock.verifyToken.mockReturnValue(claimsFor('inviter'))
      controlApiClientMock.controlApiRequest.mockRejectedValue(controlApiFailure(403))

      await asRole(request(makeApp()).post('/team/members/invite'))
        .send({ email: 'new@example.com', role: 'admin' })
        .expect(403, { error: 'You are not allowed to invite members' })
    })

    it('does not report a Control API outage as a refusal', async () => {
      controlApiClientMock.controlApiRequest.mockRejectedValue(controlApiFailure(503))

      await asRole(request(makeApp()).post('/team/members/invite'))
        .send({ email: 'new@example.com', role: 'member' })
        .expect(500)
    })
  })

  describe('PATCH /team/members/:userId/role', () => {
    function roleLookupThen(patch: () => Promise<unknown>) {
      controlApiClientMock.controlApiRequest.mockImplementation(async (method: string) =>
        method === 'GET' ? { role: 'member' } : patch()
      )
    }

    it('forwards a role change from a session with a lower role', async () => {
      roleLookupThen(async () => ({ team_id: 'team-1', user_id: 'user-2', role: 'inviter' }))

      await asRole(request(makeApp()).patch('/team/members/user-2/role'))
        .send({ role: 'inviter' })
        .expect(200)

      expect(controlApiClientMock.controlApiRequest).toHaveBeenCalledWith(
        'PATCH',
        '/external/teams/team-1/members/user-2/role',
        expect.objectContaining({ body: { role: 'inviter' } })
      )
    })

    it('reports a Control API refusal with the documented message', async () => {
      roleLookupThen(async () => {
        throw controlApiFailure(403)
      })

      await asRole(request(makeApp()).patch('/team/members/user-2/role'))
        .send({ role: 'admin' })
        .expect(403, { error: 'You are not allowed to change roles' })
    })

    it('reports a missing target member as not found', async () => {
      controlApiClientMock.controlApiRequest.mockRejectedValue(controlApiFailure(404))

      await asRole(request(makeApp()).patch('/team/members/user-2/role'))
        .send({ role: 'admin' })
        .expect(404, { error: 'Target member not found' })
    })

    it('does not report a Control API outage as a missing member', async () => {
      controlApiClientMock.controlApiRequest.mockRejectedValue(controlApiFailure(503))

      await asRole(request(makeApp()).patch('/team/members/user-2/role'))
        .send({ role: 'admin' })
        .expect(500)
    })
  })

  describe('DELETE /team/members/:userId', () => {
    it('forwards a removal from a session with a lower role', async () => {
      controlApiClientMock.controlApiRequest.mockResolvedValue({ user_id: 'user-2' })

      await asRole(request(makeApp()).delete('/team/members/user-2')).expect(200)

      expect(controlApiClientMock.controlApiRequest).toHaveBeenCalledWith(
        'DELETE',
        '/external/teams/team-1/members/user-2',
        expect.anything()
      )
    })

    it('reports a Control API refusal with the documented message', async () => {
      controlApiClientMock.controlApiRequest.mockRejectedValue(controlApiFailure(403))

      await asRole(request(makeApp()).delete('/team/members/user-2')).expect(403, {
        error: 'You are not allowed to delete members',
      })
    })

    it('reports a missing member as not found', async () => {
      controlApiClientMock.controlApiRequest.mockRejectedValue(controlApiFailure(404))

      await asRole(request(makeApp()).delete('/team/members/user-2')).expect(404, {
        error: 'Team member not found',
      })
    })

    it('does not report a Control API outage as a missing member', async () => {
      controlApiClientMock.controlApiRequest.mockRejectedValue(controlApiFailure(503))

      await asRole(request(makeApp()).delete('/team/members/user-2')).expect(500)
    })
  })

  describe('PUT /team/name', () => {
    it('forwards a rename from a session with a lower role', async () => {
      controlApiClientMock.controlApiRequest.mockResolvedValue({ id: 'team-1', name: 'Renamed' })

      await asRole(request(makeApp()).put('/team/name'))
        .send({ name: 'Renamed' })
        .expect(200, { team: { id: 'team-1', name: 'Renamed' } })
    })

    it('reports a Control API refusal with the documented message', async () => {
      controlApiClientMock.controlApiRequest.mockRejectedValue(controlApiFailure(403))

      await asRole(request(makeApp()).put('/team/name'))
        .send({ name: 'Renamed' })
        .expect(403, { error: 'You are not allowed to rename the team' })
    })

    it('reports a missing team as not found', async () => {
      controlApiClientMock.controlApiRequest.mockRejectedValue(controlApiFailure(404))

      await asRole(request(makeApp()).put('/team/name'))
        .send({ name: 'Renamed' })
        .expect(404, { error: 'Team not found' })
    })

    it('does not report a Control API outage as a missing team', async () => {
      controlApiClientMock.controlApiRequest.mockRejectedValue(controlApiFailure(503))

      await asRole(request(makeApp()).put('/team/name')).send({ name: 'Renamed' }).expect(500)
    })
  })
})
