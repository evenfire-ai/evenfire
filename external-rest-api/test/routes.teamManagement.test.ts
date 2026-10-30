import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createApp } from '../src/app.js'
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

    it('reports a missing team without upstream details', async () => {
      controlApiClientMock.controlApiRequest.mockRejectedValue(controlApiFailure(404))

      await asRole(request(makeApp()).post('/team/members/invite'))
        .send({ email: 'new@example.com', role: 'member' })
        .expect(404, { error: 'Team request failed' })
    })

    it('does not report a Control API outage as a refusal', async () => {
      controlApiClientMock.controlApiRequest.mockRejectedValue(controlApiFailure(503))

      await asRole(request(makeApp()).post('/team/members/invite'))
        .send({ email: 'new@example.com', role: 'member' })
        .expect(502, { error: 'Team service unavailable' })
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

    it('reports a member removed before the role change as not found', async () => {
      roleLookupThen(async () => {
        throw controlApiFailure(404)
      })

      await asRole(request(makeApp()).patch('/team/members/user-2/role'))
        .send({ role: 'admin' })
        .expect(404, { error: 'Target member not found' })
    })

    it('reports a refused role lookup with the documented message', async () => {
      controlApiClientMock.controlApiRequest.mockRejectedValue(controlApiFailure(403))

      await asRole(request(makeApp()).patch('/team/members/user-2/role'))
        .send({ role: 'admin' })
        .expect(403, { error: 'You are not allowed to change roles' })
    })

    it('does not report a Control API outage as a missing member', async () => {
      controlApiClientMock.controlApiRequest.mockRejectedValue(controlApiFailure(503))

      await asRole(request(makeApp()).patch('/team/members/user-2/role'))
        .send({ role: 'admin' })
        .expect(502, { error: 'Team service unavailable' })
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

      await asRole(request(makeApp()).delete('/team/members/user-2')).expect(502, {
        error: 'Team service unavailable',
      })
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

      await asRole(request(makeApp()).put('/team/name'))
        .send({ name: 'Renamed' })
        .expect(502, { error: 'Team service unavailable' })
    })
  })

  describe('other Control API failures', () => {
    const upstreamFailure = (status: number) =>
      new ControlApiError(
        `Control API PUT /external/teams/team-1/members/user-2 failed (${status}): db detail`,
        status,
        { error: 'db detail with /internal/path' }
      )

    const routes: Array<[string, (app: express.Express) => request.Test]> = [
      [
        'invite',
        app =>
          request(app)
            .post('/api/v1/team/members/invite')
            .send({ email: 'new@example.com', role: 'member' }),
      ],
      [
        'role change',
        app => request(app).patch('/api/v1/team/members/user-2/role').send({ role: 'member' }),
      ],
      ['removal', app => request(app).delete('/api/v1/team/members/user-2')],
      ['rename', app => request(app).put('/api/v1/team/name').send({ name: 'Renamed' })],
    ]

    for (const [name, send] of routes) {
      it(`keeps the status of a client error without upstream details (${name})`, async () => {
        controlApiClientMock.controlApiRequest.mockRejectedValue(upstreamFailure(409))

        const response = await asRole(send(createApp()))

        expect(response.status).toBe(409)
        expect(response.body).toEqual({ error: 'Team request failed' })
      })

      it(`reports an upstream outage without upstream details (${name})`, async () => {
        controlApiClientMock.controlApiRequest.mockRejectedValue(upstreamFailure(503))

        const response = await asRole(send(createApp()))

        expect(response.status).toBe(502)
        expect(response.body).toEqual({ error: 'Team service unavailable' })
      })
    }
  })

  describe('member ids in Control API paths', () => {
    const memberId = '..%2F..%2Fusers%2Fuser-3'

    it('keeps a member id inside its path segment on removal', async () => {
      controlApiClientMock.controlApiRequest.mockResolvedValue({ user_id: 'user-3' })

      await asRole(request(makeApp()).delete(`/team/members/${memberId}`)).expect(200)

      expect(controlApiClientMock.controlApiRequest).toHaveBeenCalledWith(
        'DELETE',
        '/external/teams/team-1/members/..%2F..%2Fusers%2Fuser-3',
        expect.anything()
      )
    })

    it('keeps a member id inside its path segment on role change', async () => {
      controlApiClientMock.controlApiRequest.mockImplementation(async (method: string) =>
        method === 'GET' ? { role: 'member' } : { role: 'inviter' }
      )

      await asRole(request(makeApp()).patch(`/team/members/${memberId}/role`))
        .send({ role: 'inviter' })
        .expect(200)

      for (const method of ['GET', 'PATCH']) {
        expect(controlApiClientMock.controlApiRequest).toHaveBeenCalledWith(
          method,
          '/external/teams/team-1/members/..%2F..%2Fusers%2Fuser-3/role',
          expect.anything()
        )
      }
    })
  })
})
