import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { externalRestPublicErrorHandler } from '../src/app.js'
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
  value.use(externalRestPublicErrorHandler)
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
      clientVersion: '2.1.0',
      accessPathId: `ap1_${'a'.repeat(43)}`,
      authorizationRevision: `ar1_${'b'.repeat(43)}`,
    })
  })

  // M-10: this route forwards Control API errors through next(error) to the edge's
  // public error handler, which relays Control API's own status and body. The
  // edge allowlist this route used to apply is gone; Control API's handler is
  // the only filter.
  it.each([400, 403, 404, 409, 429, 503])(
    'forwards the Control API %s status and body unchanged',
    async status => {
      const body = {
        error: {
          code: status === 409 ? 'access_path_required' : 'forbidden',
          message: 'Choose an access path for this operation.',
          correlationId: 'corr-1',
          retryable: status === 503,
          ...(status === 409 ? { details: { paths: [{ id: 'ap1_x', kind: 'direct' }] } } : {}),
        },
      }
      service.issueRpcDelegationV2.mockRejectedValue(
        new ControlApiError('POST /external/rpc/delegations failed', status, body)
      )

      const response = await request(app())
        .post('/rpc/delegations')
        .set('authorization', 'Bearer session-v2')
        .send({})

      expect(service.issueRpcDelegationV2).toHaveBeenCalledTimes(1)
      expect(response.status).toBe(status)
      expect(response.body).toEqual(body)
    }
  )

  it('answers a failure that is not a Control API response with the public 500 envelope', async () => {
    service.issueRpcDelegationV2.mockRejectedValue(
      new Error('connect ECONNREFUSED control-api.internal:8080/external/rpc/delegations')
    )

    const response = await request(app())
      .post('/rpc/delegations')
      .set('authorization', 'Bearer session-v2')
      .send({})

    expect(service.issueRpcDelegationV2).toHaveBeenCalledTimes(1)
    expect(response.status).toBe(500)
    expect(response.body.error).toMatchObject({ code: 'internal_error', retryable: false })
    expect(JSON.stringify(response.body)).not.toContain('control-api.internal')
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
