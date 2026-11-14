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

      const forgedRpcProxyV2 = await fetch(`http://127.0.0.1:${address.port}/v1/runtime/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-clerum-edge-caller': 'rpc-proxy',
          'x-clerum-edge-host-ref': 'chatllm',
          'x-clerum-edge-user-id': 'verified-user',
          'x-clerum-edge-action-context': 'forged-v2-envelope',
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
      expect(forgedRpcProxyV2.status).toBe(401)
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

const APPROVAL_REQUEST_ID = '4dd2d3d8-7664-4e3e-bd59-2be3357bd036'
const SLACK_SOURCE = { channelType: 'slack', channelId: 'C123', sender: 'U123' } as const
const TELEGRAM_SOURCE = { channelType: 'telegram', channelId: '-1001', sender: '42' } as const
const SLACK_IDENTITY = {
  medium: 'slack',
  providerUserId: 'U123',
  providerChannelId: 'C123',
  providerWorkspaceId: 'T123',
} as const

type RuntimeSource = { channelType: string; channelId: string; sender: string }

type ChannelReaderClient = {
  sendMessage: (message: ChannelReaderMessage) => Promise<{
    success: boolean
    error?: { code?: string; retryAfterSeconds?: number }
  }>
  getTaskResult: (taskId: string, source?: RuntimeSource) => Promise<unknown>
  getCronResults: () => Promise<unknown[]>
  acknowledgeCronResult: (taskId: string, source: RuntimeSource) => Promise<void>
  fetchDeliveries: (params: {
    medium: 'slack'
    providerChannelIds: string[]
    hostRef: string
    limit: number
  }) => Promise<unknown[]>
  acknowledge: (
    id: string,
    params: { medium: 'slack'; providerUserId: string; providerChannelId: string; hostRef: string }
  ) => Promise<void>
  fail: (
    id: string,
    params: { medium: 'slack'; providerUserId: string; providerChannelId: string; hostRef: string }
  ) => Promise<void>
}

/**
 * A real MCP Host with a recording handler behind each of the fourteen
 * direct trusted service routes, plus the real channel-reader clients.
 */
async function bootHostWithEveryDirectRoute() {
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
  const { RPCClient } = (await import(
    resolve(process.cwd(), '../channel-reader/src/rpcClient.ts')
  )) as { RPCClient: new (baseUrl: string) => ChannelReaderClient }
  const { createProgressStream } = (await import(
    resolve(process.cwd(), '../channel-reader/src/progressClient.ts')
  )) as {
    createProgressStream: (options: {
      mcpHostUrl: string
      taskId: string
      onProgress: () => void
      onSuspended: () => void
      onTerminal: (data: { taskId: string; status: string }) => void
      onError: (error: string) => void
      source?: RuntimeSource
    }) => { close: () => void }
  }

  const handlers = {
    message: vi.fn(async () => ({ success: true, status: 'completed' as const })),
    approval: vi.fn(async () => ({ success: true })),
    providerMessageAuthorization: vi.fn(async () => ({ authorized: true })),
    decision: vi.fn(async () => ({ success: true, duplicate: false })),
    resolve: vi.fn(async () => ({
      status: 'found' as const,
      approvalRequestId: APPROVAL_REQUEST_ID,
    })),
    resultRequest: vi.fn(async () => ({ success: true, response: 'latest result' })),
    notificationClaim: vi.fn(async () => ({ deliveries: [] })),
    notificationTerminal: vi.fn(async () => ({ ok: true })),
    enrollment: vi.fn(async () => ({ ok: true })),
    telegramVerification: vi.fn(async () => ({ ok: true as const, accountId: 'account-1' })),
    taskResult: vi.fn(async () => ({ success: true, response: 'task result' })),
    cronResults: vi.fn(() => []),
    cronResultAck: vi.fn(() => true),
    progressStream: vi.fn(
      (
        taskId: string,
        onEvent: (event: { type: 'terminal'; data: Record<string, unknown> }) => void
      ) => {
        const timer = setTimeout(() => {
          onEvent({ type: 'terminal', data: { taskId, status: 'completed' } })
        }, 0)
        return { unsubscribe: () => clearTimeout(timer) }
      }
    ),
  }
  const server = new RPCServer(0)
  server.onMessage(handlers.message)
  server.onApproval(handlers.approval)
  server.onProviderMessageAuthorization(handlers.providerMessageAuthorization)
  server.onProviderWorkflowApprovalDecision(handlers.decision)
  server.onProviderWorkflowApprovalResolve(handlers.resolve)
  server.onProviderWorkflowResultRequest(handlers.resultRequest)
  server.onWorkflowApprovalNotificationClaim(handlers.notificationClaim)
  server.onWorkflowApprovalNotificationTerminal(handlers.notificationTerminal)
  server.onWorkflowApprovalMediumEnrollment(handlers.enrollment)
  server.onTelegramWorkflowApprovalVerification(handlers.telegramVerification)
  server.onTaskResult(handlers.taskResult as never)
  server.onCronResults(handlers.cronResults)
  server.onCronResultAck(handlers.cronResultAck)
  server.onProgressStream(handlers.progressStream as never)
  await server.start()
  const address = (server as unknown as { server: { address: () => AddressInfo } }).server.address()
  const baseUrl = `http://127.0.0.1:${address.port}`
  return {
    server,
    baseUrl,
    handlers,
    client: new RPCClient(baseUrl),
    createProgressStream,
  }
}

