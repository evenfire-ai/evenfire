import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { Response as ExpressResponse, Request } from 'express'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import request from 'supertest'
import {
  type ActionOperationId,
  RPC_PROXY_MCP_HOST_EDGE_TOKEN_HEADER,
  type TrustedEdgeActionContextV2,
  actionOperationScope,
  canonicalResourceIdentity,
  hashActionTarget,
  validateActionOperationTarget,
} from '@clerum/action-context-contracts'
import {
  legacyMcpHostConsumer,
  legacyRpcProxyHostProducer,
} from './fixtures/rpcProxyEdgeProtocolV0'

const userId = '11111111-1111-4111-8111-111111111111'
const sid = '22222222-2222-4222-8222-222222222222'
const delegationJti = '33333333-3333-4333-8333-333333333333'
const rpcProxyEdgeToken = 'dev-rpc-proxy-mcp-host-edge-token'
type RpcProxyAction = {
  trustedEdgeHeader: string
  checkpoint: {
    destination: { kind: 'host'; ref: string; url: string } | null
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function rpcProxyActionFor(input: {
  operationId: ActionOperationId
  resourceType: 'host' | 'runtime_session'
  target: Record<string, string>
}): Promise<RpcProxyAction> {
  // Keep the real producer out of mcp-host's TypeScript rootDir while Vitest
  // loads it from the sibling service for the cross-service contract proof.
  const producerModule = `${process.cwd()}/../rpc-proxy/src/actionAuthorityV2.ts`
  const { authorizeActionV2 } = (await import(producerModule)) as {
    authorizeActionV2: (
      claims: unknown,
      bound: unknown,
      options: unknown
    ) => Promise<RpcProxyAction>
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
  const hostMessageAdmission =
    input.operationId === 'chat.message.invoke'
      ? {
          sendNonce: randomBytes(32).toString('base64url'),
          delegationExpiresAt: claims.exp,
        }
      : undefined
  const repositoryRoot = resolve(process.cwd(), '..')
  const producerOutput = execFileSync(
    resolve(repositoryRoot, 'rpc-proxy/node_modules/.bin/tsx'),
    [
      resolve(
        repositoryRoot,
        'control-api/test/fixtures/emitActionAuthorityCheckpointV2Fixture.ts'
      ),
      JSON.stringify({
        request: {
          version: 2,
          principal: { sub: claims.sub, sid: claims.sid, sessionVersion: claims.sv },
          delegationJti: claims.jti,
          resource,
          operationId: input.operationId,
          target,
          targetHash,
          accessPathId: claims.accessPathId,
          authorizationRevision: claims.authorizationRevision,
          behaviorBindingHash: claims.behaviorBindingHash,
          ...(hostMessageAdmission ? { hostMessageAdmission } : {}),
          domain: { service: 'rpc-proxy', resource, targetHash },
        },
        destination: {
          kind: 'host',
          ref: 'mcp-host/chatllm',
          url: 'http://chatllm.mcp-host.svc.cluster.local:8080',
        },
      }),
    ],
    { cwd: repositoryRoot, encoding: 'utf8' }
  )
  const checkpoint = JSON.parse(producerOutput)
  const authorized = await authorizeActionV2(
    claims,
    { operationId: input.operationId, target, targetHash },
    {
      hostMessageAdmission,
      fetchImpl: vi.fn().mockResolvedValue(
        new globalThis.Response(JSON.stringify(checkpoint), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      ) as typeof fetch,
    }
  )
  return authorized
}

async function rpcProxyHeaderFor(input: {
  operationId: ActionOperationId
  resourceType: 'host' | 'runtime_session'
  target: Record<string, string>
}): Promise<string> {
  return (await rpcProxyActionFor(input)).trustedEdgeHeader
}

async function realRpcProxyAction(): Promise<RpcProxyAction> {
  return rpcProxyActionFor({
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

async function realRpcProxyHeader(): Promise<string> {
  return (await realRpcProxyAction()).trustedEdgeHeader
}

describe('runtimeEdgeGuard v2', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.doMock('../../config', () => ({
      config: { hostName: 'chatllm', namespace: 'mcp-host', rpcProxyEdgeToken },
    }))
  })

  async function runRuntimeGuard(
    operations: readonly ['chat.message.invoke'] | readonly ['task.read'],
    headers: Record<string, string>
  ) {
    const { runtimeEdgeGuard, getRuntimeCallerContext } = await import('../edgeRuntimeAuth')
    const req = {
      headers: Object.fromEntries(
        Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])
      ),
    } as Request
    const response = { status: 200, body: undefined as unknown }
    const res = {
      status(code: number) {
        response.status = code
        return this
      },
      json(body: unknown) {
        response.body = body
        return this
      },
    } as unknown as ExpressResponse
    let continued = false
    runtimeEdgeGuard(['rpc-proxy', 'channel-reader'], operations)(req, res, () => {
      continued = true
    })
    return {
      status: continued ? 200 : response.status,
      body: continued ? getRuntimeCallerContext(req) : response.body,
    }
  }

  it('consumes the real rpc-proxy producer and exposes only trusted v2 identity', async () => {
    const authorizedActionV2 = await realRpcProxyAction()
    const header = authorizedActionV2.trustedEdgeHeader
    const { resolveHostConnectionForUser } = (await import(
      `${process.cwd()}/../rpc-proxy/src/services/mcpProxyService.ts`
    )) as {
      resolveHostConnectionForUser: (
        userId: string,
        hostRef: string,
        rpcAccessToken: string,
        edgeContext: {
          authorizedActionV2: RpcProxyAction
        }
      ) => Promise<{ headers: Record<string, string> } | null>
    }
    const connection = await resolveHostConnectionForUser(userId, 'chatllm', 'unused-user-token', {
      authorizedActionV2,
    })
    expect(connection?.headers).toMatchObject({
      [RPC_PROXY_MCP_HOST_EDGE_TOKEN_HEADER]: rpcProxyEdgeToken,
      'x-service-token': 'rpc-proxy',
      'x-clerum-edge-caller': 'rpc-proxy',
    })
    expect(connection?.headers.authorization).toBeUndefined()
    const response = await runRuntimeGuard(['chat.message.invoke'], connection!.headers)
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
    expect(response.body).not.toHaveProperty('teamId')
    const decoded = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >
    expect(decoded).not.toHaveProperty('hostMessageAdmission')
    expect(decoded).not.toHaveProperty('hostMessageAdmissionReceipt')
    expect(decoded).not.toHaveProperty('sendNonce')
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
      .set(RPC_PROXY_MCP_HOST_EDGE_TOKEN_HEADER, rpcProxyEdgeToken)
      .set('x-service-token', 'rpc-proxy')
      .set('x-clerum-edge-host-ref', 'chatllm')
      .set('x-clerum-edge-action-context', header)

    expect(response.status).toBe(200)
    expect(sessionSearchHandler).toHaveBeenCalledWith(
      expect.objectContaining({ userSub: userId, query: 'budget' })
    )
  })

  it('rejects operation substitution and mixed legacy authority headers', async () => {
    const header = await realRpcProxyHeader()
    const mismatch = await runRuntimeGuard(['task.read'], {
      'x-clerum-edge-caller': 'rpc-proxy',
      [RPC_PROXY_MCP_HOST_EDGE_TOKEN_HEADER]: rpcProxyEdgeToken,
      'x-service-token': 'rpc-proxy',
      'x-clerum-edge-host-ref': 'chatllm',
      'x-clerum-edge-action-context': header,
    })
    expect(mismatch.status).toBe(403)

    const mixed = await runRuntimeGuard(['chat.message.invoke'], {
      'x-clerum-edge-caller': 'rpc-proxy',
      [RPC_PROXY_MCP_HOST_EDGE_TOKEN_HEADER]: rpcProxyEdgeToken,
      'x-service-token': 'rpc-proxy',
      'x-clerum-edge-host-ref': 'chatllm',
      'x-clerum-edge-user-id': 'attacker',
      'x-clerum-edge-action-context': header,
    })
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
    const response = await runRuntimeGuard(['chat.message.invoke'], {
      'x-clerum-edge-caller': 'rpc-proxy',
      [RPC_PROXY_MCP_HOST_EDGE_TOKEN_HEADER]: rpcProxyEdgeToken,
      'x-service-token': 'rpc-proxy',
      'x-clerum-edge-host-ref': 'chatllm',
      'x-clerum-edge-action-context': substituted,
    })
    expect(response.status).toBe(401)
  })

  it('rejects unknown authority fields in the producer-built envelope', async () => {
    const header = await realRpcProxyHeader()
    const decoded = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >
    const extended = Buffer.from(
      JSON.stringify({ ...decoded, hostMessageAdmissionReceipt: 'not-for-downstream' }),
      'utf8'
    ).toString('base64url')
    const response = await runRuntimeGuard(['chat.message.invoke'], {
      'x-clerum-edge-caller': 'rpc-proxy',
      [RPC_PROXY_MCP_HOST_EDGE_TOKEN_HEADER]: rpcProxyEdgeToken,
      'x-service-token': 'rpc-proxy',
      'x-clerum-edge-host-ref': 'chatllm',
      'x-clerum-edge-action-context': extended,
    })
    expect(response.status).toBe(401)
  })

  it('keeps legacy caller context separate from V2 authority authentication', async () => {
    const legacy = await runRuntimeGuard(['chat.message.invoke'], {
      'x-clerum-edge-caller': 'rpc-proxy',
      'x-clerum-edge-user-id': userId,
      'x-clerum-edge-host-ref': 'chatllm',
    })
    expect(legacy.status).toBe(200)
    expect(legacy.body).toMatchObject({ caller: 'rpc-proxy', userId })
    expect(legacy.body).not.toHaveProperty('actionContextV2')

    const forgedV2 = await runRuntimeGuard(['chat.message.invoke'], {
      'x-clerum-edge-caller': 'rpc-proxy',
      'x-clerum-edge-user-id': userId,
      'x-clerum-edge-host-ref': 'chatllm',
      'x-clerum-edge-action-context': await realRpcProxyHeader(),
    })
    expect(forgedV2.status).toBe(401)
  })

  it('does not let a credential header alone activate V2', async () => {
    const response = await runRuntimeGuard(['chat.message.invoke'], {
      ...legacyRpcProxyHostProducer({ userId, hostRef: 'chatllm' }),
      [RPC_PROXY_MCP_HOST_EDGE_TOKEN_HEADER]: rpcProxyEdgeToken,
      'x-service-token': 'rpc-proxy',
    })
    expect(response.status).toBe(200)
    expect(response.body).not.toHaveProperty('actionContextV2')
  })

  it('rejects the rpc-proxy marker with a wrong service token', async () => {
    const actionContext = await realRpcProxyHeader()
    const response = await runRuntimeGuard(['chat.message.invoke'], {
      'x-clerum-edge-caller': 'rpc-proxy',
      'x-clerum-edge-user-id': userId,
      'x-clerum-edge-host-ref': 'chatllm',
      'x-clerum-edge-action-context': actionContext,
      [RPC_PROXY_MCP_HOST_EDGE_TOKEN_HEADER]: 'wrong-edge-token',
      'x-service-token': 'rpc-proxy',
    })

    expect(response.status).toBe(401)
  })

  it('keeps legacy mode available but fails V2 closed without configured credential', async () => {
    const { config: runtimeConfig } = await import('../../config')
    const configuredToken = runtimeConfig.rpcProxyEdgeToken
    ;(runtimeConfig as { rpcProxyEdgeToken: string }).rpcProxyEdgeToken = ''

    try {
      const legacy = await runRuntimeGuard(['chat.message.invoke'], {
        'x-clerum-edge-caller': 'rpc-proxy',
        'x-clerum-edge-user-id': userId,
        'x-clerum-edge-host-ref': 'chatllm',
      })
      expect(legacy.status).toBe(200)

      const v2 = await runRuntimeGuard(['chat.message.invoke'], {
        'x-clerum-edge-caller': 'rpc-proxy',
        'x-clerum-edge-user-id': userId,
        'x-clerum-edge-host-ref': 'chatllm',
        'x-service-token': 'rpc-proxy',
        'x-clerum-edge-action-context': await realRpcProxyHeader(),
      })
      expect(v2.status).toBe(401)
    } finally {
      ;(runtimeConfig as { rpcProxyEdgeToken: string }).rpcProxyEdgeToken = configuredToken
    }
  })

  it('rejects a valid edge credential paired with the wrong service marker', async () => {
    const actionContext = await realRpcProxyHeader()
    const response = await runRuntimeGuard(['chat.message.invoke'], {
      'x-clerum-edge-caller': 'rpc-proxy',
      'x-clerum-edge-host-ref': 'chatllm',
      'x-clerum-edge-action-context': actionContext,
      'x-service-token': 'workflow-approval-request-reader',
      [RPC_PROXY_MCP_HOST_EDGE_TOKEN_HEADER]: rpcProxyEdgeToken,
    })

    expect(response.status).toBe(401)
  })

  it('rejects a correctly authenticated request bound to a different Host', async () => {
    const header = await realRpcProxyHeader()
    const response = await runRuntimeGuard(['chat.message.invoke'], {
      'x-clerum-edge-caller': 'rpc-proxy',
      'x-clerum-edge-host-ref': 'another-host',
      'x-service-token': 'rpc-proxy',
      [RPC_PROXY_MCP_HOST_EDGE_TOKEN_HEADER]: rpcProxyEdgeToken,
      'x-clerum-edge-action-context': header,
    })

    expect(response.status).toBe(403)
  })

  it('proves the old/new producer-consumer compatibility matrix from source fixtures', async () => {
    const oldProxyHeaders = legacyRpcProxyHostProducer({ userId, hostRef: 'chatllm' })
    const newProxyHeaders = await (async () => {
      const { resolveHostConnectionForUser } = (await import(
        `${process.cwd()}/../rpc-proxy/src/services/mcpProxyService.ts`
      )) as {
        resolveHostConnectionForUser: (
          userId: string,
          hostRef: string,
          rpcAccessToken: string
        ) => Promise<{ headers: Record<string, string> } | null>
      }
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new globalThis.Response(
            JSON.stringify({
              userId,
              hostRef: 'chatllm',
              url: 'http://chatllm.mcp-host.svc.cluster.local:8080',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        )
      )
      const connection = await resolveHostConnectionForUser(userId, 'chatllm', 'unused-token')
      expect(connection?.headers.authorization).toBeUndefined()
      return connection!.headers
    })()
    const oldHost = legacyMcpHostConsumer()
    const newHost = (headers: Record<string, string>) => runRuntimeGuard(['task.read'], headers)

    expect((await request(oldHost).post('/v1/runtime/messages').set(oldProxyHeaders)).status).toBe(
      200
    )
    expect((await request(oldHost).post('/v1/runtime/messages').set(newProxyHeaders)).status).toBe(
      200
    )
    expect((await newHost(newProxyHeaders)).status).toBe(200)
    expect((await newHost(oldProxyHeaders)).status).toBe(200)
  })

  it('rejects V2 authority injected into otherwise legacy caller context', async () => {
    const actionContextV2 = await realRpcProxyHeader()
    const injectedLegacyHeaders = {
      ...legacyRpcProxyHostProducer({ userId, hostRef: 'chatllm' }),
      'x-clerum-edge-action-context': actionContextV2,
    }
    const response = await runRuntimeGuard(['chat.message.invoke'], injectedLegacyHeaders)
    expect(response.status).toBe(401)
  })

  it('rejects Authorization-only credentials and credentials asserted by another caller', async () => {
    const actionContext = await realRpcProxyHeader()
    const authorizationOnly = await runRuntimeGuard(['task.read'], {
      'x-clerum-edge-caller': 'rpc-proxy',
      'x-clerum-edge-host-ref': 'chatllm',
      'x-clerum-edge-user-id': userId,
      'x-service-token': 'rpc-proxy',
      'x-clerum-edge-action-context': actionContext,
      authorization: `Bearer ${rpcProxyEdgeToken}`,
    })
    expect(authorizationOnly.status).toBe(401)

    const otherCaller = await runRuntimeGuard(['task.read'], {
      'x-clerum-edge-caller': 'workflow-approval-request-reader',
      'x-clerum-edge-host-ref': 'chatllm',
      'x-service-token': 'rpc-proxy',
      'x-clerum-edge-action-context': actionContext,
      [RPC_PROXY_MCP_HOST_EDGE_TOKEN_HEADER]: rpcProxyEdgeToken,
    })
    expect(otherCaller.status).toBe(401)
  })

  it('rejects Authorization even when the dedicated RPC Proxy credential is valid', async () => {
    const actionContext = await realRpcProxyHeader()
    const response = await runRuntimeGuard(['task.read'], {
      'x-clerum-edge-caller': 'rpc-proxy',
      'x-clerum-edge-host-ref': 'chatllm',
      'x-clerum-edge-user-id': userId,
      'x-service-token': 'rpc-proxy',
      [RPC_PROXY_MCP_HOST_EDGE_TOKEN_HEADER]: rpcProxyEdgeToken,
      'x-clerum-edge-action-context': actionContext,
      authorization: 'Bearer unrelated-token',
    })

    expect(response.status).toBe(401)
  })

  it('rejects standalone V2 authority headers on the legacy path', async () => {
    const response = await runRuntimeGuard(['task.read'], {
      'x-clerum-edge-caller': 'rpc-proxy',
      'x-clerum-edge-host-ref': 'chatllm',
      'x-clerum-edge-user-id': userId,
      'x-clerum-edge-access-path-id': `ap1_${'b'.repeat(43)}`,
    })
    expect(response.status).toBe(401)
  })

  it('keeps the independent channel-reader caller path working without RPC Proxy auth', async () => {
    const response = await runRuntimeGuard(['chat.message.invoke'], {
      'x-clerum-edge-caller': 'channel-reader',
      'x-clerum-edge-host-ref': 'chatllm',
      'x-clerum-edge-channel-type': 'telegram',
      'x-clerum-edge-channel-id': 'chatllm',
      'x-clerum-edge-sender': 'sender-1',
    })

    expect(response.status).toBe(200)
    expect(response.body).toHaveProperty('caller', 'channel-reader')
  })
})
