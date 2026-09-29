import { describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import { DirectServiceAdmission } from '../server/directServiceAdmission'

describe('DirectServiceAdmission', () => {
  it('uses one fixed 60-second bucket and admits exactly 600 requests', () => {
    const admission = new DirectServiceAdmission()
    for (let index = 0; index < 600; index += 1) {
      expect(admission.admit(120_001)).toEqual({ allowed: true })
    }
    expect(admission.admit(120_002)).toEqual({ allowed: false, retryAfterSeconds: 60 })
    expect(admission.admit(179_999)).toEqual({ allowed: false, retryAfterSeconds: 1 })
    expect(admission.admit(180_000)).toEqual({ allowed: true })
  })
})

describe('direct trusted service runtime admission', () => {
  it('bounds real channel-reader producer requests before message work', async () => {
    process.env.CLERUM_ENABLE_AUTH = 'false'
    process.env.CLERUM_HOST_NAME = 'chatllm'
    process.env.CLERUM_DEV_MODE = 'true'
    process.env.CLERUM_HOST_REF = 'chatllm'
    process.env.LOG_LEVEL = 'silent'
    process.env.MCP_HOST_RPC_PROXY_EDGE_TOKEN = 'dev-rpc-proxy-mcp-host-edge-token'
    process.env.RPC_PROXY_MCP_HOST_EDGE_TOKEN = 'dev-rpc-proxy-mcp-host-edge-token'
    vi.resetModules()

    const { RPCServer } = await import('../server')
    const { RPCClient } = await import('../../../channel-reader/src/rpcClient')
    const { submitMcpHostDecision } =
      await import('../../../workflow-approval-request-reader/src/mcpHostClient')
    const server = new RPCServer(0)
    const messageHandler = vi.fn(async () => ({ success: true, status: 'completed' as const }))
    const decisionHandler = vi.fn(async () => ({
      success: false,
      duplicate: false,
      error: 'denied',
    }))
    server.onMessage(messageHandler)
    server.onProviderWorkflowApprovalDecision(decisionHandler)
    await server.start()
    const address = (
      server as unknown as { server: { address: () => AddressInfo } }
    ).server.address()
    const client = new RPCClient(`http://127.0.0.1:${address.port}`)
    const quiet = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const quietError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      const invalid = await client.sendMessage({
        content: undefined as unknown as string,
        channelType: 'slack',
        channelId: 'invalid-channel',
        sender: 'invalid-sender',
        timestamp: new Date(),
        messageId: 'invalid-message',
      })
      expect(invalid.success).toBe(false)
      expect(invalid.error?.message).toContain('HTTP 400')
      expect(messageHandler).not.toHaveBeenCalled()

      const forgedRpcProxy = await fetch(`http://127.0.0.1:${address.port}/v1/runtime/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-clerum-edge-caller': 'rpc-proxy',
          'x-clerum-edge-host-ref': 'chatllm',
          'x-clerum-edge-user-id': 'verified-user',
        },
        body: JSON.stringify({
          content: 'forged rpc edge',
          channelType: 'rpc',
          channelId: 'chat-1',
          sender: 'forged-sender',
          timestamp: new Date().toISOString(),
          messageId: 'forged-rpc-message',
          hostRef: 'chatllm',
        }),
      })
      expect(forgedRpcProxy.status).toBe(401)
      expect(messageHandler).not.toHaveBeenCalled()

      const originalFetch = globalThis.fetch.bind(globalThis)
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('/rpc/access/users/verified-user/mcp-hosts/chatllm')) {
          return new Response(
            JSON.stringify({
              userId: 'verified-user',
              hostRef: 'chatllm',
              url: `http://127.0.0.1:${address.port}`,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        }
        return originalFetch(input, init)
      })
      let rpcProxyHeaders: Record<string, string> = {}
      try {
        const { resolveHostConnectionForUser } =
          await import('../../../rpc-proxy/src/services/mcpProxyService')
        const connection = await resolveHostConnectionForUser(
          'verified-user',
          'chatllm',
          'producer-backed-rpc-access-token'
        )
        expect(connection).not.toBeNull()
        rpcProxyHeaders = connection!.headers
      } finally {
        vi.stubGlobal('fetch', originalFetch)
      }
      const rpcProxy = await fetch(`http://127.0.0.1:${address.port}/v1/runtime/messages`, {
        method: 'POST',
        headers: {
          ...rpcProxyHeaders,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content: 'legacy rpc ingress',
          channelType: 'rpc',
          channelId: 'chat-1',
          sender: 'untrusted-body-sender',
          timestamp: new Date().toISOString(),
          messageId: 'rpc-message',
          hostRef: 'chatllm',
        }),
      })
      expect(rpcProxy.status).toBe(200)

      for (let index = 0; index < 599; index += 1) {
        const result = await client.sendMessage({
          content: 'hello',
          channelType: 'slack',
          channelId: `channel-${index}`,
          sender: `sender-${index}`,
          timestamp: new Date(),
          messageId: `message-${index}`,
        })
        expect(result.success).toBe(true)
      }

      const workflowResult = await submitMcpHostDecision(
        {
          port: 0,
          mcpHostBaseUrl: `http://127.0.0.1:${address.port}`,
          mcpHostRef: 'chatllm',
          mcpHostTargets: [{ hostRef: 'chatllm', baseUrl: `http://127.0.0.1:${address.port}` }],
          enabledMedia: new Set(['slack']),
          mcpHostTimeoutMs: 5_000,
          mcpHostMessageTimeoutMs: 5_000,
          rateLimitWindowMs: 60_000,
          rateLimitMaxRequests: 120,
          controlApiBaseUrl: '',
          controlApiToken: '',
          controlApiTimeoutMs: 5_000,
          channelReaderUrlTemplate: '',
          channelReaderHandoffToken: '',
          channelReaderHandoffTimeoutMs: 5_000,
        },
        {
          approvalRequestId: '4dd2d3d8-7664-4e3e-bd59-2be3357bd036',
          mcpHostRef: 'chatllm',
          medium: 'slack',
          providerUserId: 'U123',
          providerWorkspaceId: 'T123',
          providerChannelId: 'C123',
          providerEventId: 'event-1',
          decision: 'approve',
        }
      )
      expect(workflowResult).toMatchObject({ ok: false, status: 409, error: 'denied' })
      expect(decisionHandler).toHaveBeenCalledTimes(1)

      const denied = await fetch(`http://127.0.0.1:${address.port}/v1/runtime/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-clerum-edge-caller': 'channel-reader',
          'x-clerum-edge-host-ref': 'chatllm',
          'x-clerum-edge-channel-type': 'slack',
          'x-clerum-edge-channel-id': 'channel-over-limit',
          'x-clerum-edge-sender': 'sender-over-limit',
        },
        body: JSON.stringify({
          content: 'hello',
          channelType: 'slack',
          channelId: 'channel-over-limit',
          sender: 'sender-over-limit',
          timestamp: new Date().toISOString(),
          messageId: 'message-over-limit',
        }),
      })

      expect(denied.status).toBe(429)
      expect(denied.headers.get('retry-after')).toMatch(/^[1-9]\d*$/)
      expect(await denied.json()).toEqual({
        error: 'runtime_service_admission_limited',
        retryAfterSeconds: expect.any(Number),
      })
      expect(messageHandler).toHaveBeenCalledTimes(600)
    } finally {
      quiet.mockRestore()
      quietError.mockRestore()
      await server.stop()
    }
  }, 30_000)
})
