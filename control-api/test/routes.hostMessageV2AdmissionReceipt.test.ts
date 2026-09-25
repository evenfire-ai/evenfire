import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { canonicalActionTarget, hashActionTarget } from '@clerum/action-context-contracts'
import { createRpcAccessUsersRouter } from '../src/routes/rpc-access/users.js'
import { canonicalEnvironmentId } from '../src/services/access/operationalAccessProjection.js'
import { canonicalResourceIdentity } from '../src/services/access/resourceIdentity.js'
import { signRpcAccessToken, verifyRpcAccessToken } from '../src/utils/auth/rpcAuthToken.js'
import { verifyUserDelegationV2 } from '../src/utils/auth/userDelegationV2Token.js'

const admission = vi.hoisted(() => ({ checkAndIncrement: vi.fn() }))
const checkpoint = vi.hoisted(() => ({ checkpointActionAuthority: vi.fn() }))
const directory = vi.hoisted(() => ({
  getUserAgents: vi.fn(),
  getCurrentTeam: vi.fn(),
  getTeamAgents: vi.fn(),
  getUserContexts: vi.fn(),
}))

vi.mock('../src/services/rateLimiterService.js', () => admission)
vi.mock('../src/services/directory/index.js', () => directory)
vi.mock('../src/services/access/actionAuthorityCheckpoint.js', async importOriginal => ({
  ...(await importOriginal<object>()),
  checkpointActionAuthority: checkpoint.checkpointActionAuthority,
}))
vi.mock('../src/middleware/actionCheckpointCaller.js', () => ({
  requireActionCheckpointCaller: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction
  ) => {
    req.actionCheckpointCaller = {
      service: req.header('x-test-checkpoint-caller') === 'mcp-host' ? 'mcp-host' : 'rpc-proxy',
      trustPlane: 'internal_service_token',
    }
    next()
  },
}))

const { createInternalActionAuthorityCheckpointRouter } =
  await import('../src/routes/internal/actionAuthorityCheckpoint.js')

const SUBJECT = '10000000-0000-4000-8000-000000000001'
const resource = canonicalResourceIdentity({
  environmentId: canonicalEnvironmentId(),
  type: 'host',
  logicalId: 'default/chatllm',
})