function slackMessage(id: string): ChannelReaderMessage {
  return {
    content: 'hello',
    channelType: 'slack',
    channelId: `channel-${id}`,
    sender: `sender-${id}`,
    timestamp: new Date(),
    messageId: `message-${id}`,
  }
}

async function fillDirectServiceBucket(client: ChannelReaderClient): Promise<void> {
  for (let index = 0; index < 600; index += 1) {
    const result = await client.sendMessage(slackMessage(`fill-${index}`))
    expect(result.success).toBe(true)
  }
  // Witness that the bucket is full.
  const refused = await client.sendMessage(slackMessage('fill-witness'))
  expect(refused).toMatchObject({
    success: false,
    error: { code: 'RUNTIME_SERVICE_ADMISSION_LIMITED' },
  })
}

type HandlerName = keyof Awaited<ReturnType<typeof bootHostWithEveryDirectRoute>>['handlers']

type DirectRouteRow = {
  name: string
  charged: boolean
  handler: HandlerName
  method: 'GET' | 'POST' | 'DELETE'
  path: string
  source?: RuntimeSource
  body?: Record<string, unknown>
  stream?: true
}

const DIRECT_ROUTE_ROWS: DirectRouteRow[] = [
  {
    name: 'POST /v1/runtime/messages',
    charged: true,
    handler: 'message',
    method: 'POST',
    path: '/v1/runtime/messages',
    source: SLACK_SOURCE,
    body: {
      content: 'table row',
      ...SLACK_SOURCE,
      timestamp: '2026-01-01T00:00:00.000Z',
      messageId: 'table-message',
    },
  },
  {
    name: 'POST /v1/runtime/approvals/approve',
    charged: true,
    handler: 'approval',
    method: 'POST',
    path: '/v1/runtime/approvals/approve',
    source: SLACK_SOURCE,
    body: { userId: 'U123', requestId: 'tool-request-1', channelType: 'slack', channelId: 'C123' },
  },
  {
    name: 'POST /v1/runtime/approvals/deny',
    charged: true,
    handler: 'approval',
    method: 'POST',
    path: '/v1/runtime/approvals/deny',
    source: SLACK_SOURCE,
    body: { userId: 'U123', requestId: 'tool-request-2', channelType: 'slack', channelId: 'C123' },
  },
  {
    name: 'POST /v1/runtime/provider-messages/authorize',
    charged: true,
    handler: 'providerMessageAuthorization',
    method: 'POST',
    path: '/v1/runtime/provider-messages/authorize',
    source: SLACK_SOURCE,
    body: { providerIdentity: SLACK_IDENTITY },
  },
  {
    name: 'POST /v1/runtime/workflow-approvals/decide',
    charged: true,
    handler: 'decision',
    method: 'POST',
    path: '/v1/runtime/workflow-approvals/decide',
    source: SLACK_SOURCE,
    body: {
      approvalRequestId: APPROVAL_REQUEST_ID,
      decision: 'approve',
      providerIdentity: { ...SLACK_IDENTITY, providerEventId: 'event-1' },
    },
  },
  {
    name: 'POST /v1/runtime/workflow-approvals/resolve',
    charged: true,
    handler: 'resolve',
    method: 'POST',
    path: '/v1/runtime/workflow-approvals/resolve',
    source: SLACK_SOURCE,
    body: { recipeName: 'daily-report', providerIdentity: SLACK_IDENTITY },
  },
  {
    name: 'POST /v1/runtime/workflow-results/latest',
    charged: true,
    handler: 'resultRequest',
    method: 'POST',
    path: '/v1/runtime/workflow-results/latest',
    source: SLACK_SOURCE,
    body: {
      workflowName: 'daily-report',
      providerIdentity: SLACK_IDENTITY,
      source: { ...SLACK_SOURCE, messageId: 'message-1', timestamp: '1700000000.000100' },
    },
  },
  {
    name: 'POST /v1/runtime/workflow-approval-mediums/link-sessions/confirm',
    charged: true,
    handler: 'enrollment',
    method: 'POST',
    path: '/v1/runtime/workflow-approval-mediums/link-sessions/confirm',
    source: SLACK_SOURCE,
    body: {
      nonce: 'nonce-1',
      medium: 'slack',
      providerUserId: 'U123',
      providerChannelId: 'C123',
      providerWorkspaceId: 'T123',
    },
  },
  {
    name: 'POST /v1/runtime/workflow-approval-mediums/telegram/challenges/confirm-provider-event',
    charged: true,
    handler: 'telegramVerification',
    method: 'POST',
    path: '/v1/runtime/workflow-approval-mediums/telegram/challenges/confirm-provider-event',
    source: TELEGRAM_SOURCE,
    body: {
      code: '123456',
      providerUserId: '42',
      providerChannelId: '-1001',
      providerChannelType: 'supergroup',
      providerTarget: {
        hostRef: 'chatllm',
        communicationChannelNamespace: 'team-ns',
        communicationChannelName: 'telegram-bot',
      },
    },
  },
  {
    name: 'POST /v1/runtime/workflow-approval-notifications/claim',
    charged: false,
    handler: 'notificationClaim',
    method: 'POST',
    path: '/v1/runtime/workflow-approval-notifications/claim',
    body: { medium: 'slack', providerChannelIds: ['C123'], hostRef: 'chatllm', limit: 10 },
  },
  {
    name: 'POST /v1/runtime/workflow-approval-notifications/deliveries/:id/ack',
    charged: false,
    handler: 'notificationTerminal',
    method: 'POST',
    path: '/v1/runtime/workflow-approval-notifications/deliveries/delivery-1/ack',
    source: SLACK_SOURCE,
    body: {
      medium: 'slack',
      providerUserId: 'U123',
      providerChannelId: 'C123',
      hostRef: 'chatllm',
    },
  },
  {
    name: 'POST /v1/runtime/workflow-approval-notifications/deliveries/:id/fail',
    charged: false,
    handler: 'notificationTerminal',
    method: 'POST',
    path: '/v1/runtime/workflow-approval-notifications/deliveries/delivery-2/fail',
    source: SLACK_SOURCE,
    body: {
      medium: 'slack',
      providerUserId: 'U123',
      providerChannelId: 'C123',
      hostRef: 'chatllm',
    },
  },
  {
    name: 'GET /v1/runtime/tasks/:taskId/result',
    charged: false,
    handler: 'taskResult',
    method: 'GET',
    path: '/v1/runtime/tasks/task-1/result',
    source: SLACK_SOURCE,
  },
  {
    name: 'GET /v1/runtime/cron/results',
    charged: false,
    handler: 'cronResults',
    method: 'GET',
    path: '/v1/runtime/cron/results',
  },
  {
    name: 'DELETE /v1/runtime/cron/results/:taskId',
    charged: false,
    handler: 'cronResultAck',
    method: 'DELETE',
    path: '/v1/runtime/cron/results/cron-task-1',
    source: SLACK_SOURCE,
  },
  {
    name: 'GET /v1/runtime/tasks/:taskId/progress/stream',
    charged: false,
    handler: 'progressStream',
    method: 'GET',
    path: '/v1/runtime/tasks/task-1/progress/stream',
    source: SLACK_SOURCE,
    stream: true,
  },
]

