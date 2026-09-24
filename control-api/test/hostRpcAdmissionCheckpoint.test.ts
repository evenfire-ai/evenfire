import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import type { ActionOperationId } from '@clerum/action-context-contracts'
import { actionAuthorityCheckpointRequest } from '../../rpc-proxy/src/actionAuthorityV2.js'
import { config as rpcProxyConfig } from '../../rpc-proxy/src/config.js'
import { bindRouteActionV2 } from '../../rpc-proxy/src/routeActionBindingV2.js'
import { config } from '../src/config.js'
import { createRpcAccessUsersRouter } from '../src/routes/rpc-access/users.js'
import { prepareActionOperationTarget } from '../src/services/access/actionMessageId.js'
import { canonicalResourceIdentity } from '../src/services/access/resourceIdentity.js'
import { signRpcAccessToken } from '../src/utils/auth/rpcAuthToken.js'
import {
  issueUserDelegationV2,
  verifyUserDelegationV2,
} from '../src/utils/auth/userDelegationV2Token.js'

const admission = vi.hoisted(() => ({ checkAndIncrement: vi.fn() }))
const checkpoint = vi.hoisted(() => ({ checkpointActionAuthority: vi.fn() }))

vi.mock('../src/services/rateLimiterService.js', () => ({
  checkAndIncrement: admission.checkAndIncrement,
  checkAndIncrementStrict: admission.checkAndIncrement,
}))
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
      service: 'rpc-proxy',
      trustPlane: 'internal_service_token',
    }
    next()
  },
}))

const { createInternalActionAuthorityCheckpointRouter } =
  await import('../src/routes/internal/actionAuthorityCheckpoint.js')

const SUBJECT = '10000000-0000-4000-8000-000000000001'
const SID = '20000000-0000-4000-8000-000000000002'
const TASK_ID = '40000000-0000-4000-8000-000000000001'
const APPROVAL_ID = '40000000-0000-4000-8000-000000000002'
const CHAT_ID = '40000000-0000-4000-8000-000000000003'
const HOST_REF = `${rpcProxyConfig.hostNamespace}/chatllm`
const HOST_RESOURCE = canonicalResourceIdentity({
  environmentId: 'development:local',
  type: 'host',
  logicalId: HOST_REF,
})

type ProducerRoute = Readonly<{
  operationId: ActionOperationId
  resourceType: 'host' | 'runtime_session'
  path: string
  method: string
  params?: Record<string, string>
  query?: Record<string, string>
  body?: Record<string, unknown>
  target: Record<string, string>
}>

const IN_SCOPE_ROUTES: readonly ProducerRoute[] = [
  {
    operationId: 'host.wake',
    resourceType: 'host',
    path: '/rpc/hosts/:hostRef/wake',
    method: 'POST',
    body: { wakeReason: 'explicit' },
    target: { hostRef: HOST_REF, wakeReason: 'explicit' },
  },
  {
    operationId: 'task.manage',
    resourceType: 'runtime_session',
    path: '/rpc/hosts/:hostRef/approvals/approve',
    method: 'POST',
    body: { taskId: TASK_ID, toolCallId: APPROVAL_ID },
    target: {
      hostRef: HOST_REF,
      taskId: TASK_ID,
      action: 'approve',
      approvalRequestId: APPROVAL_ID,
    },
  },
  {
    operationId: 'task.manage',
    resourceType: 'runtime_session',
    path: '/rpc/hosts/:hostRef/tasks/:taskId/cancel',
    method: 'POST',
    params: { hostRef: 'chatllm', taskId: TASK_ID },
    target: { hostRef: HOST_REF, taskId: TASK_ID, action: 'cancel' },
  },
  {
    operationId: 'task.read',
    resourceType: 'runtime_session',
    path: '/rpc/hosts/:hostRef/tasks/:taskId/result',
    method: 'GET',
    params: { hostRef: 'chatllm', taskId: TASK_ID },
    target: { hostRef: HOST_REF, taskId: TASK_ID },
  },
  {
    operationId: 'session.read',
    resourceType: 'runtime_session',
    path: '/rpc/hosts/:hostRef/sessions/search',
    method: 'GET',
    params: { hostRef: 'chatllm' },
    query: { q: 'latest' },
    target: { hostRef: HOST_REF },
  },
  {
    operationId: 'session.manage',
    resourceType: 'runtime_session',
    path: '/rpc/hosts/:hostRef/sessions/:agent/:chatId/name',
    method: 'PATCH',
    params: { hostRef: 'chatllm', agent: 'chatllm', chatId: CHAT_ID },
    body: { name: 'Renamed' },
    target: { hostRef: HOST_REF, agent: 'chatllm', chatId: CHAT_ID, action: 'rename' },
  },
  {
    operationId: 'model.read',
    resourceType: 'runtime_session',
    path: '/rpc/hosts/:hostRef/models',
    method: 'GET',
    params: { hostRef: 'chatllm' },
    query: { agent: 'chatllm', chatId: CHAT_ID },
    target: { hostRef: HOST_REF, agent: 'chatllm', chatId: CHAT_ID },
  },
  {
    operationId: 'model.select',
    resourceType: 'runtime_session',
    path: '/rpc/hosts/:hostRef/model',
    method: 'POST',
    params: { hostRef: 'chatllm' },
    body: { agent: 'chatllm', chatId: CHAT_ID, provider: 'openai', model: 'model-a' },
    target: {
      hostRef: HOST_REF,
      agent: 'chatllm',
      chatId: CHAT_ID,
      provider: 'openai',
      model: 'model-a',
    },
  },
  {
    operationId: 'host.activity.read',
    resourceType: 'host',
    path: '/rpc/hosts/:hostRef/activity',
    method: 'GET',
    params: { hostRef: 'chatllm' },
    target: { hostRef: HOST_REF, visibility: 'caller_path' },
  },
  {
    operationId: 'host.activity.read_all',
    resourceType: 'host',
    path: '/rpc/hosts/:hostRef/activity',
    method: 'GET',
    params: { hostRef: 'chatllm' },
    query: { visibility: 'host_all' },
    target: { hostRef: HOST_REF, visibility: 'host_all' },
  },
  {
    operationId: 'host.status.read',
    resourceType: 'host',
    path: '/rpc/hosts/:hostRef/status/stream',
    method: 'GET',
    params: { hostRef: 'chatllm' },
    target: { hostRef: HOST_REF },
  },
  {
    operationId: 'host.health.read',
    resourceType: 'host',
    path: '/rpc/hosts/:hostRef/health',
    method: 'GET',
    params: { hostRef: 'chatllm' },
    target: { hostRef: HOST_REF },
  },
]

