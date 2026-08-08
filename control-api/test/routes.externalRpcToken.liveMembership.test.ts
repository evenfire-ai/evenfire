import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { requireInternalToken } from '../src/middleware/internalServiceAuth.js'
import { createExternalAuthRouter } from '../src/routes/external/auth.js'
import { signExternalSessionToken } from '../src/utils/auth/externalSessionAuthToken.js'
import { SANDBOX_UI_RPC_HOST_REF, verifyRpcAccessToken } from '../src/utils/auth/rpcAuthToken.js'

const directory = vi.hoisted(() => ({
  authorizeLiveTeamMembership: vi.fn(),
  getTeamAgents: vi.fn(),
  getUserAgents: vi.fn(),
  googleLoginData: vi.fn(),
  passwordLoginData: vi.fn(),
  requestProfilePasswordReset: vi.fn(),
}))

const sandboxUi = vi.hoisted(() => ({
  userHasUiBearingRecipeAccess: vi.fn(),
}))

vi.mock('../src/services/directory/index.js', () => directory)
vi.mock('../src/utils/auth/sandboxUiScope.js', () => sandboxUi)

describe('external RPC token live membership', () => {
  const internalToken = 'dev-external-rest-api-token'
  const staleSessionToken = signExternalSessionToken({
    userId: 'u1',
    email: 'u1@example.com',
    teamId: 'team-removed',
    role: 'admin',
  })

  function app() {
    const instance = express()
    instance.use(express.json())
    instance.use(requireInternalToken)
    instance.use(createExternalAuthRouter({} as never))
    return instance
  }

  function issue(body: { scopes: string[]; hostRefs: string[] }) {
    return request(app())
      .post('/external/rpc/token')
      .set('authorization', `Bearer ${internalToken}`)
      .set('x-service-token', 'external-rest-api')
      .send({ sessionToken: staleSessionToken, ...body })
  }

  beforeEach(() => {
    Object.values(directory).forEach(mock => mock.mockReset())
    sandboxUi.userHasUiBearingRecipeAccess.mockReset()
    directory.authorizeLiveTeamMembership.mockResolvedValue({
      status: 'denied',
      code: 'team_membership_inactive',
    })
    directory.getUserAgents.mockResolvedValue({ userId: 'u1', agentNames: [] })
    directory.getTeamAgents.mockResolvedValue({ teamId: 'team-removed', agentNames: [] })
    sandboxUi.userHasUiBearingRecipeAccess.mockResolvedValue(false)
  })

  it('issues a user-scoped token for a directly granted Agent after team removal', async () => {
    directory.getUserAgents.mockResolvedValue({ userId: 'u1', agentNames: ['direct-agent'] })

    const response = await issue({
      scopes: ['host:message:invoke'],
      hostRefs: ['direct-agent'],
    }).expect(200)

    expect(response.body).toMatchObject({
      accessScope: 'user',
      teamId: null,
      scopes: ['host:message:invoke'],
      hostRefs: ['direct-agent'],
    })
    expect(verifyRpcAccessToken(response.body.token)).toMatchObject({
      sub: 'u1',
      accessScope: 'user',
      teamId: null,
      role: 'member',
      scopes: ['host:message:invoke'],
      hostRefs: ['direct-agent'],
    })
    expect(directory.getTeamAgents).not.toHaveBeenCalled()
  })

  it('denies a team-only Agent after team removal', async () => {
    await issue({ scopes: ['host:message:invoke'], hostRefs: ['team-agent'] })
      .expect(403)
      .expect({ error: 'team_membership_inactive' })

    expect(directory.getTeamAgents).not.toHaveBeenCalled()
  })

  it('keeps a direct Sandbox UI grant user-scoped after team removal', async () => {
    sandboxUi.userHasUiBearingRecipeAccess.mockResolvedValue(true)

    const response = await issue({
      scopes: ['sandbox:ui:view'],
      hostRefs: [SANDBOX_UI_RPC_HOST_REF],
    }).expect(200)

    expect(response.body).toMatchObject({
      accessScope: 'user',
      teamId: null,
      scopes: ['sandbox:ui:view'],
      hostRefs: [SANDBOX_UI_RPC_HOST_REF],
    })
    expect(sandboxUi.userHasUiBearingRecipeAccess).toHaveBeenCalledWith(
      'u1',
      expect.anything(),
      expect.anything(),
      null
    )
  })

  it('atomically denies mixed direct and unavailable team HostRefs', async () => {
    directory.getUserAgents.mockResolvedValue({ userId: 'u1', agentNames: ['direct-agent'] })

    await issue({
      scopes: ['host:message:invoke'],
      hostRefs: ['direct-agent', 'team-agent'],
    })
      .expect(403)
      .expect({ error: 'team_membership_inactive' })
  })

  it('does not authorize a team path when membership authority is unavailable', async () => {
    directory.authorizeLiveTeamMembership.mockResolvedValue({
      status: 'unavailable',
      code: 'team_authorization_unavailable',
    })

    await issue({ scopes: ['host:message:invoke'], hostRefs: ['team-agent'] })
      .expect(503)
      .expect({ error: 'team_authorization_unavailable' })

    expect(directory.getTeamAgents).not.toHaveBeenCalled()
  })
})
