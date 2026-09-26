import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { config } from '../src/config.js'
import { knownBehavior } from '../src/services/access/accessPath.js'
import { prepareActionOperationTarget } from '../src/services/access/actionMessageId.js'
import { canonicalEnvironmentId } from '../src/services/access/operationalAccessProjection.js'
import { canonicalResourceIdentity } from '../src/services/access/resourceIdentity.js'
import { verifyUserDelegationV2 } from '../src/utils/auth/userDelegationV2Token.js'

const mocks = vi.hoisted(() => ({
  verifyV1: vi.fn(),
  verifyV2: vi.fn(),
  validateV1: vi.fn(),
  validateV2: vi.fn(),
  resolvePolicy: vi.fn(),
  authorize: vi.fn(),
}))
const rateLimiter = vi.hoisted(() => ({ checkAndIncrement: vi.fn() }))
const tokenIssuer = vi.hoisted(() => ({ issueUserDelegationV2: vi.fn() }))

vi.mock('../src/utils/auth/externalSessionAuthToken.js', () => ({
  verifyExternalSessionToken: mocks.verifyV1,
}))
vi.mock('../src/utils/auth/userSessionV2Token.js', () => ({
  verifyUserSessionV2Token: mocks.verifyV2,
}))
vi.mock('../src/services/auth/userSessionService.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/services/auth/userSessionService.js')>()
  return {
    ...actual,
    validateLegacyUserSession: mocks.validateV1,
    validateUserSessionClaims: mocks.validateV2,
  }
})
vi.mock('../src/services/access/userAccessRuntimePolicy.js', () => ({
  resolveEffectiveUserAccessPolicy: mocks.resolvePolicy,
}))
vi.mock('../src/services/access/actionAuthorizer.js', () => ({
  authorizeActionV2: mocks.authorize,
}))
vi.mock('../src/services/rateLimiterService.js', () => rateLimiter)
vi.mock('../src/utils/auth/userDelegationV2Token.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/utils/auth/userDelegationV2Token.js')>()
  tokenIssuer.issueUserDelegationV2.mockImplementation(actual.issueUserDelegationV2)
  return { ...actual, issueUserDelegationV2: tokenIssuer.issueUserDelegationV2 }
})

const { createExternalRpcDelegationsRouter } =
  await import('../src/routes/external/rpcDelegations.js')

const userId = '10000000-0000-4000-8000-000000000001'
const sid = '20000000-0000-4000-8000-000000000002'
const resource = canonicalResourceIdentity({
  environmentId: canonicalEnvironmentId(),
  type: 'host',
  logicalId: 'default/chatllm',
})
const prepared = prepareActionOperationTarget({
  operationId: 'chat.message.invoke',
  resource,
  operationTarget: {
    hostRef: 'default/chatllm',
    channelType: 'rpc',
    channelId: 'chat-1',
  },
  allocateMessageId: () => '50000000-0000-4000-8000-000000000005',
})
const accessPathId = `ap1_${'a'.repeat(43)}`
const authorizationRevision = `ar1_${'b'.repeat(43)}`
const behaviorBindingHash = `bh2_${'c'.repeat(43)}`

function app(gateway: Parameters<typeof createExternalRpcDelegationsRouter>[0] = {} as never) {
  const value = express()
  value.use(express.json())
  value.use(createExternalRpcDelegationsRouter(gateway))
  return value
}

