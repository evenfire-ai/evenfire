import { describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'
import { createHash } from 'node:crypto'

type StartResult = {
  server: any
  baseUrl: string
}

async function startServer(
  configure?: (server: any) => void,
  hostName = 'chatllm'
): Promise<StartResult> {
  process.env.CLERUM_ENABLE_AUTH = 'false'
  process.env.CLERUM_HOST_NAME = hostName
  vi.resetModules()
  const { RPCServer } = await import('../server')
  const server = new RPCServer(0)
  if (configure) configure(server)
  await server.start()
  const address = (server as unknown as { server: { address: () => AddressInfo } }).server.address()
  return { server, baseUrl: `http://127.0.0.1:${address.port}` }
}

function rpcEdgeHeaders(userId = 'user-1'): Record<string, string> {
  return {
    'x-clerum-edge-caller': 'rpc-proxy',
    'x-clerum-edge-host-ref': 'chatllm',
    'x-clerum-edge-user-id': userId,
  }
}

function channelReaderEdgeHeaders(
  source: { channelType: 'telegram' | 'slack'; channelId: string; sender: string },
  extra: Record<string, string> = {}
): Record<string, string> {
  return providerEdgeHeaders('channel-reader', source, extra)
}

function workflowApprovalReaderEdgeHeaders(
  source: { channelType: 'telegram' | 'slack'; channelId: string; sender: string },
  extra: Record<string, string> = {}
): Record<string, string> {
  return providerEdgeHeaders('workflow-approval-request-reader', source, extra)
}

function providerEdgeHeaders(
  caller: 'channel-reader' | 'workflow-approval-request-reader',
  source: { channelType: 'telegram' | 'slack'; channelId: string; sender: string },
  extra: Record<string, string> = {}
): Record<string, string> {
  const hostRef = extra['x-clerum-edge-host-ref'] ?? 'chatllm'
  return {
    ...extra,
    'x-clerum-edge-caller': caller,
    'x-clerum-edge-host-ref': hostRef,
    'x-clerum-edge-channel-type': source.channelType,
    'x-clerum-edge-channel-id': source.channelId,
    'x-clerum-edge-sender': source.sender,
  }
}

describe('RPCServer v1 runtime interface contract', () => {
  it('exposes only versioned runtime info endpoints', async () => {
    const { server, baseUrl } = await startServer()
    try {
      const root = await fetch(`${baseUrl}/v1/runtime`)
      expect(root.status).toBe(200)
      const body = (await root.json()) as {
        endpoints: Record<string, string>
        rpcCounterparts: Record<string, string>
      }

      expect(body.endpoints['POST /v1/runtime/messages']).toBeDefined()
      expect(body.endpoints['GET /v1/runtime/status']).toBeDefined()
      expect(body.endpoints['POST /v1/runtime/workflow-approvals/decide']).toBeDefined()
      expect(body.endpoints['POST /v1/runtime/workflow-approvals/resolve']).toBeDefined()
      expect(body.endpoints['POST /v1/runtime/workflow-results/latest']).toBeDefined()
      expect(body.endpoints['GET /metrics']).toBeDefined()
      expect(body.endpoints['GET /status']).toBeUndefined()
      expect(body.rpcCounterparts['POST /v1/runtime/messages']).toBe('onMessage(handler)')
      expect(body.rpcCounterparts['GET /v1/runtime/status']).toBe('onStatus(handler)')
      expect(body.rpcCounterparts['POST /v1/runtime/workflow-approvals/decide']).toBe(
        'onProviderWorkflowApprovalDecision(handler)'
      )
      expect(body.rpcCounterparts['POST /v1/runtime/workflow-approvals/resolve']).toBe(
        'onProviderWorkflowApprovalResolve(handler)'
      )
      expect(body.rpcCounterparts['POST /v1/runtime/workflow-results/latest']).toBe(
        'onProviderWorkflowResultRequest(handler)'
      )
    } finally {
      await server.stop()
    }
  })

  it('rejects rpc-proxy runtime routes without edge user context', async () => {
    const { server, baseUrl } = await startServer()
    try {
      const response = await fetch(`${baseUrl}/v1/runtime/status`, {
        headers: {
          'x-clerum-edge-caller': 'rpc-proxy',
          'x-clerum-edge-host-ref': 'chatllm',
        },
      })
      expect(response.status).toBe(401)
      await expect(response.json()).resolves.toEqual({
        error: 'Missing rpc edge caller context',
      })
    } finally {
      await server.stop()
    }
  })

  it('separates liveness from runtime auth readiness degradation', async () => {
    const { server, baseUrl } = await startServer()
    try {
      const healthModule = await import('../workflow/runtimeAuthHealth')
      healthModule.resetRuntimeAuthHealthForTests()

      let live = await fetch(`${baseUrl}/v1/runtime/live`)
      let health = await fetch(`${baseUrl}/v1/runtime/health`)
      expect(live.status).toBe(200)
      expect(health.status).toBe(200)

      healthModule.recordRuntimeAuthRecoveryFailure('refresh_recovery_failed')
      healthModule.recordRuntimeAuthRecoveryFailure('refresh_recovery_failed')
      healthModule.recordRuntimeAuthRecoveryFailure('refresh_recovery_failed')

      live = await fetch(`${baseUrl}/v1/runtime/live`)
      health = await fetch(`${baseUrl}/v1/runtime/health`)
      const body = (await health.json()) as { status: string; runtimeAuth?: unknown }

      expect(live.status).toBe(200)
      expect(health.status).toBe(503)
      expect(body.status).toBe('degraded')
      expect(body.runtimeAuth).toBeUndefined()

      healthModule.recordRuntimeAuthRecoverySuccess()
      health = await fetch(`${baseUrl}/v1/runtime/health`)
      expect(health.status).toBe(200)
      await expect(health.json()).resolves.toEqual({ status: 'ok' })
    } finally {
      await server.stop()
    }
  })

  it('serves Prometheus metrics without runtime auth', async () => {
    const { server, baseUrl } = await startServer()
    try {
      const { workflowTokenRefreshCounter } = await import('../workflow/userApprovalRequester')
      workflowTokenRefreshCounter.reset()
      workflowTokenRefreshCounter.inc({ recipe: 'recipe-test', outcome: 'succeeded' })
      const response = await fetch(`${baseUrl}/metrics`)
      const body = await response.text()

      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/plain')
      expect(body).toContain(
        'workflow_token_refresh_total{recipe="recipe-test",outcome="succeeded"} 1'
      )
    } finally {
      await server.stop()
    }
  })

  it('routes message/status/task/cron paths to callback handlers', async () => {
    const onMessage = vi.fn(async () => ({ success: true, status: 'completed', response: 'ok' }))
    const onStatus = vi.fn(async () => ({
      agent: {
        state: 'idle',
        currentTaskId: null,
        tasksProcessed: 0,
        tasksSucceeded: 0,
        tasksFailed: 0,
        uptime: 1,
      },
      queue: { pending: 0, processing: 0, completed: 0, failed: 0 },
      cronJobs: 0,
    }))
    const onTaskResult = vi.fn(async () => ({
      success: true,
      status: 'completed',
      response: 'done',
    }))
    const onCronResults = vi.fn(() => [])
    const onCronAck = vi.fn(() => true)

    const { server, baseUrl } = await startServer(rpcServer => {
      rpcServer.onMessage(onMessage)
      rpcServer.onStatus(onStatus)
      rpcServer.onTaskResult(onTaskResult)
      rpcServer.onCronResults(onCronResults)
      rpcServer.onCronResultAck(onCronAck)
    })

    try {
      await fetch(`${baseUrl}/v1/runtime/messages`, {
        method: 'POST',
        headers: channelReaderEdgeHeaders(
          { channelType: 'telegram', channelId: 'c1', sender: 'u1' },
          { 'Content-Type': 'application/json' }
        ),
        body: JSON.stringify({
          content: 'hi',
          channelType: 'telegram',
          channelId: 'c1',
          sender: 'u1',
          timestamp: new Date().toISOString(),
          messageId: 'm1',
          hostRef: 'chatllm',
        }),
      })
      await fetch(`${baseUrl}/v1/runtime/status`, { headers: rpcEdgeHeaders() })
      await fetch(`${baseUrl}/v1/runtime/tasks/task-42/result`, {
        headers: channelReaderEdgeHeaders({
          channelType: 'telegram',
          channelId: 'c1',
          sender: 'u1',
        }),
      })
      await fetch(`${baseUrl}/v1/runtime/cron/results`, {
        headers: channelReaderEdgeHeaders({
          channelType: 'telegram',
          channelId: 'c1',
          sender: 'u1',
        }),
      })
      await fetch(`${baseUrl}/v1/runtime/cron/results/task-42`, {
        method: 'DELETE',
        headers: channelReaderEdgeHeaders({
          channelType: 'telegram',
          channelId: 'c1',
          sender: 'u1',
        }),
      })

      expect(onMessage).toHaveBeenCalledTimes(1)
      expect(onStatus).toHaveBeenCalledTimes(1)
      expect(onTaskResult).toHaveBeenCalledWith(
        'task-42',
        expect.objectContaining({
          caller: 'channel-reader',
          channelType: 'telegram',
          channelId: 'c1',
          sender: 'u1',
        })
      )
      expect(onCronResults).toHaveBeenCalledWith(
        expect.objectContaining({
          caller: 'channel-reader',
          channelType: 'telegram',
          channelId: 'c1',
          sender: 'u1',
        })
      )
      expect(onCronAck).toHaveBeenCalledWith(
        'task-42',
        expect.objectContaining({
          caller: 'channel-reader',
          channelType: 'telegram',
          channelId: 'c1',
          sender: 'u1',
        })
      )
    } finally {
      await server.stop()
    }
  })

  it('wires approve/deny routes to approval handler with correct decision shape', async () => {
    const onApproval = vi.fn(async () => ({ success: true }))
    const { server, baseUrl } = await startServer(rpcServer => {
      rpcServer.onApproval(onApproval)
    })

    try {
      const approveResp = await fetch(`${baseUrl}/v1/runtime/approvals/approve`, {
        method: 'POST',
        headers: channelReaderEdgeHeaders(
          { channelType: 'telegram', channelId: 'c1', sender: 'user-1' },
          { 'Content-Type': 'application/json' }
        ),
        body: JSON.stringify({
          userId: 'user-1',
          requestId: 'req-a',
          alwaysApprove: true,
          channelType: 'telegram',
          channelId: 'c1',
        }),
      })
      expect(approveResp.status).toBe(200)

      const denyResp = await fetch(`${baseUrl}/v1/runtime/approvals/deny`, {
        method: 'POST',
        headers: channelReaderEdgeHeaders(
          { channelType: 'telegram', channelId: 'c1', sender: 'user-1' },
          { 'Content-Type': 'application/json' }
        ),
        body: JSON.stringify({
          userId: 'user-1',
          requestId: 'req-b',
          alwaysApprove: true,
          channelType: 'telegram',
          channelId: 'c1',
        }),
      })
      expect(denyResp.status).toBe(200)

      expect(onApproval).toHaveBeenCalledTimes(2)
      expect(onApproval).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          userId: 'user-1',
          requestId: 'req-a',
          approved: true,
          alwaysApprove: true,
        })
      )
      expect(onApproval).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          userId: 'user-1',
          requestId: 'req-b',
          approved: false,
          alwaysApprove: false,
        })
      )
    } finally {
      await server.stop()
    }
  })

  it('uses rpc-proxy edge identity for approval routes and rejects missing edge user', async () => {
    const onApproval = vi.fn(async () => ({ success: true }))
    const { server, baseUrl } = await startServer(rpcServer => {
      rpcServer.onApproval(onApproval)
    })

    try {
      const ok = await fetch(`${baseUrl}/v1/runtime/approvals/approve`, {
        method: 'POST',
        headers: {
          ...rpcEdgeHeaders('edge-user-1'),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userId: 'body-user',
          requestId: 'req-rpc',
          alwaysApprove: true,
          channelType: 'telegram',
          channelId: 'tg-chat-1',
        }),
      })
      expect(ok.status).toBe(200)

      const missingUser = await fetch(`${baseUrl}/v1/runtime/approvals/deny`, {
        method: 'POST',
        headers: {
          'x-clerum-edge-caller': 'rpc-proxy',
          'x-clerum-edge-host-ref': 'chatllm',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userId: 'body-user',
          requestId: 'req-missing-user',
        }),
      })
      expect(missingUser.status).toBe(401)

      expect(onApproval).toHaveBeenCalledTimes(1)
      expect(onApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'edge-user-1',
          requestId: 'req-rpc',
          approved: true,
          alwaysApprove: true,
          channelType: 'rpc',
          channelId: 'chatllm',
        })
      )
    } finally {
      await server.stop()
    }
  })

  it('accepts provider workflow approval decisions without Authorization when workflow approval reader edge context matches', async () => {
    const onProviderDecision = vi.fn(async () => ({
      success: true,
      duplicate: false,
      status: 'approved',
      run: { id: 'run-1' },
    }))
    const { server, baseUrl } = await startServer(rpcServer => {
      rpcServer.onProviderWorkflowApprovalDecision(onProviderDecision)
    })

    try {
      const missingEdge = await fetch(`${baseUrl}/v1/runtime/workflow-approvals/decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approvalRequestId: '00000000-0000-0000-0000-000000000111',
          decision: 'approve',
          providerIdentity: {
            medium: 'slack',
            providerUserId: 'U123',
            providerWorkspaceId: 'T123',
            providerChannelId: 'C123',
            providerChannelType: 'private',
            providerEventId: 'slack:T123:C123:1700000001.000001',
          },
        }),
      })
      expect(missingEdge.status).toBe(401)

      const response = await fetch(`${baseUrl}/v1/runtime/workflow-approvals/decide`, {
        method: 'POST',
        headers: workflowApprovalReaderEdgeHeaders(
          { channelType: 'slack', channelId: 'C123', sender: 'U123' },
          { 'Content-Type': 'application/json' }
        ),
        body: JSON.stringify({
          approvalRequestId: '00000000-0000-0000-0000-000000000111',
          decision: 'approve',
          providerIdentity: {
            medium: 'slack',
            providerUserId: 'U123',
            providerWorkspaceId: 'T123',
            providerChannelId: 'C123',
            providerChannelType: 'private',
            providerEventId: 'slack:T123:C123:1700000001.000001',
          },
        }),
      })

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({
        success: true,
        duplicate: false,
        status: 'approved',
        run: { id: 'run-1' },
      })
      expect(onProviderDecision).toHaveBeenCalledWith({
        approvalRequestId: '00000000-0000-0000-0000-000000000111',
        decision: 'approve',
        providerIdentity: {
          medium: 'slack',
          providerUserId: 'U123',
          providerWorkspaceId: 'T123',
          providerChannelId: 'C123',
          providerChannelType: 'private',
          providerEventId: 'slack:T123:C123:1700000001.000001',
        },
        note: null,
      })
    } finally {
      await server.stop()
    }
  })

  it('routes provider workflow approval resolve through the channel-reader edge', async () => {
    const onProviderResolve = vi.fn(async () => ({
      status: 'ambiguous' as const,
    }))
    const { server, baseUrl } = await startServer(rpcServer => {
      rpcServer.onProviderWorkflowApprovalResolve(onProviderResolve)
    })

    try {
      const missingEdge = await fetch(`${baseUrl}/v1/runtime/workflow-approvals/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipeName: 'due-diligence',
          providerIdentity: {
            medium: 'telegram',
            providerUserId: '123456',
            providerChannelId: 'telegram-chat-1',
          },
        }),
      })
      expect(missingEdge.status).toBe(401)

      const response = await fetch(`${baseUrl}/v1/runtime/workflow-approvals/resolve`, {
        method: 'POST',
        headers: channelReaderEdgeHeaders(
          { channelType: 'telegram', channelId: 'telegram-chat-1', sender: '123456' },
          { 'Content-Type': 'application/json' }
        ),
        body: JSON.stringify({
          recipeName: 'due-diligence',
          providerIdentity: {
            medium: 'telegram',
            providerUserId: '123456',
            providerChannelId: 'telegram-chat-1',
          },
        }),
      })

      expect(response.status).toBe(409)
      await expect(response.json()).resolves.toEqual({
        error: 'pending_workflow_approval_ambiguous',
      })
      expect(onProviderResolve).toHaveBeenCalledWith({
        recipeName: 'due-diligence',
        providerIdentity: {
          medium: 'telegram',
          providerUserId: '123456',
          providerChannelId: 'telegram-chat-1',
        },
      })
    } finally {
      await server.stop()
    }
  })

  it('routes provider workflow result requests through the matching channel-reader edge', async () => {
    const onProviderWorkflowResult = vi.fn(async () => ({
      success: true,
      status: 'completed' as const,
      response: 'Workflow result is ready.',
    }))
    const { server, baseUrl } = await startServer(rpcServer => {
      rpcServer.onProviderWorkflowResultRequest(onProviderWorkflowResult)
    })
    const payload = {
      workflowName: 'due-diligence',
      providerIdentity: {
        medium: 'telegram',
        providerUserId: '123456',
        providerChannelId: 'telegram-chat-1',
        providerEventId: 'telegram-event-1',
      },
      source: {
        channelType: 'telegram',
        channelId: 'telegram-chat-1',
        sender: '123456',
        messageId: '77',
        timestamp: '2026-06-01T00:00:00.000Z',
      },
    }

    try {
      const missingEdge = await fetch(`${baseUrl}/v1/runtime/workflow-results/latest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      expect(missingEdge.status).toBe(401)

      const response = await fetch(`${baseUrl}/v1/runtime/workflow-results/latest`, {
        method: 'POST',
        headers: channelReaderEdgeHeaders(
          { channelType: 'telegram', channelId: 'telegram-chat-1', sender: '123456' },
          { 'Content-Type': 'application/json' }
        ),
        body: JSON.stringify(payload),
      })
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        success: true,
        response: 'Workflow result is ready.',
      })
      expect(onProviderWorkflowResult).toHaveBeenCalledWith(
        payload,
        expect.objectContaining({
          caller: 'channel-reader',
          channelType: 'telegram',
          channelId: 'telegram-chat-1',
          sender: '123456',
        })
      )

      const mismatchedSource = await fetch(`${baseUrl}/v1/runtime/workflow-results/latest`, {
        method: 'POST',
        headers: channelReaderEdgeHeaders(
          { channelType: 'telegram', channelId: 'other-chat', sender: '123456' },
          { 'Content-Type': 'application/json' }
        ),
        body: JSON.stringify(payload),
      })
      expect(mismatchedSource.status).toBe(403)
      expect(onProviderWorkflowResult).toHaveBeenCalledTimes(1)
    } finally {
      await server.stop()
    }
  })

  it('routes provider message authorization through the matching channel-reader edge', async () => {
    const onAuthorize = vi.fn(async () => ({ authorized: true }))
    const { server, baseUrl } = await startServer(rpcServer => {
      rpcServer.onProviderMessageAuthorization(onAuthorize)
    })
    const providerIdentity = {
      medium: 'telegram',
      providerUserId: '123456',
      providerChannelId: 'telegram-chat-1',
      providerChannelType: 'private',
      providerTarget: {
        hostRef: 'agent-a',
        communicationChannelNamespace: 'channels',
        communicationChannelName: 'agent-a-telegram',
      },
    }

    try {
      const response = await fetch(`${baseUrl}/v1/runtime/provider-messages/authorize`, {
        method: 'POST',
        headers: channelReaderEdgeHeaders(
          { channelType: 'telegram', channelId: 'telegram-chat-1', sender: '123456' },
          { 'Content-Type': 'application/json' }
        ),
        body: JSON.stringify({ providerIdentity }),
      })

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ authorized: true })
      expect(onAuthorize).toHaveBeenCalledWith({ providerIdentity })
    } finally {
      await server.stop()
    }
  })

  it('routes workflow approval notification claim and terminal updates through channel-reader edges', async () => {
    const onNotificationClaim = vi.fn(async () => ({
      deliveries: [
        {
          id: 'delivery-1',
          medium: 'telegram',
          providerUserId: '123456',
          providerChannelId: 'telegram-chat-1',
          attempts: 1,
          eventType: 'approval.updated',
          payload: {
            approvalRequestId: '00000000-0000-0000-0000-000000000111',
            recipeNamespace: 'sandbox-recipes',
            recipeName: 'research-summary-workflow',
            status: 'cancelled',
          },
        },
      ],
    }))
    const onNotificationTerminal = vi.fn(async () => ({ ok: true }))
    const { server, baseUrl } = await startServer(rpcServer => {
      rpcServer.onWorkflowApprovalNotificationClaim(onNotificationClaim)
      rpcServer.onWorkflowApprovalNotificationTerminal(onNotificationTerminal)
    })

    try {
      const missingEdge = await fetch(
        `${baseUrl}/v1/runtime/workflow-approval-notifications/claim`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            medium: 'telegram',
            providerChannelIds: ['telegram-chat-1'],
            hostRef: 'chatllm',
            limit: 10,
          }),
        }
      )
      expect(missingEdge.status).toBe(401)

      const claim = await fetch(`${baseUrl}/v1/runtime/workflow-approval-notifications/claim`, {
        method: 'POST',
        headers: channelReaderEdgeHeaders(
          { channelType: 'telegram', channelId: 'telegram-chat-1', sender: '123456' },
          { 'Content-Type': 'application/json' }
        ),
        body: JSON.stringify({
          medium: 'telegram',
          providerChannelIds: ['telegram-chat-1'],
          hostRef: 'chatllm',
          limit: 10,
        }),
      })
      expect(claim.status).toBe(200)
      await expect(claim.json()).resolves.toEqual({
        deliveries: [
          {
            id: 'delivery-1',
            medium: 'telegram',
            providerUserId: '123456',
            providerChannelId: 'telegram-chat-1',
            attempts: 1,
            eventType: 'approval.updated',
            payload: {
              approvalRequestId: '00000000-0000-0000-0000-000000000111',
              recipeNamespace: 'sandbox-recipes',
              recipeName: 'research-summary-workflow',
              status: 'cancelled',
            },
          },
        ],
      })

      const ack = await fetch(
        `${baseUrl}/v1/runtime/workflow-approval-notifications/deliveries/delivery-1/ack`,
        {
          method: 'POST',
          headers: channelReaderEdgeHeaders(
            { channelType: 'telegram', channelId: 'telegram-chat-1', sender: '123456' },
            { 'Content-Type': 'application/json' }
          ),
          body: JSON.stringify({
            medium: 'telegram',
            providerUserId: '123456',
            providerChannelId: 'telegram-chat-1',
            hostRef: 'chatllm',
          }),
        }
      )
      expect(ack.status).toBe(204)
      expect(onNotificationClaim).toHaveBeenCalledWith({
        medium: 'telegram',
        providerChannelIds: ['telegram-chat-1'],
        providerWorkspaceId: null,
        hostRef: 'chatllm',
        limit: 10,
      })
      expect(onNotificationTerminal).toHaveBeenCalledWith('delivery-1', 'ack', {
        medium: 'telegram',
        providerUserId: '123456',
        providerChannelId: 'telegram-chat-1',
        providerWorkspaceId: null,
        hostRef: 'chatllm',
      })

      const readerClaim = await fetch(
        `${baseUrl}/v1/runtime/workflow-approval-notifications/claim`,
        {
          method: 'POST',
          headers: workflowApprovalReaderEdgeHeaders(
            { channelType: 'telegram', channelId: 'notification-poll', sender: 'reader' },
            { 'Content-Type': 'application/json' }
          ),
          body: JSON.stringify({
            medium: 'telegram',
            providerChannelIds: ['telegram-chat-1'],
            hostRef: 'chatllm',
            limit: 10,
          }),
        }
      )
      expect(readerClaim.status).toBe(401)
      expect(onNotificationClaim).toHaveBeenCalledTimes(1)

      const unsupported = await fetch(
        `${baseUrl}/v1/runtime/workflow-approval-notifications/deliveries/delivery-1/done`,
        {
          method: 'POST',
          headers: channelReaderEdgeHeaders(
            { channelType: 'telegram', channelId: 'telegram-chat-1', sender: '123456' },
            { 'Content-Type': 'application/json' }
          ),
          body: JSON.stringify({
            medium: 'telegram',
            providerUserId: '123456',
            providerChannelId: 'telegram-chat-1',
            hostRef: 'chatllm',
          }),
        }
      )
      expect(unsupported.status).toBe(404)
      expect(onNotificationTerminal).toHaveBeenCalledTimes(1)
    } finally {
      await server.stop()
    }
  })

  it('routes Telegram provider verification through channel-reader edge', async () => {
    const onTelegramVerification = vi.fn(async () => ({
      ok: true as const,
      accountId: 'account-1',
    }))
    const { server, baseUrl } = await startServer(rpcServer => {
      rpcServer.onTelegramWorkflowApprovalVerification(onTelegramVerification)
    })

    try {
      const response = await fetch(
        `${baseUrl}/v1/runtime/workflow-approval-mediums/telegram/challenges/confirm-provider-event`,
        {
          method: 'POST',
          headers: channelReaderEdgeHeaders(
            { channelType: 'telegram', channelId: '123456', sender: '123456' },
            { 'Content-Type': 'application/json' }
          ),
          body: JSON.stringify({
            code: '123456',
            providerUserId: '123456',
            providerChannelId: '123456',
            providerChannelType: 'private',
            providerTarget: {
              hostRef: 'chatllm',
              communicationChannelNamespace: 'channels',
              communicationChannelName: 'groupevenfire',
            },
          }),
        }
      )

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ ok: true, accountId: 'account-1' })
      expect(onTelegramVerification).toHaveBeenCalledWith({
        code: '123456',
        providerUserId: '123456',
        providerChannelId: '123456',
        providerChannelType: 'private',
        providerTarget: {
          hostRef: 'chatllm',
          communicationChannelNamespace: 'channels',
          communicationChannelName: 'groupevenfire',
        },
        providerTargets: [
          {
            hostRef: 'chatllm',
            communicationChannelNamespace: 'channels',
            communicationChannelName: 'groupevenfire',
          },
        ],
      })
    } finally {
      await server.stop()
    }
  })

  it('rejects Telegram provider verification when the primary providerTarget is invalid', async () => {
    const onTelegramVerification = vi.fn(async () => ({
      ok: true as const,
      accountId: 'account-1',
    }))
    const { server, baseUrl } = await startServer(rpcServer => {
      rpcServer.onTelegramWorkflowApprovalVerification(onTelegramVerification)
    })

    try {
      const response = await fetch(
        `${baseUrl}/v1/runtime/workflow-approval-mediums/telegram/challenges/confirm-provider-event`,
        {
          method: 'POST',
          headers: channelReaderEdgeHeaders(
            { channelType: 'telegram', channelId: '123456', sender: '123456' },
            { 'Content-Type': 'application/json' }
          ),
          body: JSON.stringify({
            code: '123456',
            providerUserId: '123456',
            providerChannelId: '123456',
            providerChannelType: 'private',
            providerTarget: {
              hostRef: '',
              communicationChannelNamespace: 'channels',
              communicationChannelName: 'groupevenfire',
            },
            providerTargets: [
              {
                hostRef: 'chatllm',
                communicationChannelNamespace: 'channels',
                communicationChannelName: 'groupevenfire',
              },
            ],
          }),
        }
      )

      expect(response.status).toBe(400)
      expect(onTelegramVerification).not.toHaveBeenCalled()
    } finally {
      await server.stop()
    }
  })

  it('rejects unsupported provider media on the workflow approval decision route', async () => {
    const onProviderDecision = vi.fn(async () => ({ success: true, duplicate: false }))
    const { server, baseUrl } = await startServer(rpcServer => {
      rpcServer.onProviderWorkflowApprovalDecision(onProviderDecision)
    })

    try {
      const response = await fetch(`${baseUrl}/v1/runtime/workflow-approvals/decide`, {
        method: 'POST',
        headers: workflowApprovalReaderEdgeHeaders(
          { channelType: 'telegram', channelId: 'guild', sender: 'D123' },
          { 'Content-Type': 'application/json' }
        ),
        body: JSON.stringify({
          approvalRequestId: '00000000-0000-0000-0000-000000000111',
          decision: 'approve',
          providerIdentity: {
            medium: 'discord',
            providerUserId: 'D123',
            providerEventId: 'discord:guild:channel:42',
          },
        }),
      })

      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toEqual({ error: 'providerIdentity is required' })
      expect(onProviderDecision).not.toHaveBeenCalled()
    } finally {
      await server.stop()
    }
  })

  it('rejects provider workflow approval decisions without stable channel identity', async () => {
    const onProviderDecision = vi.fn(async () => ({ success: true, duplicate: false }))
    const { server, baseUrl } = await startServer(rpcServer => {
      rpcServer.onProviderWorkflowApprovalDecision(onProviderDecision)
    })

    try {
      const response = await fetch(`${baseUrl}/v1/runtime/workflow-approvals/decide`, {
        method: 'POST',
        headers: workflowApprovalReaderEdgeHeaders(
          { channelType: 'telegram', channelId: 'tg-chat-1', sender: '123456' },
          { 'Content-Type': 'application/json' }
        ),
        body: JSON.stringify({
          approvalRequestId: '00000000-0000-0000-0000-000000000111',
          decision: 'approve',
          providerIdentity: {
            medium: 'telegram',
            providerUserId: '123456',
            providerEventId: 'telegram:tg-chat-1:42',
          },
        }),
      })

      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toEqual({ error: 'providerIdentity is required' })
      expect(onProviderDecision).not.toHaveBeenCalled()
    } finally {
      await server.stop()
    }
  })

  it('rejects Slack provider workflow approval decisions without stable workspace identity', async () => {
    const onProviderDecision = vi.fn(async () => ({ success: true, duplicate: false }))
    const { server, baseUrl } = await startServer(rpcServer => {
      rpcServer.onProviderWorkflowApprovalDecision(onProviderDecision)
    })

    try {
      const response = await fetch(`${baseUrl}/v1/runtime/workflow-approvals/decide`, {
        method: 'POST',
        headers: workflowApprovalReaderEdgeHeaders(
          { channelType: 'slack', channelId: 'C123', sender: 'U123' },
          { 'Content-Type': 'application/json' }
        ),
        body: JSON.stringify({
          approvalRequestId: '00000000-0000-0000-0000-000000000111',
          decision: 'approve',
          providerIdentity: {
            medium: 'slack',
            providerUserId: 'U123',
            providerChannelId: 'C123',
            providerEventId: 'slack:T123:C123:1700000001.000001',
          },
        }),
      })

      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toEqual({ error: 'providerIdentity is required' })
      expect(onProviderDecision).not.toHaveBeenCalled()
    } finally {
      await server.stop()
    }
  })

  it('enforces channel-reader and workflow approval reader edge context for provider workflow approval decisions when runtime auth is enabled', async () => {
    const runtimeHost = 'sandbox-recipes/very-long-runtime-recipe'
    const runtimeAlias = `sandbox-recipes/~${createHash('sha256')
      .update(runtimeHost)
      .digest('hex')
      .slice(0, 16)}`
    const originalEnv = {
      enableAuth: process.env.CLERUM_ENABLE_AUTH,
      hostName: process.env.CLERUM_HOST_NAME,
    }
    process.env.CLERUM_ENABLE_AUTH = 'true'
    process.env.CLERUM_HOST_NAME = runtimeHost
    vi.resetModules()

    const { RPCServer } = await import('../server')
    const onProviderDecision = vi.fn(async () => ({ success: true, duplicate: false }))
    const server = new RPCServer(0)
    server.onProviderWorkflowApprovalDecision(onProviderDecision)
    await server.start()
    const address = (
      server as unknown as { server: { address: () => AddressInfo } }
    ).server.address()
    const baseUrl = `http://127.0.0.1:${address.port}`
    const body = JSON.stringify({
      approvalRequestId: '00000000-0000-0000-0000-000000000111',
      decision: 'approve',
      providerIdentity: {
        medium: 'telegram',
        providerUserId: '123456',
        providerChannelId: 'tg-chat-1',
        providerChannelType: 'group',
        providerEventId: 'telegram:tg-chat-1:42',
      },
    })

    try {
      const missingEdge = await fetch(`${baseUrl}/v1/runtime/workflow-approvals/decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
      expect(missingEdge.status).toBe(401)
      await expect(missingEdge.json()).resolves.toEqual({
        error: 'Missing runtime edge caller context',
      })

      const unexpectedBearer = await fetch(`${baseUrl}/v1/runtime/workflow-approvals/decide`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          authorization: ['Bearer', 'unexpected'].join(' '),
          'x-clerum-edge-caller': 'channel-reader',
          'x-clerum-edge-host-ref': runtimeHost,
        },
        body,
      })
      expect(unexpectedBearer.status).toBe(401)

      const wrongHost = await fetch(`${baseUrl}/v1/runtime/workflow-approvals/decide`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-clerum-edge-caller': 'workflow-approval-request-reader',
          'x-clerum-edge-host-ref': 'other-host',
        },
        body,
      })
      expect(wrongHost.status).toBe(403)
      await expect(wrongHost.json()).resolves.toEqual({ error: 'Runtime edge host mismatch' })

      const wrongCaller = await fetch(`${baseUrl}/v1/runtime/workflow-approvals/decide`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-clerum-edge-caller': 'rpc-proxy',
          'x-clerum-edge-host-ref': runtimeHost,
        },
        body,
      })
      expect(wrongCaller.status).toBe(401)

      const channelReaderOk = await fetch(`${baseUrl}/v1/runtime/workflow-approvals/decide`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-clerum-edge-caller': 'channel-reader',
          'x-clerum-edge-host-ref': runtimeHost,
          'x-clerum-edge-channel-type': 'telegram',
          'x-clerum-edge-channel-id': 'tg-chat-1',
          'x-clerum-edge-sender': '123456',
        },
        body,
      })
      expect(channelReaderOk.status).toBe(200)
      expect(onProviderDecision).toHaveBeenCalledTimes(1)

      const wrongSource = await fetch(`${baseUrl}/v1/runtime/workflow-approvals/decide`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-clerum-edge-caller': 'workflow-approval-request-reader',
          'x-clerum-edge-host-ref': runtimeHost,
          'x-clerum-edge-channel-type': 'telegram',
          'x-clerum-edge-channel-id': 'other-chat',
          'x-clerum-edge-sender': '123456',
        },
        body,
      })
      expect(wrongSource.status).toBe(403)
      await expect(wrongSource.json()).resolves.toEqual({ error: 'Runtime edge source mismatch' })

      const ok = await fetch(`${baseUrl}/v1/runtime/workflow-approvals/decide`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-clerum-edge-caller': 'workflow-approval-request-reader',
          'x-clerum-edge-host-ref': runtimeHost,
          'x-clerum-edge-channel-type': 'telegram',
          'x-clerum-edge-channel-id': 'tg-chat-1',
          'x-clerum-edge-sender': '123456',
        },
        body,
      })
      expect(ok.status).toBe(200)
      expect(onProviderDecision).toHaveBeenCalledTimes(2)

      const aliasOk = await fetch(`${baseUrl}/v1/runtime/workflow-approvals/decide`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-clerum-edge-caller': 'workflow-approval-request-reader',
          'x-clerum-edge-host-ref': runtimeAlias,
          'x-clerum-edge-channel-type': 'telegram',
          'x-clerum-edge-channel-id': 'tg-chat-1',
          'x-clerum-edge-sender': '123456',
        },
        body,
      })
      expect(aliasOk.status).toBe(200)
      expect(onProviderDecision).toHaveBeenCalledTimes(3)
      expect(onProviderDecision).toHaveBeenLastCalledWith({
        approvalRequestId: '00000000-0000-0000-0000-000000000111',
        decision: 'approve',
        providerIdentity: {
          medium: 'telegram',
          providerUserId: '123456',
          providerChannelId: 'tg-chat-1',
          providerChannelType: 'group',
          providerEventId: 'telegram:tg-chat-1:42',
        },
        note: null,
      })
    } finally {
      await server.stop()
      if (originalEnv.enableAuth === undefined) delete process.env.CLERUM_ENABLE_AUTH
      else process.env.CLERUM_ENABLE_AUTH = originalEnv.enableAuth
      if (originalEnv.hostName === undefined) delete process.env.CLERUM_HOST_NAME
      else process.env.CLERUM_HOST_NAME = originalEnv.hostName
      vi.resetModules()
    }
  })

  it('returns deterministic no-handler responses for all callback-backed routes', async () => {
    const { server, baseUrl } = await startServer()
    try {
      const messageResp = await fetch(`${baseUrl}/v1/runtime/messages`, {
        method: 'POST',
        headers: channelReaderEdgeHeaders(
          { channelType: 'telegram', channelId: 'c1', sender: 'u1' },
          { 'Content-Type': 'application/json' }
        ),
        body: JSON.stringify({
          content: 'hi',
          channelType: 'telegram',
          channelId: 'c1',
          sender: 'u1',
          timestamp: new Date().toISOString(),
          messageId: 'm1',
          hostRef: 'chatllm',
        }),
      })
      expect(messageResp.status).toBe(500)

      const approveResp = await fetch(`${baseUrl}/v1/runtime/approvals/approve`, {
        method: 'POST',
        headers: channelReaderEdgeHeaders(
          { channelType: 'telegram', channelId: 'c1', sender: 'u1' },
          { 'Content-Type': 'application/json' }
        ),
        body: JSON.stringify({
          userId: 'u1',
          requestId: 'r1',
          channelType: 'telegram',
          channelId: 'c1',
        }),
      })
      expect(approveResp.status).toBe(501)

      const providerDecisionResp = await fetch(`${baseUrl}/v1/runtime/workflow-approvals/decide`, {
        method: 'POST',
        headers: workflowApprovalReaderEdgeHeaders(
          { channelType: 'telegram', channelId: 'tg-chat-1', sender: '123456' },
          { 'Content-Type': 'application/json' }
        ),
        body: JSON.stringify({
          approvalRequestId: '00000000-0000-0000-0000-000000000111',
          decision: 'approve',
          providerIdentity: {
            medium: 'telegram',
            providerUserId: '123456',
            providerChannelId: 'tg-chat-1',
            providerEventId: 'telegram:tg-chat-1:42',
          },
        }),
      })
      expect(providerDecisionResp.status).toBe(501)

      const taskResp = await fetch(`${baseUrl}/v1/runtime/tasks/task-1/result`, {
        headers: channelReaderEdgeHeaders({
          channelType: 'telegram',
          channelId: 'c1',
          sender: 'u1',
        }),
      })
      expect(taskResp.status).toBe(501)

      const cronReadResp = await fetch(`${baseUrl}/v1/runtime/cron/results`, {
        headers: channelReaderEdgeHeaders({
          channelType: 'telegram',
          channelId: 'c1',
          sender: 'u1',
        }),
      })
      expect(cronReadResp.status).toBe(501)

      const cronAckResp = await fetch(`${baseUrl}/v1/runtime/cron/results/task-1`, {
        method: 'DELETE',
        headers: channelReaderEdgeHeaders({
          channelType: 'telegram',
          channelId: 'c1',
          sender: 'u1',
        }),
      })
      expect(cronAckResp.status).toBe(501)
    } finally {
      await server.stop()
    }
  })
})
