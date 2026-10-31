import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createMessageRetryHostWakeRequest } from '@clerum/action-context-contracts'

const checkpoint = vi.hoisted(() => ({
  parseActionAuthorityCheckpointRequest: vi.fn(),
  checkpointActionAuthority: vi.fn(),
}))
const wake = vi.hoisted(() => ({ executeHostWake: vi.fn() }))

vi.mock('../src/services/access/actionAuthorityCheckpoint.js', () => checkpoint)
vi.mock('../src/services/hostWakeAction.js', () => wake)
vi.mock('../src/middleware/actionCheckpointCaller.js', () => ({
  requireActionCheckpointCaller: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction
  ) => {
    req.actionCheckpointCaller = {
      service: 'rpc-proxy',
      trustPlane: 'internal_service_token',
    }
    next()
  },
}))
vi.mock('../src/middleware/rateLimitMiddleware.js', () => ({
  rateLimitMiddleware:
    () => (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
      next(),
}))

const { createInternalActionAuthorityHostWakeRouter } =
  await import('../src/routes/internal/actionAuthorityHostWake.js')

const resource = {
  environmentId: 'development:local',
  type: 'host',
  canonicalId: 'host:mcp-host/chatllm',
  logicalId: 'mcp-host/chatllm',
  displayName: 'chatllm',
}

function parsed(operationId: 'host.wake' | 'chat.message.invoke') {
  return {
    version: 2,
    principal: {
      sub: '10000000-0000-4000-8000-000000000001',
      sid: '20000000-0000-4000-8000-000000000002',
      sessionVersion: 1,
    },
    delegationJti: '30000000-0000-4000-8000-000000000003',
    resource,
    operationId,
    target:
      operationId === 'host.wake'
        ? { hostRef: 'mcp-host/chatllm', wakeReason: 'explicit' }
        : {
            hostRef: 'mcp-host/chatllm',
            channelType: 'rpc',
            channelId: 'chatllm',
            messageId: '40000000-0000-4000-8000-000000000004',
          },
    targetHash: `ath2_${'a'.repeat(43)}`,
    accessPathId: `ap1_${'b'.repeat(43)}`,
    authorizationRevision: `ar1_${'c'.repeat(43)}`,
    behaviorBindingHash: `bh2_${'d'.repeat(43)}`,
    domain: { service: 'rpc-proxy', resource, targetHash: `ath2_${'a'.repeat(43)}` },
  }
}

function app() {
  const value = express()
  value.use(express.json())
  value.use(createInternalActionAuthorityHostWakeRouter({} as never))
  return value
}

describe('v2 host wake adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects a chat delegation without widening it into host.wake authority', async () => {
    checkpoint.parseActionAuthorityCheckpointRequest.mockReturnValue(parsed('chat.message.invoke'))

    const response = await request(app())
      .post('/internal/action-authority/hosts/chatllm/wake')
      .send({ binding: {}, wakeReason: 'message_retry' })
      .expect(403)

    expect(response.body).toEqual({
      version: 2,
      status: 'denied',
      code: 'wake_delegation_required',
    })
    expect(checkpoint.checkpointActionAuthority).not.toHaveBeenCalled()
    expect(wake.executeHostWake).not.toHaveBeenCalled()
  })

  it('derives same-host message_retry wake authority from an exact message binding', async () => {
    const source = parsed('chat.message.invoke')
    checkpoint.parseActionAuthorityCheckpointRequest.mockReturnValue(source)
    checkpoint.checkpointActionAuthority.mockResolvedValue({
      version: 2,
      status: 'allowed',
      destination: {
        kind: 'host',
        ref: 'mcp-host/chatllm',
        url: 'http://chatllm.mcp-host.svc.cluster.local:8080',
      },
    })
    wake.executeHostWake.mockResolvedValue({ kind: 'wake-requested', wakeGeneration: 10 })

    const response = await request(app())
      .post('/internal/action-authority/hosts/chatllm/wake')
      .send(createMessageRetryHostWakeRequest(source as never))
      .expect(202)

    expect(response.body).toEqual({ status: 'wake-requested', wakeGeneration: 10 })
    expect(checkpoint.parseActionAuthorityCheckpointRequest).toHaveBeenCalledWith(
      source,
      expect.objectContaining({ service: 'rpc-proxy' }),
      { hostMessageAdmission: 'forbidden' }
    )
    expect(checkpoint.checkpointActionAuthority).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          operationId: 'host.wake',
          target: { hostRef: 'mcp-host/chatllm', wakeReason: 'message_retry' },
        }),
      })
    )
    expect(wake.executeHostWake).toHaveBeenCalledOnce()
  })

  it.each([
    ['different route Host', 'other-host', 'message_retry'],
    ['different wake reason', 'chatllm', 'explicit'],
  ])(
    'rejects derived wake with %s before authorization or effects',
    async (_label, host, reason) => {
      const source = parsed('chat.message.invoke')
      source.target.hostRef = `mcp-host/${host}`
      checkpoint.parseActionAuthorityCheckpointRequest.mockReturnValue(source)

      await request(app())
        .post('/internal/action-authority/hosts/chatllm/wake')
        .send({ sourceBinding: source, wakeReason: reason })
        .expect(400)

      expect(checkpoint.checkpointActionAuthority).not.toHaveBeenCalled()
      expect(wake.executeHostWake).not.toHaveBeenCalled()
    }
  )

  it('rechecks derived wake authority on every call and does not charge message admission', async () => {
    const source = parsed('chat.message.invoke')
    checkpoint.parseActionAuthorityCheckpointRequest.mockReturnValue(source)
    checkpoint.checkpointActionAuthority
      .mockResolvedValueOnce({
        version: 2,
        status: 'allowed',
        destination: {
          kind: 'host',
          ref: 'mcp-host/chatllm',
          url: 'http://chatllm.mcp-host.svc.cluster.local:8080',
        },
      })
      .mockResolvedValue({
        version: 2,
        status: 'denied',
        code: 'forbidden',
      })

    await request(app())
      .post('/internal/action-authority/hosts/chatllm/wake')
      .send(createMessageRetryHostWakeRequest(source as never))
      .expect(202)
    await request(app())
      .post('/internal/action-authority/hosts/chatllm/wake')
      .send(createMessageRetryHostWakeRequest(source as never))
      .expect(403)

    expect(checkpoint.checkpointActionAuthority).toHaveBeenCalledTimes(2)
    expect(checkpoint.checkpointActionAuthority).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        request: expect.objectContaining({
          operationId: 'host.wake',
          target: { hostRef: 'mcp-host/chatllm', wakeReason: 'message_retry' },
        }),
      })
    )
    expect(wake.executeHostWake).toHaveBeenCalledOnce()
  })

  it('recheckpoints an exact host.wake binding immediately before mutation', async () => {
    checkpoint.parseActionAuthorityCheckpointRequest.mockReturnValue(parsed('host.wake'))
    checkpoint.checkpointActionAuthority.mockResolvedValue({
      version: 2,
      status: 'allowed',
      destination: {
        kind: 'host',
        ref: 'mcp-host/chatllm',
        url: 'http://chatllm.mcp-host.svc.cluster.local:8080',
      },
    })
    wake.executeHostWake.mockResolvedValue({ kind: 'wake-requested', wakeGeneration: 9 })

    const response = await request(app())
      .post('/internal/action-authority/hosts/chatllm/wake')
      .send({ binding: {}, wakeReason: 'explicit' })
      .expect(202)

    expect(response.body).toEqual({ status: 'wake-requested', wakeGeneration: 9 })
    expect(checkpoint.checkpointActionAuthority).toHaveBeenCalledTimes(1)
    expect(wake.executeHostWake).toHaveBeenCalledWith(expect.anything(), 'chatllm')
    expect(checkpoint.checkpointActionAuthority.mock.invocationCallOrder[0]).toBeLessThan(
      wake.executeHostWake.mock.invocationCallOrder[0]
    )
  })

  it('fails closed on stale authority without touching the wake mutation', async () => {
    checkpoint.parseActionAuthorityCheckpointRequest.mockReturnValue(parsed('host.wake'))
    checkpoint.checkpointActionAuthority.mockResolvedValue({
      version: 2,
      status: 'access_path_stale',
      code: 'access_path_stale',
      currentAuthorizationRevision: `ar1_${'e'.repeat(43)}`,
    })

    await request(app())
      .post('/internal/action-authority/hosts/chatllm/wake')
      .send({ binding: {}, wakeReason: 'explicit' })
      .expect(409)

    expect(wake.executeHostWake).not.toHaveBeenCalled()
  })
})