function checkpointFor(route: ProducerRoute) {
  const resource =
    route.resourceType === 'host'
      ? HOST_RESOURCE
      : canonicalResourceIdentity({
          environmentId: 'development:local',
          type: 'runtime_session',
          logicalId: 'chatllm/session-a',
        })
  const prepared = prepareActionOperationTarget({
    operationId: route.operationId,
    resource,
    operationTarget: route.target,
  })
  const token = issueUserDelegationV2({
    principal: { userId: SUBJECT, sid: SID, sessionVersion: 1 },
    operationIds: [route.operationId],
    resource,
    preparedTargets: { [route.operationId]: prepared },
    accessPathId: `ap1_${'a'.repeat(43)}`,
    authorizationRevision: `ar1_${'b'.repeat(43)}`,
    behaviorBindingHash: `bh2_${'c'.repeat(43)}`,
    pathKind: 'direct',
    effectiveTeamId: null,
  })
  const claims = verifyUserDelegationV2(token)
  if (!claims) throw new Error('producer delegation failed verification')
  const bound = bindRouteActionV2(
    {
      route: { path: route.path },
      method: route.method,
      params: route.params ?? { hostRef: 'chatllm' },
      query: route.query ?? {},
      body: route.body,
      userDelegationV2: claims,
    } as never,
    claims
  )
  return actionAuthorityCheckpointRequest(claims, bound)
}

function app() {
  const server = express()
  server.use(express.json())
  server.use(
    createRpcAccessUsersRouter({ listResource: vi.fn(async () => []) } as never, {
      bindingService: { bind: vi.fn(async () => ({ status: 'created' })) },
    })
  )
  server.use(createInternalActionAuthorityCheckpointRouter({} as never))
  return server
}

