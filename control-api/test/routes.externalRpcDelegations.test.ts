import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
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

function app() {
  const value = express()
  value.use(express.json())
  value.use(createExternalRpcDelegationsRouter({} as never))
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
})