describe('POST /external/rpc/delegations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.verifyV2.mockReturnValue({
      typ: 'user_session',
      ver: 2,
      sub: userId,
      sid,
      jti: '30000000-0000-4000-8000-000000000003',
      sv: 1,
      auth_time: 1_900_000_000,
      amr: ['password'],
      iat: 1_900_000_000,
      exp: 2_000_000_000,
    })
    mocks.validateV2.mockResolvedValue({
      status: 'valid',
      identity: {
        userId,
        email: 'user@example.test',
        sid,
        jti: '30000000-0000-4000-8000-000000000003',
        sessionVersion: 1,
      },
    })
    mocks.resolvePolicy.mockResolvedValue({
      acceptV1: true,
      acceptV2: true,
      issueV1: true,
      issueV2: true,
      renewV2: true,
      switchCompatibility: true,
      computeCatalogShadow: false,
      serveCatalog: true,
      actionContextV2: true,
      rpcDelegationV2: true,
      desktopAllTeamMode: false,
      profileV2Mode: false,
      minimumClientVersion: null,
      enforceMinimumClient: false,
      advertisedCatalogFamilies: [],
    })
    rateLimiter.checkAndIncrement.mockResolvedValue({
      backendAvailable: true,
      allowed: true,
      remaining: 9,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
      count: 1,
    })
    const behavior = {
      capabilities: ['chat.message.invoke'],
      budget: knownBehavior(null),
      credentialPolicy: knownBehavior(null),
      approvalPolicy: knownBehavior(null),
      filesystemScope: knownBehavior(null),
      runtime: knownBehavior(null),
      providerModelPolicy: knownBehavior(null),
      audit: knownBehavior(null),
    }
    mocks.authorize.mockResolvedValue({
      status: 'allowed',
      context: {
        version: 2,
        principal: { userId, sid, sessionVersion: 1 },
        operationId: 'chat.message.invoke',
        resource,
        target: prepared.target,
        targetHash: prepared.targetHash,
        accessPathId,
        authorizationRevision,
        behaviorBindingHash,
        pathKind: 'direct',
        effectiveTeamId: null,
        selectedPathCapabilities: ['chat.message.invoke'],
        behavior,
        validUntil: null,
      },
      behaviorBindingHash,
      preparedTarget: prepared,
      operation: {},
    })
  })

  it('returns a real producer token and the server-allocated chat message ID', async () => {
    const response = await request(app())
      .post('/external/rpc/delegations')
      .set('x-user-session-token', 'session-v2')
      .set('x-evenfire-access-path-id', accessPathId)
      .set('x-evenfire-authorization-revision', authorizationRevision)
      .send({
        version: 2,
        operationId: 'chat.message.invoke',
        resource: { type: 'host', logicalId: 'default/chatllm' },
        target: {
          hostRef: 'default/chatllm',
          channelType: 'rpc',
          channelId: 'chat-1',
        },
      })

    expect(response.status).toBe(200)
    expect(response.body.messageId).toBe('50000000-0000-4000-8000-000000000005')
    const claims = verifyUserDelegationV2(response.body.delegationToken)
    expect(claims).toMatchObject({
      sub: userId,
      sid,
      operationIds: ['chat.message.invoke'],
      accessPathId,
      authorizationRevision,
      behaviorBindingHash,
    })
    expect(claims?.targets['chat.message.invoke']).toEqual(prepared.target)
    expect(rateLimiter.checkAndIncrement).toHaveBeenCalledTimes(2)
    expect(rateLimiter.checkAndIncrement).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(/^external_rpc_token:ip:(?:::ffff:)?127\.0\.0\.1$/),
      10
    )
    expect(rateLimiter.checkAndIncrement).toHaveBeenNthCalledWith(
      2,
      `external_rpc_token:user:${userId}`,
      10
    )
    expect(rateLimiter.checkAndIncrement.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.authorize.mock.invocationCallOrder[0]!
    )
    expect(mocks.authorize.mock.invocationCallOrder[0]).toBeLessThan(
      tokenIssuer.issueUserDelegationV2.mock.invocationCallOrder[0]!
    )
  })

  it('excludes OAuth MCP destinations before v2 delegation signing', async () => {
    const mcpResource = canonicalResourceIdentity({
      environmentId: canonicalEnvironmentId(),
      type: 'mcp_server',
      logicalId: `${config.mcpServersNamespace}/oauth-weather`,
    })
    const mcpTarget = {
      serverNamespace: config.mcpServersNamespace,
      serverName: 'oauth-weather',
      toolName: 'forecast',
    }
    const mcpPrepared = prepareActionOperationTarget({
      operationId: 'mcp.invoke',
      resource: mcpResource,
      operationTarget: mcpTarget,
      allocateMessageId: () => {
        throw new Error('MCP invocation must not allocate a chat message ID')
      },
    })
    const behavior = {
      capabilities: ['mcp_server.use'],
      budget: knownBehavior(null),
      credentialPolicy: knownBehavior(null),
      approvalPolicy: knownBehavior(null),
      filesystemScope: knownBehavior(null),
      runtime: knownBehavior('ctx/weather'),
      providerModelPolicy: knownBehavior(null),
      audit: knownBehavior(null),
    }
    mocks.authorize.mockResolvedValueOnce({
      status: 'allowed',
      context: {
        version: 2,
        principal: { userId, sid, sessionVersion: 1 },
        operationId: 'mcp.invoke',
        resource: mcpResource,
        target: mcpPrepared.target,
        targetHash: mcpPrepared.targetHash,
        accessPathId,
        authorizationRevision,
        behaviorBindingHash,
        pathKind: 'direct',
        effectiveTeamId: null,
        selectedPathCapabilities: ['mcp_server.use'],
        behavior,
        validUntil: null,
      },
      behaviorBindingHash,
      preparedTarget: mcpPrepared,
      operation: {},
    })
    const getResourceExact = vi.fn(async () => ({
      metadata: { name: 'oauth-weather', namespace: config.mcpServersNamespace },
      spec: {
        enabled: true,
        auth: { type: 'oauth' },
        transport: { type: 'streamableHttp', url: 'http://oauth-weather/mcp' },
      },
    }))

    const response = await request(app({ getResourceExact } as never))
      .post('/external/rpc/delegations')
      .set('x-user-session-token', 'session-v2')
      .set('x-evenfire-access-path-id', accessPathId)
      .set('x-evenfire-authorization-revision', authorizationRevision)
      .send({
        version: 2,
        operationId: 'mcp.invoke',
        resource: { type: 'mcp_server', logicalId: mcpResource.logicalId },
        target: mcpTarget,
      })

    expect(response.status).toBe(403)
    expect(response.body).toMatchObject({ error: { code: 'forbidden' } })
    expect(getResourceExact).toHaveBeenCalledWith(
      'mcpservers',
      'oauth-weather',
      config.mcpServersNamespace,
      expect.any(Object)
    )
    expect(tokenIssuer.issueUserDelegationV2).not.toHaveBeenCalled()
  })

  it('keeps supported non-OAuth MCP invocation on the real v2 token producer', async () => {
    const mcpResource = canonicalResourceIdentity({
      environmentId: canonicalEnvironmentId(),
      type: 'mcp_server',
      logicalId: `${config.mcpServersNamespace}/plain-weather`,
    })
    const mcpTarget = {
      serverNamespace: config.mcpServersNamespace,
      serverName: 'plain-weather',
      toolName: 'forecast',
    }
    const mcpPrepared = prepareActionOperationTarget({
      operationId: 'mcp.invoke',
      resource: mcpResource,
      operationTarget: mcpTarget,
      allocateMessageId: () => {
        throw new Error('MCP invocation must not allocate a chat message ID')
      },
    })
    mocks.authorize.mockResolvedValueOnce({
      status: 'allowed',
      context: {
        version: 2,
        principal: { userId, sid, sessionVersion: 1 },
        operationId: 'mcp.invoke',
        resource: mcpResource,
        target: mcpPrepared.target,
        targetHash: mcpPrepared.targetHash,
        accessPathId,
        authorizationRevision,
        behaviorBindingHash,
        pathKind: 'direct',
        effectiveTeamId: null,
        selectedPathCapabilities: ['mcp_server.use'],
        behavior: {
          capabilities: ['mcp_server.use'],
          budget: knownBehavior(null),
          credentialPolicy: knownBehavior(null),
          approvalPolicy: knownBehavior(null),
          filesystemScope: knownBehavior(null),
          runtime: knownBehavior('ctx/weather'),
          providerModelPolicy: knownBehavior(null),
          audit: knownBehavior(null),
        },
        validUntil: null,
      },
      behaviorBindingHash,
      preparedTarget: mcpPrepared,
      operation: {},
    })
    const getResourceExact = vi.fn(async () => ({
      metadata: { name: 'plain-weather', namespace: config.mcpServersNamespace },
      spec: {
        enabled: true,
        auth: { type: 'none' },
        transport: { type: 'streamableHttp', url: 'http://plain-weather/mcp' },
      },
    }))

    const response = await request(app({ getResourceExact } as never))
      .post('/external/rpc/delegations')
      .set('x-user-session-token', 'session-v2')
      .set('x-evenfire-access-path-id', accessPathId)
      .set('x-evenfire-authorization-revision', authorizationRevision)
      .send({
        version: 2,
        operationId: 'mcp.invoke',
        resource: { type: 'mcp_server', logicalId: mcpResource.logicalId },
        target: mcpTarget,
      })

    expect(response.status).toBe(200)
    expect(verifyUserDelegationV2(response.body.delegationToken)).toMatchObject({
      operationIds: ['mcp.invoke'],
      resource: mcpResource,
      targets: { 'mcp.invoke': mcpTarget },
    })
    expect(getResourceExact).toHaveBeenCalledOnce()
    expect(tokenIssuer.issueUserDelegationV2).toHaveBeenCalledOnce()
  })

  it('fails closed when exact MCP destination lookup is unavailable', async () => {
    const mcpResource = canonicalResourceIdentity({
      environmentId: canonicalEnvironmentId(),
      type: 'mcp_server',
      logicalId: `${config.mcpServersNamespace}/plain-weather`,
    })
    const mcpTarget = {
      serverNamespace: config.mcpServersNamespace,
      serverName: 'plain-weather',
      toolName: 'forecast',
    }
    const mcpPrepared = prepareActionOperationTarget({
      operationId: 'mcp.invoke',
      resource: mcpResource,
      operationTarget: mcpTarget,
      allocateMessageId: () => {
        throw new Error('MCP invocation must not allocate a chat message ID')
      },
    })
    mocks.authorize.mockResolvedValueOnce({
      status: 'allowed',
      context: {
        version: 2,
        principal: { userId, sid, sessionVersion: 1 },
        operationId: 'mcp.invoke',
        resource: mcpResource,
        target: mcpPrepared.target,
        targetHash: mcpPrepared.targetHash,
        accessPathId,
        authorizationRevision,
        behaviorBindingHash,
        pathKind: 'direct',
        effectiveTeamId: null,
        selectedPathCapabilities: ['mcp_server.use'],
        behavior: {
          capabilities: ['mcp_server.use'],
          budget: knownBehavior(null),
          credentialPolicy: knownBehavior(null),
          approvalPolicy: knownBehavior(null),
          filesystemScope: knownBehavior(null),
          runtime: knownBehavior('ctx/weather'),
          providerModelPolicy: knownBehavior(null),
          audit: knownBehavior(null),
        },
        validUntil: null,
      },
      behaviorBindingHash,
      preparedTarget: mcpPrepared,
      operation: {},
    })
    const getResourceExact = vi.fn(async () => {
      throw new Error('Kubernetes API unavailable')
    })

    const response = await request(app({ getResourceExact } as never))
      .post('/external/rpc/delegations')
      .set('x-user-session-token', 'session-v2')
      .set('x-evenfire-access-path-id', accessPathId)
      .set('x-evenfire-authorization-revision', authorizationRevision)
      .send({
        version: 2,
        operationId: 'mcp.invoke',
        resource: { type: 'mcp_server', logicalId: mcpResource.logicalId },
        target: mcpTarget,
      })

    expect(response.status).toBe(503)
    expect(response.body).toMatchObject({ error: { code: 'authority_unavailable' } })
    expect(tokenIssuer.issueUserDelegationV2).not.toHaveBeenCalled()
  })

  it.each([
    [
      'chat.read',
      'chat',
      'chat-a',
      { hostRef: 'default/chatllm', agent: 'main', chatId: 'chat-a' },
    ],
    ['task.read', 'runtime_session', 'task-a', { hostRef: 'default/chatllm', taskId: 'task-a' }],
    [
      'task.manage',
      'runtime_session',
      'task-a',
      { hostRef: 'default/chatllm', taskId: 'task-a', action: 'cancel' },
    ],
    [
      'model.read',
      'runtime_session',
      'session-a',
      { hostRef: 'default/chatllm', agent: 'main', chatId: 'chat-a' },
    ],
    [
      'model.select',
      'runtime_session',
      'session-a',
      {
        hostRef: 'default/chatllm',
        agent: 'main',
        chatId: 'chat-a',
        provider: 'openai',
        model: 'gpt-test',
      },
    ],
    ['session.read', 'runtime_session', 'session-a', { hostRef: 'default/chatllm' }],
    [
      'session.manage',
      'runtime_session',
      'session-a',
      { hostRef: 'default/chatllm', agent: 'main', chatId: 'chat-a', action: 'delete' },
    ],
  ] as const)(
    'admits the real public producer shape for %s',
    async (operationId, resourceType, logicalId, target) => {
      const requestedResource = canonicalResourceIdentity({
        environmentId: canonicalEnvironmentId(),
        type: resourceType,
        logicalId,
      })
      const operationPrepared = prepareActionOperationTarget({
        operationId,
        resource: requestedResource,
        operationTarget: target,
        allocateMessageId: () => {
          throw new Error('runtime operation must not allocate a message ID')
        },
      })
      mocks.authorize.mockResolvedValueOnce({
        status: 'allowed',
        context: {
          version: 2,
          principal: { userId, sid, sessionVersion: 1 },
          operationId,
          resource: requestedResource,
          target: operationPrepared.target,
          targetHash: operationPrepared.targetHash,
          accessPathId,
          authorizationRevision,
          behaviorBindingHash,
          pathKind: 'direct',
          effectiveTeamId: null,
          selectedPathCapabilities: [operationId],
          behavior: {
            capabilities: [operationId],
            budget: knownBehavior(null),
            credentialPolicy: knownBehavior(null),
            approvalPolicy: knownBehavior(null),
            filesystemScope: knownBehavior(null),
            runtime: knownBehavior(null),
            providerModelPolicy: knownBehavior(null),
            audit: knownBehavior(null),
          },
          validUntil: null,
        },
        behaviorBindingHash,
        preparedTarget: operationPrepared,
        operation: {},
      })

      const response = await request(app())
        .post('/external/rpc/delegations')
        .set('x-user-session-token', 'session-v2')
        .set('x-evenfire-access-path-id', accessPathId)
        .set('x-evenfire-authorization-revision', authorizationRevision)
        .send({
          version: 2,
          operationId,
          resource: { type: resourceType, logicalId },
          target,
        })

      expect(response.status).toBe(200)
      expect(verifyUserDelegationV2(response.body.delegationToken)).toMatchObject({
        operationIds: [operationId],
        resource: requestedResource,
        targets: { [operationId]: target },
      })
    }
  )

  it('blocks public delegation work when the pre-auth limiter denies', async () => {
    rateLimiter.checkAndIncrement.mockResolvedValueOnce({
      backendAvailable: true,
      allowed: false,
      remaining: 0,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
      count: 11,
    })

    const response = await request(app())
      .post('/external/rpc/delegations')
      .set('x-user-session-token', 'session-v2')
      .set('x-evenfire-access-path-id', accessPathId)
      .set('x-evenfire-authorization-revision', authorizationRevision)
      .send({
        version: 2,
        operationId: 'chat.message.invoke',
        resource: { type: 'host', logicalId: 'default/chatllm' },
        target: {
          hostRef: 'default/chatllm',
          channelType: 'rpc',
          channelId: 'chat-1',
        },
      })

    expect(response.status).toBe(429)
    expect(response.body).toMatchObject({ error: { code: 'rate_limited' } })
    expect(rateLimiter.checkAndIncrement).toHaveBeenCalledTimes(1)
    expect(mocks.authorize).not.toHaveBeenCalled()
    expect(tokenIssuer.issueUserDelegationV2).not.toHaveBeenCalled()
  })

  it('blocks public delegation work when the authenticated limiter denies', async () => {
    rateLimiter.checkAndIncrement
      .mockResolvedValueOnce({
        backendAvailable: true,
        allowed: true,
        remaining: 9,
        resetMs: Date.now() + 60_000,
        windowStartMs: Date.now(),
        count: 1,
      })
      .mockResolvedValueOnce({
        backendAvailable: true,
        allowed: false,
        remaining: 0,
        resetMs: Date.now() + 60_000,
        windowStartMs: Date.now(),
        count: 11,
      })

    const response = await request(app())
      .post('/external/rpc/delegations')
      .set('x-user-session-token', 'session-v2')
      .set('x-evenfire-access-path-id', accessPathId)
      .set('x-evenfire-authorization-revision', authorizationRevision)
      .send({
        version: 2,
        operationId: 'chat.message.invoke',
        resource: { type: 'host', logicalId: 'default/chatllm' },
        target: {
          hostRef: 'default/chatllm',
          channelType: 'rpc',
          channelId: 'chat-1',
        },
      })

    expect(response.status).toBe(429)
    expect(response.body).toMatchObject({ error: { code: 'rate_limited' } })
    expect(rateLimiter.checkAndIncrement).toHaveBeenCalledTimes(2)
    expect(mocks.authorize).not.toHaveBeenCalled()
    expect(tokenIssuer.issueUserDelegationV2).not.toHaveBeenCalled()
  })

  it('rejects client-supplied resource authority fields before authorization', async () => {
    const response = await request(app())
      .post('/external/rpc/delegations')
      .set('x-user-session-token', 'session-v2')
      .send({
        version: 2,
        operationId: 'chat.message.invoke',
        resource: {
          environmentId: 'production',
          type: 'host',
          logicalId: 'default/chatllm',
        },
        target: {},
      })

    expect(response.status).toBe(400)
    expect(mocks.authorize).not.toHaveBeenCalled()
  })

  it('rejects child-only approval consume before authorization or delegation signing', async () => {
    const approvalId = '60000000-0000-4000-8000-000000000006'
    const response = await request(app())
      .post('/external/rpc/delegations')
      .set('x-user-session-token', 'session-v2')
      .set('x-evenfire-access-path-id', accessPathId)
      .set('x-evenfire-authorization-revision', authorizationRevision)
      .send({
        version: 2,
        operationId: 'workflow.approval.consume',
        resource: { type: 'workflow_approval', logicalId: approvalId },
        target: {
          approvalId,
          decision: 'approve',
          recipeNamespace: 'sandbox-recipes',
          recipeName: 'approval-demo',
        },
      })

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ error: { code: 'invalid_request' } })
    expect(mocks.authorize).not.toHaveBeenCalled()
    expect(tokenIssuer.issueUserDelegationV2).not.toHaveBeenCalled()
  })
})