function checkpointRequest(
  operationId: 'chat.message.invoke' | 'host.status.read',
  index: number,
  receipt?: string,
  nonceIndex = index
) {
  const target = canonicalActionTarget(
    operationId === 'chat.message.invoke'
      ? {
          hostRef: 'default/chatllm',
          channelType: 'rpc',
          channelId: 'chatllm',
          messageId: `40000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        }
      : { hostRef: 'default/chatllm' }
  )
  const targetHash = hashActionTarget(target)
  return {
    version: 2,
    principal: {
      sub: SUBJECT,
      sid: '20000000-0000-4000-8000-000000000002',
      sessionVersion: 1,
    },
    delegationJti: '30000000-0000-4000-8000-000000000003',
    resource,
    operationId,
    target,
    targetHash,
    accessPathId: `ap1_${'a'.repeat(43)}`,
    authorizationRevision: `ar1_${'b'.repeat(43)}`,
    behaviorBindingHash: `bh2_${'c'.repeat(43)}`,
    ...(operationId === 'chat.message.invoke'
      ? {
          hostMessageAdmission: {
            sendNonce: String(nonceIndex).padStart(43, '0'),
            delegationExpiresAt: Math.floor(Date.now() / 1000) + 120,
            ...(receipt ? { receipt } : {}),
          },
        }
      : {}),
    domain: { service: 'rpc-proxy', resource, targetHash },
  }
}

function app() {
  const server = express()
  server.use(express.json())
  server.use(
    createRpcAccessUsersRouter(
      {
        listResource: vi.fn(async () => [
          { metadata: { name: 'chatllm' }, spec: { enabled: true } },
        ]),
      } as never,
      { bindingService: { bind: vi.fn(async () => ({ status: 'created' })) } }
    )
  )
  server.use(createInternalActionAuthorityCheckpointRouter({} as never))
  return server
}

describe('Spec 62 v2 Host-message admission and retry receipt', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    directory.getUserAgents.mockResolvedValue({ userId: SUBJECT, agentNames: ['chatllm'] })
    directory.getCurrentTeam.mockResolvedValue({ id: 'team-a', role: 'member' })
    directory.getTeamAgents.mockResolvedValue({ agentNames: ['chatllm'] })
    const counts = new Map<string, number>()
    admission.checkAndIncrement.mockImplementation(async (key: string, max: number) => {
      const count = (counts.get(key) ?? 0) + 1
      counts.set(key, count)
      return {
        allowed: count <= max,
        remaining: Math.max(0, max - count),
        resetMs: Date.now() + 30_000,
        count,
        backendAvailable: true,
      }
    })
    checkpoint.checkpointActionAuthority.mockResolvedValue({ status: 'allowed' })
  })

  it('charges each valid chat.message.invoke checkpoint on the shared subject bucket', async () => {
    const server = app()
    for (let index = 1; index <= 60; index += 1) {
      await request(server)
        .post('/internal/action-authority/checkpoint')
        .send(checkpointRequest('chat.message.invoke', index))
        .expect(200)
    }
    expect(admission.checkAndIncrement).toHaveBeenCalledTimes(60)
    expect(new Set(admission.checkAndIncrement.mock.calls.map(call => call[0]))).toEqual(
      new Set([`host-message-admission:${SUBJECT}`])
    )
    const protectedCalls = checkpoint.checkpointActionAuthority.mock.calls.length
    const denied = await request(server)
      .post('/internal/action-authority/checkpoint')
      .send(checkpointRequest('chat.message.invoke', 61))
      .expect(429)
    expect(denied.body.error).toBe('Too Many Requests')
    expect(checkpoint.checkpointActionAuthority).toHaveBeenCalledTimes(protectedCalls)
  })

  it('reuses a same-send receipt for live reauthorization without a second charge', async () => {
    const server = app()
    const sent = checkpointRequest('chat.message.invoke', 9)
    const first = await request(server)
      .post('/internal/action-authority/checkpoint')
      .send(sent)
      .expect(200)
    const receipt = first.body.hostMessageAdmissionReceipt as string
    expect(receipt).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
    expect(admission.checkAndIncrement).toHaveBeenCalledOnce()
    expect(checkpoint.checkpointActionAuthority).toHaveBeenCalledOnce()

    await request(server)
      .post('/internal/action-authority/checkpoint')
      .send({
        ...sent,
        hostMessageAdmission: { ...sent.hostMessageAdmission, receipt },
      })
      .expect(200)
    expect(admission.checkAndIncrement).toHaveBeenCalledOnce()
    expect(checkpoint.checkpointActionAuthority).toHaveBeenCalledTimes(2)

    await request(server)
      .post('/internal/action-authority/checkpoint')
      .send(checkpointRequest('chat.message.invoke', 9, undefined, 10))
      .expect(200)
    expect(admission.checkAndIncrement).toHaveBeenCalledTimes(2)
  })

  it('rejects forged or rebound receipts before admission and live authority', async () => {
    const server = app()
    const sent = checkpointRequest('chat.message.invoke', 11)
    const first = await request(server)
      .post('/internal/action-authority/checkpoint')
      .send(sent)
      .expect(200)
    const receipt = first.body.hostMessageAdmissionReceipt as string
    expect(admission.checkAndIncrement).toHaveBeenCalledOnce()
    const variants = [
      { ...sent, hostMessageAdmission: { ...sent.hostMessageAdmission, receipt: `${receipt}x` } },
      {
        ...sent,
        hostMessageAdmission: {
          ...sent.hostMessageAdmission,
          sendNonce: `m${'n'.repeat(42)}`,
          receipt,
        },
      },
      {
        ...sent,
        principal: { ...sent.principal, sid: '20000000-0000-4000-8000-000000000099' },
        hostMessageAdmission: { ...sent.hostMessageAdmission, receipt },
      },
      {
        ...sent,
        principal: { ...sent.principal, sub: '10000000-0000-4000-8000-000000000099' },
        hostMessageAdmission: { ...sent.hostMessageAdmission, receipt },
      },
      {
        ...sent,
        principal: { ...sent.principal, sessionVersion: sent.principal.sessionVersion + 1 },
        hostMessageAdmission: { ...sent.hostMessageAdmission, receipt },
      },
      {
        ...sent,
        delegationJti: '30000000-0000-4000-8000-000000000099',
        hostMessageAdmission: { ...sent.hostMessageAdmission, receipt },
      },
      {
        ...sent,
        resource: canonicalResourceIdentity({
          environmentId: canonicalEnvironmentId(),
          type: 'host',
          logicalId: 'default/other',
        }),
        hostMessageAdmission: { ...sent.hostMessageAdmission, receipt },
      },
      {
        ...sent,
        target: canonicalActionTarget({
          hostRef: 'default/chatllm',
          channelType: 'rpc',
          channelId: 'chatllm',
          messageId: '40000000-0000-4000-8000-000000000099',
        }),
        hostMessageAdmission: { ...sent.hostMessageAdmission, receipt },
      },
      {
        ...sent,
        accessPathId: `ap1_${'z'.repeat(43)}`,
        hostMessageAdmission: { ...sent.hostMessageAdmission, receipt },
      },
      {
        ...sent,
        authorizationRevision: `ar1_${'z'.repeat(43)}`,
        hostMessageAdmission: { ...sent.hostMessageAdmission, receipt },
      },
      {
        ...sent,
        behaviorBindingHash: `bh2_${'z'.repeat(43)}`,
        hostMessageAdmission: { ...sent.hostMessageAdmission, receipt },
      },
    ].map(value => {
      const targetHash = hashActionTarget(value.target)
      return {
        ...value,
        targetHash,
        domain: { ...value.domain, resource: value.resource, targetHash },
      }
    })
    for (const variant of variants) {
      await request(server)
        .post('/internal/action-authority/checkpoint')
        .send(variant)
        .expect(400, { version: 2, status: 'invalid_binding', code: 'invalid_binding' })
    }
    expect(admission.checkAndIncrement).toHaveBeenCalledOnce()
    expect(checkpoint.checkpointActionAuthority).toHaveBeenCalledOnce()
  })

  it('rechecks live authorization after receipt validation and keeps denial terminal', async () => {
    const server = app()
    const sent = checkpointRequest('chat.message.invoke', 12)
    const first = await request(server)
      .post('/internal/action-authority/checkpoint')
      .send(sent)
      .expect(200)
    const receipt = first.body.hostMessageAdmissionReceipt as string
    checkpoint.checkpointActionAuthority.mockResolvedValue({
      version: 2,
      status: 'denied',
      code: 'forbidden',
    })
    await request(server)
      .post('/internal/action-authority/checkpoint')
      .send({ ...sent, hostMessageAdmission: { ...sent.hostMessageAdmission, receipt } })
      .expect(403)
    expect(admission.checkAndIncrement).toHaveBeenCalledOnce()
    expect(checkpoint.checkpointActionAuthority).toHaveBeenCalledTimes(2)
  })

  it('charges before live authorization and fails closed when admission storage is unavailable', async () => {
    const server = app()
    checkpoint.checkpointActionAuthority.mockResolvedValue({
      version: 2,
      status: 'denied',
      code: 'forbidden',
    })
    await request(server)
      .post('/internal/action-authority/checkpoint')
      .send(checkpointRequest('chat.message.invoke', 16))
      .expect(403)
    expect(admission.checkAndIncrement).toHaveBeenCalledOnce()
    expect(checkpoint.checkpointActionAuthority).toHaveBeenCalledOnce()

    vi.clearAllMocks()
    admission.checkAndIncrement.mockResolvedValue(undefined)
    const unavailable = await request(server)
      .post('/internal/action-authority/checkpoint')
      .send(checkpointRequest('chat.message.invoke', 17))
      .expect(503)
    expect(unavailable.body).toEqual({ error: 'host_message_admission_unavailable' })
    expect(checkpoint.checkpointActionAuthority).not.toHaveBeenCalled()
  })

  it('uses the same subject counter as both legacy message forms and never leaks a credential', async () => {
    const server = app()
    const token = signRpcAccessToken({
      sub: SUBJECT,
      typ: 'user',
      teamId: 'team-a',
      role: 'member',
      scopes: ['host:message:invoke'],
      hostRefs: ['chatllm'],
      jti: 'legacy-message-admission-test',
    })
    for (let index = 1; index <= 30; index += 1) {
      await request(server)
        .post(`/rpc/access/users/${SUBJECT}/mcp-hosts/chatllm/message-resolution`)
        .set('x-rpc-access-token', token)
        .send({})
        .expect(200)
      await request(server)
        .post('/internal/action-authority/checkpoint')
        .send(checkpointRequest('chat.message.invoke', index))
        .expect(200)
    }
    expect(admission.checkAndIncrement).toHaveBeenCalledTimes(60)
    expect(new Set(admission.checkAndIncrement.mock.calls.map(call => call[0]))).toEqual(
      new Set([`host-message-admission:${SUBJECT}`])
    )
    const receipt = await request(server)
      .post('/internal/action-authority/checkpoint')
      .send(checkpointRequest('chat.message.invoke', 31))
      .expect(429)
    expect(receipt.body).toEqual({
      error: 'Too Many Requests',
      retryAfterSeconds: expect.any(Number),
    })
    expect(receipt.headers['retry-after']).toBeTruthy()
    expect(receipt.headers['x-ratelimit-limit']).toBe('60')
    expect(receipt.headers['x-ratelimit-remaining']).toBe('0')
    expect(receipt.headers['x-ratelimit-reset']).toBeTruthy()
  })

  it('keeps receipts isolated from existing RPC and delegation credential verifiers', async () => {
    const response = await request(app())
      .post('/internal/action-authority/checkpoint')
      .send(checkpointRequest('chat.message.invoke', 14))
      .expect(200)
    const receipt = response.body.hostMessageAdmissionReceipt as string
    expect(verifyRpcAccessToken(receipt)).toBeNull()
    expect(verifyUserDelegationV2(receipt)).toBeNull()
    expect(receipt).not.toContain('sendNonce')
  })

  it('rejects a non-authoritative checkpoint caller before admission', async () => {
    await request(app())
      .post('/internal/action-authority/checkpoint')
      .set('x-test-checkpoint-caller', 'mcp-host')
      .send(checkpointRequest('chat.message.invoke', 15))
      .expect(400)
    expect(admission.checkAndIncrement).not.toHaveBeenCalled()
    expect(checkpoint.checkpointActionAuthority).not.toHaveBeenCalled()
  })

  it('rejects exact v2 binding substitution before charging admission', async () => {
    const valid = checkpointRequest('chat.message.invoke', 18)
    const invalid = { ...valid, target: { ...valid.target, hostRef: 'default/other' } }
    await request(app()).post('/internal/action-authority/checkpoint').send(invalid).expect(400)
    expect(admission.checkAndIncrement).not.toHaveBeenCalled()
    expect(checkpoint.checkpointActionAuthority).not.toHaveBeenCalled()
  })

  it('does not charge unrelated action-authority checkpoint operations', async () => {
    await request(app())
      .post('/internal/action-authority/checkpoint')
      .send(checkpointRequest('host.status.read', 1))
      .expect(200)
    expect(admission.checkAndIncrement).not.toHaveBeenCalled()
  })
})