describe('Spec 65 v2 Host-RPC admission checkpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    admission.checkAndIncrement.mockImplementation(async (_key: string, limit: number) => ({
      allowed: true,
      remaining: limit - 1,
      resetMs: Date.now() + 30_000,
      windowStartMs: Date.now(),
      count: 1,
      backendAvailable: true,
    }))
    checkpoint.checkpointActionAuthority.mockResolvedValue({ status: 'allowed' })
  })

  it('charges every approved non-message operation through one subject bucket', async () => {
    const server = app()
    for (const route of IN_SCOPE_ROUTES) {
      await request(server)
        .post('/internal/action-authority/checkpoint')
        .send(checkpointFor(route))
        .expect(200)
    }
    expect(admission.checkAndIncrement).toHaveBeenCalledTimes(IN_SCOPE_ROUTES.length)
    expect(new Set(admission.checkAndIncrement.mock.calls.map(call => call[0]))).toEqual(
      new Set([`host-rpc-admission:${SUBJECT}`])
    )
  })

  it('rejects request N+1 before the live checkpoint using the configured test ceiling', async () => {
    const admissionConfig = config as typeof config & { hostRpcAdmissionRlPerMin: number }
    const originalLimit = admissionConfig.hostRpcAdmissionRlPerMin
    admissionConfig.hostRpcAdmissionRlPerMin = 3
    const counts = new Map<string, number>()
    admission.checkAndIncrement.mockImplementation(async (key: string, limit: number) => {
      const count = (counts.get(key) ?? 0) + 1
      counts.set(key, count)
      return {
        allowed: count <= limit,
        remaining: Math.max(0, limit - count),
        resetMs: Date.now() + 30_000,
        windowStartMs: Date.now(),
        count,
        backendAvailable: true,
      }
    })
    const server = app()
    try {
      const route = IN_SCOPE_ROUTES.find(entry => entry.operationId === 'host.wake')!
      for (let index = 0; index < 3; index += 1) {
        await request(server)
          .post('/internal/action-authority/checkpoint')
          .send(checkpointFor(route))
          .expect(200)
      }
      const liveCalls = checkpoint.checkpointActionAuthority.mock.calls.length
      const denied = await request(server)
        .post('/internal/action-authority/checkpoint')
        .send(checkpointFor(route))
        .expect(429)
      expect(denied.headers['retry-after']).toMatch(/^\d+$/)
      expect(denied.headers['x-ratelimit-limit']).toBe('3')
      expect(denied.headers['x-ratelimit-remaining']).toBe('0')
      expect(denied.headers['x-ratelimit-reset']).toMatch(/^\d+$/)
      expect(denied.body).toEqual({
        error: 'Too Many Requests',
        retryAfterSeconds: expect.any(Number),
      })
      expect(checkpoint.checkpointActionAuthority).toHaveBeenCalledTimes(liveCalls)
    } finally {
      if (originalLimit === undefined) delete admissionConfig.hostRpcAdmissionRlPerMin
      else admissionConfig.hostRpcAdmissionRlPerMin = originalLimit
    }
  })

  it('legacy adapter validates signed identity and charges one subject bucket without selectors', async () => {
    const token = signRpcAccessToken({
      sub: SUBJECT,
      typ: 'user',
      accessScope: 'team',
      teamId: 'team-a',
      scopes: ['host:status:read'],
      hostRefs: [HOST_REF, `${rpcProxyConfig.hostNamespace}/other`],
      jti: 'host-rpc-admission-test-token',
    })
    const server = app()
    await request(server)
      .post(
        `/rpc/access/users/${SUBJECT}/mcp-hosts/${encodeURIComponent(HOST_REF)}/host-rpc-admission`
      )
      .set('x-rpc-access-token', token)
      .expect(204)
    await request(server)
      .post(
        `/rpc/access/users/${SUBJECT}/mcp-hosts/${encodeURIComponent(`${rpcProxyConfig.hostNamespace}/other`)}/host-rpc-admission`
      )
      .set('x-rpc-access-token', token)
      .expect(204)
    expect(admission.checkAndIncrement).toHaveBeenCalledTimes(2)
    expect(admission.checkAndIncrement).toHaveBeenNthCalledWith(
      1,
      `host-rpc-admission:${SUBJECT}`,
      config.hostRpcAdmissionRlPerMin
    )
    expect(admission.checkAndIncrement).toHaveBeenNthCalledWith(
      2,
      `host-rpc-admission:${SUBJECT}`,
      config.hostRpcAdmissionRlPerMin
    )
  })

  it('invalid legacy scope, subject/Host claim, and body consume no admission unit', async () => {
    const token = signRpcAccessToken({
      sub: SUBJECT,
      typ: 'user',
      accessScope: 'team',
      teamId: 'team-a',
      scopes: ['host:status:read'],
      hostRefs: [HOST_REF],
      jti: 'host-rpc-admission-negative-test-token',
    })
    const server = app()
    await request(server)
      .post(
        `/rpc/access/users/${SUBJECT}/mcp-hosts/${encodeURIComponent(HOST_REF)}/host-rpc-admission`
      )
      .set(
        'x-rpc-access-token',
        signRpcAccessToken({
          sub: SUBJECT,
          typ: 'user',
          accessScope: 'team',
          teamId: 'team-a',
          scopes: ['mcp:servers:list'],
          hostRefs: [HOST_REF],
          jti: 'host-rpc-admission-wrong-scope-token',
        })
      )
      .expect(403)
    await request(server)
      .post(
        `/rpc/access/users/10000000-0000-4000-8000-000000000009/mcp-hosts/${encodeURIComponent(HOST_REF)}/host-rpc-admission`
      )
      .set('x-rpc-access-token', token)
      .expect(403)
    await request(server)
      .post(`/rpc/access/users/${SUBJECT}/mcp-hosts/other/host-rpc-admission`)
      .set('x-rpc-access-token', token)
      .expect(403)
    await request(server)
      .post(
        `/rpc/access/users/${SUBJECT}/mcp-hosts/${encodeURIComponent(HOST_REF)}/host-rpc-admission`
      )
      .set('x-rpc-access-token', token)
      .send({ operation: 'client-selected' })
      .expect(400)
    expect(admission.checkAndIncrement).not.toHaveBeenCalled()
  })
})
