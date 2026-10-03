import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { DirectServiceAdmission } from '../server/directServiceAdmission'

type ChannelReaderMessage = {
  content: string
  channelType: 'slack'
  channelId: string
  sender: string
  timestamp: Date
  messageId: string
}

type WorkflowReaderConfig = {
  port: number
  mcpHostBaseUrl: string
  mcpHostRef: string
  mcpHostTargets: Array<{ hostRef: string; baseUrl: string }>
  enabledMedia: Set<string>
  mcpHostTimeoutMs: number
  mcpHostMessageTimeoutMs: number
  rateLimitWindowMs: number
  rateLimitMaxRequests: number
  controlApiBaseUrl: string
  controlApiToken: string
  controlApiTimeoutMs: number
  channelReaderUrlTemplate: string
  channelReaderHandoffToken: string
  channelReaderHandoffTimeoutMs: number
}

const runtimeTestEnvironmentKeys = [
  'CLERUM_ENABLE_AUTH',
  'CLERUM_HOST_NAME',
  'CLERUM_DEV_MODE',
  'CLERUM_HOST_REF',
  'LOG_LEVEL',
  'MCP_HOST_RPC_PROXY_EDGE_TOKEN',
  'RPC_PROXY_MCP_HOST_EDGE_TOKEN',
] as const

let runtimeTestEnvironmentBefore: Map<string, string | undefined> | undefined

afterEach(() => {
  if (!runtimeTestEnvironmentBefore) return
  for (const [key, value] of runtimeTestEnvironmentBefore) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  runtimeTestEnvironmentBefore = undefined
})

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
    runtimeTestEnvironmentBefore = new Map(
      runtimeTestEnvironmentKeys.map(key => [key, process.env[key]])
    )
    process.env.CLERUM_ENABLE_AUTH = 'false'
    process.env.CLERUM_HOST_NAME = 'chatllm'
    process.env.CLERUM_DEV_MODE = 'true'
    process.env.CLERUM_HOST_REF = 'chatllm'
    process.env.LOG_LEVEL = 'silent'
    process.env.MCP_HOST_RPC_PROXY_EDGE_TOKEN = 'dev-rpc-proxy-mcp-host-edge-token'
    process.env.RPC_PROXY_MCP_HOST_EDGE_TOKEN = 'dev-rpc-proxy-mcp-host-edge-token'
    vi.resetModules()

    const { RPCServer } = await import('../server')
    const channelReaderModule = resolve(process.cwd(), '../channel-reader/src/rpcClient.ts')
    const { RPCClient } = (await import(channelReaderModule)) as {
      RPCClient: new (baseUrl: string) => {
        sendMessage: (message: ChannelReaderMessage) => Promise<{
          success: boolean
          error?: {
            code?: string
            message?: string
            retryable?: boolean
            retryAfterSeconds?: number
          }
        }>
      }
    }
    const workflowReaderModule = resolve(
      process.cwd(),
      '../workflow-approval-request-reader/src/mcpHostClient.ts'
    )
    const { submitMcpHostDecision } = (await import(workflowReaderModule)) as {
      submitMcpHostDecision: (
        config: WorkflowReaderConfig,
        command: {
          approvalRequestId: string
          mcpHostRef: string
          medium: 'slack'
          providerUserId: string
          providerWorkspaceId: string
          providerChannelId: string
          providerEventId: string
          decision: 'approve'
        }
      ) => Promise<{
        ok: boolean
        status?: number
        error?: string
      }>
    }
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
    const admissionClock = vi.spyOn(Date, 'now').mockReturnValue(120_001)
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
        const rpcProxyModule = resolve(
          process.cwd(),
          '../rpc-proxy/src/services/mcpProxyService.ts'
        )
        const { resolveHostConnectionForUser } = (await import(rpcProxyModule)) as {
          resolveHostConnectionForUser: (
            userId: string,
            hostRef: string,
            rpcAccessToken: string
          ) => Promise<{ headers: Record<string, string> } | null>
        }
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

      const denied = await client.sendMessage({
        content: 'hello',
        channelType: 'slack',
        channelId: 'channel-over-limit',
        sender: 'sender-over-limit',
        timestamp: new Date(),
        messageId: 'message-over-limit',
      })

      expect(denied).toMatchObject({
        success: false,
        error: {
          code: 'RUNTIME_SERVICE_ADMISSION_LIMITED',
          message: 'MCP Host service admission temporarily limited this request',
          retryable: true,
          provider: 'mcp-host',
          retryAfterSeconds: expect.any(Number),
        },
      })
      expect(denied.error?.retryAfterSeconds).toBeGreaterThanOrEqual(1)
      expect(denied.error?.retryAfterSeconds).toBeLessThanOrEqual(60)
      expect(messageHandler).toHaveBeenCalledTimes(600)

      admissionClock.mockReturnValue(180_000)
      const afterRollover = await client.sendMessage({
        content: 'next fixed window',
        channelType: 'slack',
        channelId: 'channel-next-window',
        sender: 'sender-next-window',
        timestamp: new Date(),
        messageId: 'message-next-window',
      })
      expect(afterRollover.success).toBe(true)
      expect(messageHandler).toHaveBeenCalledTimes(601)
    } finally {
      admissionClock.mockRestore()
      quiet.mockRestore()
      quietError.mockRestore()
      await server.stop()
    }
  }, 30_000)
})
