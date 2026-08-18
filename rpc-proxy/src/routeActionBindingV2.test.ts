import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  type ActionOperationId,
  canonicalResourceIdentity,
  hashActionTarget,
  validateActionOperationTarget,
} from '@clerum/action-context-contracts'
import type { AuthedRequest } from './middleware/auth.js'
import { RouteActionBindingError, bindRouteActionV2 } from './routeActionBindingV2.js'
import type { UserDelegationV2Claims } from './userDelegationV2.js'

function delegation(input: {
  operationId: ActionOperationId
  resourceType: 'host' | 'mcp_server'
  resourceId: string
  target: Record<string, string>
}): UserDelegationV2Claims {
  const resource = canonicalResourceIdentity({
    environmentId: 'test',
    type: input.resourceType,
    logicalId: input.resourceId,
    displayName: input.resourceId,
  })
  const target = validateActionOperationTarget({
    operationId: input.operationId,
    resource,
    operationTarget: input.target,
  })
  return {
    typ: 'user_delegation',
    ver: 2,
    sub: randomUUID(),
    sid: randomUUID(),
    sv: 1,
    jti: randomUUID(),
    iat: 1,
    exp: 2,
    operationIds: [input.operationId],
    scopes: [`action:${input.operationId}`],
    resource,
    targets: { [input.operationId]: target },
    targetHashes: { [input.operationId]: hashActionTarget(target) },
    accessPathId: `ap1_${'A'.repeat(43)}`,
    authorizationRevision: `ar1_${'B'.repeat(43)}`,
    behaviorBindingHash: `bh2_${'C'.repeat(43)}`,
    pathKind: 'direct',
    effectiveTeamId: null,
  }
}

function request(input: {
  path: string
  method: string
  params?: Record<string, string>
  query?: Record<string, string>
  body?: unknown
}): AuthedRequest {
  return {
    route: { path: input.path },
    method: input.method,
    params: input.params ?? {},
    query: input.query ?? {},
    body: input.body,
  } as unknown as AuthedRequest
}

describe('route action v2 binding', () => {
  it('requires exact server-assigned chat message identity', () => {
    const messageId = '44444444-4444-4444-8444-444444444444'
    const claims = delegation({
      operationId: 'chat.message.invoke',
      resourceType: 'host',
      resourceId: 'mcp-host/chatllm',
      target: {
        hostRef: 'mcp-host/chatllm',
        channelType: 'rpc',
        channelId: 'chatllm',
        messageId,
      },
    })
    const matching = request({
      path: '/rpc/hosts/:hostRef/messages',
      method: 'POST',
      params: { hostRef: 'chatllm' },
      body: { content: 'hello', messageId },
    })
    expect(bindRouteActionV2(matching, claims).target).toMatchObject({ messageId })

    const substituted = request({
      path: '/rpc/hosts/:hostRef/messages',
      method: 'POST',
      params: { hostRef: 'chatllm' },
      body: { content: 'hello', messageId: '55555555-5555-4555-8555-555555555555' },
    })
    expect(() => bindRouteActionV2(substituted, claims)).toThrow(RouteActionBindingError)
  })

  it('rejects route/resource substitution', () => {
    const claims = delegation({
      operationId: 'host.status.read',
      resourceType: 'host',
      resourceId: 'mcp-host/chatllm',
      target: { hostRef: 'mcp-host/chatllm' },
    })
    expect(() =>
      bindRouteActionV2(
        request({
          path: '/rpc/hosts/:hostRef/status',
          method: 'GET',
          params: { hostRef: 'other-host' },
        }),
        claims
      )
    ).toThrow(RouteActionBindingError)
  })

  it('denies unclassified and internal MCP methods', () => {
    const claims = delegation({
      operationId: 'mcp.invoke',
      resourceType: 'mcp_server',
      resourceId: 'mcp-server/weather',
      target: {
        serverNamespace: 'mcp-server',
        serverName: 'weather',
        toolName: 'forecast',
      },
    })
    for (const method of ['notifications/initialized', 'resources/read', 'unknown/method']) {
      expect(() =>
        bindRouteActionV2(
          request({
            path: '/rpc/:serverName',
            method: 'POST',
            params: { serverName: 'weather' },
            body: { jsonrpc: '2.0', id: 1, method, params: {} },
          }),
          claims
        )
      ).toThrow(RouteActionBindingError)
    }
  })
})
