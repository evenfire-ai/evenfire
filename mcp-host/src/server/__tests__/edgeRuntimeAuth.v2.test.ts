import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import {
  type ActionOperationId,
  type TrustedEdgeActionContextV2,
  actionOperationScope,
  canonicalResourceIdentity,
  hashActionTarget,
  validateActionOperationTarget,
} from '@clerum/action-context-contracts'

const userId = '11111111-1111-4111-8111-111111111111'
const sid = '22222222-2222-4222-8222-222222222222'
const delegationJti = '33333333-3333-4333-8333-333333333333'

function behavior() {
  return {
    budget: { state: 'known' as const, value: 'budget-direct' },
    credentialPolicy: { state: 'known' as const, value: 'credentials-a' },
    approvalPolicy: { state: 'known' as const, value: 'approvals-a' },
    filesystemScope: { state: 'known' as const, value: 'files-a' },
    runtime: { state: 'known' as const, value: 'runtime-a' },
    providerModelPolicy: { state: 'known' as const, value: 'models-a' },
    audit: { state: 'known' as const, value: 'audit-a' },
  }
}

async function rpcProxyHeaderFor(input: {
  operationId: ActionOperationId
  resourceType: 'host' | 'runtime_session'
  target: Record<string, string>
}): Promise<string> {
  // Keep the real producer out of mcp-host's TypeScript rootDir while Vitest
  // loads it from the sibling service for the cross-service contract proof.
  const producerModule = `${process.cwd()}/../rpc-proxy/src/actionAuthorityV2.ts`
  const { authorizeActionV2 } = (await import(producerModule)) as {
    authorizeActionV2: (
      claims: unknown,
      bound: unknown,
      options: unknown
    ) => Promise<{ trustedEdgeHeader: string }>
  }
  const resource = canonicalResourceIdentity({
    environmentId: 'cluster.local/evenfire',
    type: input.resourceType,
    logicalId: 'mcp-host/chatllm',
    displayName: 'chatllm',
  })
  const target = validateActionOperationTarget({
    operationId: input.operationId,
    resource,
    operationTarget: input.target,
  })
  const targetHash = hashActionTarget(target)
  const claims = {
    typ: 'user_delegation' as const,
    ver: 2 as const,
    sub: userId,
    sid,
    sv: 7,
    jti: delegationJti,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 120,
    operationIds: [input.operationId],
    scopes: [actionOperationScope(input.operationId)],
    resource,
    targets: { [input.operationId]: target },
    targetHashes: { [input.operationId]: targetHash },
    accessPathId: `ap1_${'b'.repeat(43)}`,
    authorizationRevision: `ar1_${'c'.repeat(43)}`,
    behaviorBindingHash: `bh2_${'d'.repeat(43)}`,
    pathKind: 'direct' as const,
    effectiveTeamId: null,
  }
  const authorized = await authorizeActionV2(
    claims,
    { operationId: input.operationId, target, targetHash },
    {
      fetchImpl: vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            version: 2,
            status: 'allowed',
            authorizationRevision: claims.authorizationRevision,
            behaviorBindingHash: claims.behaviorBindingHash,
            behavior: behavior(),
            checkedAt: new Date().toISOString(),
            validUntil: new Date(Date.now() + 60_000).toISOString(),
            attribution: {
              userId,
              sid,
              sessionVersion: 7,
              accessPathId: claims.accessPathId,
              pathKind: 'direct',
              effectiveTeamId: null,
            },
            destination: {
              kind: 'host',
              ref: 'mcp-host/chatllm',
              url: 'http://chatllm.mcp-host.svc.cluster.local:8080',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      ) as typeof fetch,
    }
  )
  return authorized.trustedEdgeHeader
}

async function realRpcProxyHeader(): Promise<string> {
  return rpcProxyHeaderFor({
    operationId: 'chat.message.invoke',
    resourceType: 'host',
    target: {
      hostRef: 'mcp-host/chatllm',
      channelType: 'rpc',
      channelId: 'chatllm',
      messageId: '44444444-4444-4444-8444-444444444444',
    },
  })
}

