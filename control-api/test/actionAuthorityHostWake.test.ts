import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

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