async function sendDirectRouteRow(
  baseUrl: string,
  row: DirectRouteRow
): Promise<{
  status: number
  retryAfter: string | null
  cacheControl: string | null
  body: unknown
}> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-clerum-edge-caller': 'channel-reader',
    'x-clerum-edge-host-ref': 'chatllm',
  }
  if (row.source) {
    headers['x-clerum-edge-channel-type'] = row.source.channelType
    headers['x-clerum-edge-channel-id'] = row.source.channelId
    headers['x-clerum-edge-sender'] = row.source.sender
  }
  const abort = new AbortController()
  const response = await fetch(`${baseUrl}${row.path}`, {
    method: row.method,
    headers,
    signal: abort.signal,
    ...(row.body ? { body: JSON.stringify(row.body) } : {}),
  })
  const retryAfter = response.headers.get('retry-after')
  const cacheControl = response.headers.get('cache-control')
  let body: unknown = null
  if (row.stream && response.ok) {
    abort.abort()
  } else {
    const text = await response.text()
    body = text ? (JSON.parse(text) as unknown) : null
  }
  return { status: response.status, retryAfter, cacheControl, body }
}

describe('direct trusted service admission: charged and exempt routes', () => {
  it('serves 900 timer-driven reads without spending the action budget', async () => {
    const host = await bootHostWithEveryDirectRoute()
    const admissionClock = vi.spyOn(Date, 'now').mockReturnValue(120_001)
    const quiet = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const quietError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      for (let index = 0; index < 700; index += 1) {
        await host.client.getTaskResult(`task-${index}`, SLACK_SOURCE)
      }
      for (let index = 0; index < 100; index += 1) {
        await host.client.getCronResults()
        await host.client.fetchDeliveries({
          medium: 'slack',
          providerChannelIds: ['C123'],
          hostRef: 'chatllm',
          limit: 10,
        })
      }
      // Witness: every poll reached its handler.
      expect(host.handlers.taskResult).toHaveBeenCalledTimes(700)
      expect(host.handlers.cronResults).toHaveBeenCalledTimes(100)
      expect(host.handlers.notificationClaim).toHaveBeenCalledTimes(100)

      const message = await host.client.sendMessage(slackMessage('after-polls'))
      expect(message.success).toBe(true)
      expect(host.handlers.message).toHaveBeenCalledTimes(1)
    } finally {
      admissionClock.mockRestore()
      quiet.mockRestore()
      quietError.mockRestore()
      await host.server.stop()
    }
  }, 60_000)

  it('serves the timer-driven reads, their acknowledgements and the progress stream at a full bucket', async () => {
    const host = await bootHostWithEveryDirectRoute()
    const admissionClock = vi.spyOn(Date, 'now').mockReturnValue(120_001)
    const quiet = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const quietError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await fillDirectServiceBucket(host.client)
      expect(host.handlers.message).toHaveBeenCalledTimes(600)

      await expect(host.client.getTaskResult('task-full', SLACK_SOURCE)).resolves.toMatchObject({
        success: true,
      })
      await expect(host.client.getCronResults()).resolves.toEqual([])
      await host.client.acknowledgeCronResult('cron-task-full', SLACK_SOURCE)
      await expect(
        host.client.fetchDeliveries({
          medium: 'slack',
          providerChannelIds: ['C123'],
          hostRef: 'chatllm',
          limit: 10,
        })
      ).resolves.toEqual([])
      const terminalParams = {
        medium: 'slack' as const,
        providerUserId: 'U123',
        providerChannelId: 'C123',
        hostRef: 'chatllm',
      }
      await host.client.acknowledge('delivery-ack', terminalParams)
      await host.client.fail('delivery-fail', terminalParams)

      const onError = vi.fn()
      const terminal = await new Promise<{ taskId: string; status: string }>(
        (resolveTerminal, rejectTerminal) => {
          host.createProgressStream({
            mcpHostUrl: host.baseUrl,
            taskId: 'task-stream',
            source: SLACK_SOURCE,
            onProgress: () => undefined,
            onSuspended: () => undefined,
            onTerminal: resolveTerminal,
            onError: error => {
              onError(error)
              rejectTerminal(new Error(error))
            },
          })
        }
      )

      expect(host.handlers.taskResult).toHaveBeenCalledOnce()
      expect(host.handlers.cronResults).toHaveBeenCalledOnce()
      expect(host.handlers.cronResultAck).toHaveBeenCalledOnce()
      expect(host.handlers.notificationClaim).toHaveBeenCalledOnce()
      expect(host.handlers.notificationTerminal.mock.calls.map(call => call.slice(0, 2))).toEqual([
        ['delivery-ack', 'ack'],
        ['delivery-fail', 'fail'],
      ])
      expect(host.handlers.progressStream).toHaveBeenCalledOnce()
      expect(terminal).toEqual({ taskId: 'task-stream', status: 'completed' })
      expect(onError).not.toHaveBeenCalled()

      // None of the requests above consumed the bucket: it is still full.
      const stillRefused = await host.client.sendMessage(slackMessage('still-full'))
      expect(stillRefused).toMatchObject({
        success: false,
        error: { code: 'RUNTIME_SERVICE_ADMISSION_LIMITED' },
      })
      expect(host.handlers.message).toHaveBeenCalledTimes(600)
    } finally {
      admissionClock.mockRestore()
      quiet.mockRestore()
      quietError.mockRestore()
      await host.server.stop()
    }
  }, 60_000)

  it('refuses the eight charged routes and serves the six exempt routes at a full bucket', async () => {
    const host = await bootHostWithEveryDirectRoute()
    const admissionClock = vi.spyOn(Date, 'now').mockReturnValue(120_001)
    const quiet = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const quietError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await fillDirectServiceBucket(host.client)

      const statuses: number[] = []
      for (const row of DIRECT_ROUTE_ROWS) {
        const before = host.handlers[row.handler].mock.calls.length
        const result = await sendDirectRouteRow(host.baseUrl, row)
        const handlerCalls = host.handlers[row.handler].mock.calls.length - before
        statuses.push(result.status)
        if (row.charged) {
          expect(result.status, row.name).toBe(429)
          expect(result.cacheControl, row.name).toBe('no-store')
          const retryAfter = Number(result.retryAfter)
          expect(retryAfter, row.name).toBeGreaterThanOrEqual(1)
          expect(retryAfter, row.name).toBeLessThanOrEqual(60)
          expect(result.body, row.name).toEqual({
            error: 'runtime_service_admission_limited',
            retryAfterSeconds: retryAfter,
          })
          expect(handlerCalls, row.name).toBe(0)
        } else {
          expect(result.status, row.name).toBeGreaterThanOrEqual(200)
          expect(result.status, row.name).toBeLessThan(300)
          expect(handlerCalls, row.name).toBe(1)
        }
      }
      // Eight charged call sites (approve and deny share one) and six exempt
      // ones (ack and fail share one).
      expect(statuses.filter(status => status === 429)).toHaveLength(9)
      expect(statuses.filter(status => status !== 429)).toHaveLength(7)

      // Witness for every refusal: the same request is served once the
      // window rolls over.
      admissionClock.mockReturnValue(180_000)
      for (const row of DIRECT_ROUTE_ROWS.filter(candidate => candidate.charged)) {
        const before = host.handlers[row.handler].mock.calls.length
        const result = await sendDirectRouteRow(host.baseUrl, row)
        expect(result.status, row.name).toBeGreaterThanOrEqual(200)
        expect(result.status, row.name).toBeLessThan(300)
        expect(host.handlers[row.handler].mock.calls.length - before, row.name).toBe(1)
      }
    } finally {
      admissionClock.mockRestore()
      quiet.mockRestore()
      quietError.mockRestore()
      await host.server.stop()
    }
  }, 60_000)

  it('gives the workflow approval reader the Host wait when the bucket is full', async () => {
    const host = await bootHostWithEveryDirectRoute()
    const { submitMcpHostDecision } = (await import(
      resolve(process.cwd(), '../workflow-approval-request-reader/src/mcpHostClient.ts')
    )) as {
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
      ) => Promise<{ ok: boolean; status?: number; error?: string; retryAfterSeconds?: number }>
    }
    const readerConfig: WorkflowReaderConfig = {
      port: 0,
      mcpHostBaseUrl: host.baseUrl,
      mcpHostRef: 'chatllm',
      mcpHostTargets: [{ hostRef: 'chatllm', baseUrl: host.baseUrl }],
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
    }
    const command = {
      approvalRequestId: APPROVAL_REQUEST_ID,
      mcpHostRef: 'chatllm',
      medium: 'slack' as const,
      providerUserId: 'U123',
      providerWorkspaceId: 'T123',
      providerChannelId: 'C123',
      providerEventId: 'event-limited',
      decision: 'approve' as const,
    }
    const admissionClock = vi.spyOn(Date, 'now').mockReturnValue(120_001)
    const quiet = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const quietError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await fillDirectServiceBucket(host.client)

      const limited = await submitMcpHostDecision(readerConfig, command)
      expect(limited).toEqual({
        ok: false,
        status: 429,
        error: 'runtime_service_admission_limited',
        retryAfterSeconds: expect.any(Number),
      })
      expect(limited.retryAfterSeconds).toBeGreaterThanOrEqual(1)
      expect(limited.retryAfterSeconds).toBeLessThanOrEqual(60)
      expect(host.handlers.decision).not.toHaveBeenCalled()

      // Witness: the same command reaches the handler once the window rolls over.
      admissionClock.mockReturnValue(180_000)
      await expect(submitMcpHostDecision(readerConfig, command)).resolves.toEqual({
        ok: true,
        duplicate: false,
      })
      expect(host.handlers.decision).toHaveBeenCalledOnce()
    } finally {
      admissionClock.mockRestore()
      quiet.mockRestore()
      quietError.mockRestore()
      await host.server.stop()
    }
  }, 60_000)
})