describe('runtimeEdgeGuard v2', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.doMock('../../config', () => ({
      config: { hostName: 'chatllm', namespace: 'mcp-host' },
    }))
  })

  async function appFor(operations: readonly ['chat.message.invoke'] | readonly ['task.read']) {
    const { runtimeEdgeGuard, getRuntimeCallerContext } = await import('../edgeRuntimeAuth')
    const app = express()
    app.post('/test', runtimeEdgeGuard(['rpc-proxy'], operations), (req, res) => {
      res.json(getRuntimeCallerContext(req))
    })
    return app
  }

  it('consumes the real rpc-proxy producer and exposes only trusted v2 identity', async () => {
    const header = await realRpcProxyHeader()
    const response = await request(await appFor(['chat.message.invoke']))
      .post('/test')
      .set('x-clerum-edge-caller', 'rpc-proxy')
      .set('x-clerum-edge-host-ref', 'chatllm')
      .set('x-clerum-edge-action-context', header)
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      caller: 'rpc-proxy',
      userId,
      actionContextV2: {
        version: 2,
        userId,
        operationId: 'chat.message.invoke',
        pathKind: 'direct',
        effectiveTeamId: null,
      },
    })
    expect(response.body.teamId).toBeUndefined()
  })

  it('carries a real session.read edge envelope into the session-search consumer', async () => {
    const header = await rpcProxyHeaderFor({
      operationId: 'session.read',
      resourceType: 'runtime_session',
      target: { hostRef: 'mcp-host/chatllm' },
    })
    const { runtimeEdgeGuard } = await import('../edgeRuntimeAuth')
    const { handleSessionSearchRoute } = await import('../routes')
    const { makeHandlers } = await import('./testHelpers')
    const sessionSearchHandler = vi.fn().mockResolvedValue({ results: [], total: 0 })
    const app = express()
    app.get('/search', runtimeEdgeGuard(['rpc-proxy'], ['session.read']), async (req, res) => {
      await handleSessionSearchRoute(req, res, makeHandlers({ sessionSearchHandler }))
    })

    const response = await request(app)
      .get('/search?q=budget')
      .set('x-clerum-edge-caller', 'rpc-proxy')
      .set('x-clerum-edge-host-ref', 'chatllm')
      .set('x-clerum-edge-action-context', header)

    expect(response.status).toBe(200)
    expect(sessionSearchHandler).toHaveBeenCalledWith(
      expect.objectContaining({ userSub: userId, query: 'budget' })
    )
  })

  it('rejects operation substitution and mixed legacy authority headers', async () => {
    const header = await realRpcProxyHeader()
    const mismatch = await request(await appFor(['task.read']))
      .post('/test')
      .set('x-clerum-edge-caller', 'rpc-proxy')
      .set('x-clerum-edge-host-ref', 'chatllm')
      .set('x-clerum-edge-action-context', header)
    expect(mismatch.status).toBe(403)

    const mixed = await request(await appFor(['chat.message.invoke']))
      .post('/test')
      .set('x-clerum-edge-caller', 'rpc-proxy')
      .set('x-clerum-edge-host-ref', 'chatllm')
      .set('x-clerum-edge-user-id', 'attacker')
      .set('x-clerum-edge-action-context', header)
    expect(mixed.status).toBe(401)
  })

  it('rejects target/hash substitution in an otherwise valid envelope', async () => {
    const header = await realRpcProxyHeader()
    const decoded = JSON.parse(
      Buffer.from(header, 'base64url').toString('utf8')
    ) as TrustedEdgeActionContextV2
    const substituted = Buffer.from(
      JSON.stringify({ ...decoded, target: { ...decoded.target, channelId: 'other-host' } }),
      'utf8'
    ).toString('base64url')
    const response = await request(await appFor(['chat.message.invoke']))
      .post('/test')
      .set('x-clerum-edge-caller', 'rpc-proxy')
      .set('x-clerum-edge-host-ref', 'chatllm')
      .set('x-clerum-edge-action-context', substituted)
    expect(response.status).toBe(401)
  })
})
