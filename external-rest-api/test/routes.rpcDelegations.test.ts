import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { ControlApiError } from '../src/controlApiClient.js'
import { createRpcDelegationsRouter } from '../src/routes/rpcDelegations.js'

const service = vi.hoisted(() => ({ issueRpcDelegationV2: vi.fn() }))
vi.mock('../src/services/rpcDelegationService.js', () => service)

const auth = vi.hoisted(() => ({ verifyToken: vi.fn() }))
vi.mock('../src/authToken.js', () => auth)

function app() {
  const value = express()
  value.use(express.json())
  value.use(createRpcDelegationsRouter())
  return value
}

describe('POST /rpc/delegations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    auth.verifyToken.mockReturnValue({
      userId: '10000000-0000-4000-8000-000000000001',
      email: 'user@example.test',
      teamId: null,
      role: 'member',
      exp: 9_999_999_999,
    })
  })

  it('forwards the opaque request with only trusted session and edge metadata', async () => {
    const body = {
      version: 2,
      operationId: 'chat.message.invoke',
      resource: { type: 'host', logicalId: 'default/chatllm' },
      target: { hostRef: 'default/chatllm', channelType: 'rpc', channelId: 'chat-1' },
    }
    service.issueRpcDelegationV2.mockResolvedValue({
      delegationToken: 'delegation-v2',
      messageId: '10000000-0000-4000-8000-000000000010',
    })

    const response = await request(app())
      .post('/rpc/delegations')
      .set('authorization', 'Bearer session-v2')
      .set('x-evenfire-client-version', '2.1.0')
      .set('x-evenfire-access-path-id', `ap1_${'a'.repeat(43)}`)
      .set('x-evenfire-authorization-revision', `ar1_${'b'.repeat(43)}`)
      .set('x-clerum-edge-action-context', 'spoofed')
      .send(body)

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      delegationToken: 'delegation-v2',
      messageId: '10000000-0000-4000-8000-000000000010',
    })
    expect(service.issueRpcDelegationV2).toHaveBeenCalledWith({
      sessionToken: 'session-v2',
      requestBody: body,
      clientIp: '::ffff:127.0.0.1',
      clientVersion: '2.1.0',
      accessPathId: `ap1_${'a'.repeat(43)}`,
      authorizationRevision: `ar1_${'b'.repeat(43)}`,
    })
  })

  it.each([400, 403, 404, 409, 429, 503])('sanitizes the Control API %s response', async status => {
    service.issueRpcDelegationV2.mockRejectedValue(
      new ControlApiError('internal', status, {
        error: { code: status === 409 ? 'access_path_stale' : 'secret', message: '/secret' },
      })
    )

    const response = await request(app())
      .post('/rpc/delegations')
      .set('authorization', 'Bearer session-v2')
      .send({})

    expect(response.status).toBe(status)
    expect(JSON.stringify(response.body)).not.toContain('/secret')
  })

  it('rejects malformed authority selectors before forwarding', async () => {
    const response = await request(app())
      .post('/rpc/delegations')
      .set('authorization', 'Bearer session-v2')
      .set('x-evenfire-access-path-id', 'team-admin')
      .send({})

    expect(response.status).toBe(400)
    expect(service.issueRpcDelegationV2).not.toHaveBeenCalled()
  })
})
