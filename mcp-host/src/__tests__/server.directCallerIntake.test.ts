/**
 * Direct service callers (`channel-reader`, `workflow-approval-request-reader`)
 * reach the MCP Host without a request limit, as on dev, and the draining
 * fence of POST /v1/runtime/messages runs first for every caller.
 *
 * Real RPCServer, real HTTP, recording handlers. The clock is fixed inside one
 * minute so that any per-minute limit would be reached by these requests.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'

const runtimeTestEnvironmentKeys = [
  'CLERUM_ENABLE_AUTH',
  'CLERUM_HOST_NAME',
  'CLERUM_HOST_REF',
  'LOG_LEVEL',
] as const

let runtimeTestEnvironmentBefore: Map<string, string | undefined> | undefined

afterEach(() => {
  vi.restoreAllMocks()
  if (!runtimeTestEnvironmentBefore) return
  for (const [key, value] of runtimeTestEnvironmentBefore) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  runtimeTestEnvironmentBefore = undefined
})

const FIXED_NOW_MS = 120_001
const APPROVAL_REQUEST_ID = '4dd2d3d8-7664-4e3e-bd59-2be3357bd036'
const SLACK_SOURCE = { channelType: 'slack', channelId: 'C123', sender: 'U123' } as const
const TELEGRAM_SOURCE = { channelType: 'telegram', channelId: '-1001', sender: '42' } as const
const SLACK_IDENTITY = {
  medium: 'slack',
  providerUserId: 'U123',
  providerChannelId: 'C123',
  providerWorkspaceId: 'T123',
} as const

type DirectCaller = 'channel-reader' | 'workflow-approval-request-reader'
type RuntimeSource = { channelType: string; channelId: string; sender: string }

type LifecycleGateStub = {
  isIntakeFenced: () => boolean
  noteIntakeActivity: ReturnType<typeof vi.fn<() => void>>
  noteFencedIntake: ReturnType<typeof vi.fn<() => void>>
}

/** A real MCP Host with a recording handler behind every route this file calls. */
async function bootHost(gate?: LifecycleGateStub) {
  runtimeTestEnvironmentBefore = new Map(
    runtimeTestEnvironmentKeys.map(key => [key, process.env[key]])
  )
  process.env.CLERUM_ENABLE_AUTH = 'false'
  process.env.CLERUM_HOST_NAME = 'chatllm'
  process.env.CLERUM_HOST_REF = 'chatllm'
  process.env.LOG_LEVEL = 'silent'
  vi.resetModules()

  const { RPCServer } = await import('../server')
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
    enrollment: vi.fn(async () => ({ ok: true })),
    telegramVerification: vi.fn(async () => ({ ok: true as const, accountId: 'account-1' })),
  }
  const server = new RPCServer(0)
  server.onMessage(handlers.message)
  server.onApproval(handlers.approval)
  server.onProviderMessageAuthorization(handlers.providerMessageAuthorization)
  server.onProviderWorkflowApprovalDecision(handlers.decision)
  server.onProviderWorkflowApprovalResolve(handlers.resolve)
  server.onProviderWorkflowResultRequest(handlers.resultRequest)
  server.onWorkflowApprovalMediumEnrollment(handlers.enrollment)
  server.onTelegramWorkflowApprovalVerification(handlers.telegramVerification)
  if (gate) server.setLifecycleGate(gate)
  await server.start()
  const address = (server as unknown as { server: { address: () => AddressInfo } }).server.address()
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, handlers }
}

type Host = Awaited<ReturnType<typeof bootHost>>
type HandlerName = keyof Host['handlers']

function directCallerHeaders(caller: DirectCaller, source?: RuntimeSource): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-clerum-edge-caller': caller,
    'x-clerum-edge-host-ref': 'chatllm',
  }
  if (source) {
    headers['x-clerum-edge-channel-type'] = source.channelType
    headers['x-clerum-edge-channel-id'] = source.channelId
    headers['x-clerum-edge-sender'] = source.sender
  }
  return headers
}

async function post(
  baseUrl: string,
  path: string,
  caller: DirectCaller,
  source: RuntimeSource | undefined,
  body: Record<string, unknown>
): Promise<{ status: number; retryAfter: string | null; body: unknown }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: directCallerHeaders(caller, source),
    body: JSON.stringify(body),
  })
  const text = await response.text()
  return {
    status: response.status,
    retryAfter: response.headers.get('retry-after'),
    body: text ? (JSON.parse(text) as unknown) : null,
  }
}

function slackMessageBody(index: number): Record<string, unknown> {
  return {
    content: `hello ${index}`,
    ...SLACK_SOURCE,
    timestamp: '2026-01-01T00:00:00.000Z',
    messageId: `message-${index}`,
  }
}

type DirectRouteRow = {
  name: string
  caller: DirectCaller
  handler: Exclude<HandlerName, 'message'>
  path: string
  source: RuntimeSource
  body: Record<string, unknown>
}

const DIRECT_ROUTE_ROWS: DirectRouteRow[] = [
  {
    name: 'POST /v1/runtime/approvals/approve',
    caller: 'channel-reader',
    handler: 'approval',
    path: '/v1/runtime/approvals/approve',
    source: SLACK_SOURCE,
    body: { userId: 'U123', requestId: 'tool-request-1', channelType: 'slack', channelId: 'C123' },
  },
  {
    name: 'POST /v1/runtime/provider-messages/authorize',
    caller: 'channel-reader',
    handler: 'providerMessageAuthorization',
    path: '/v1/runtime/provider-messages/authorize',
    source: SLACK_SOURCE,
    body: { providerIdentity: SLACK_IDENTITY },
  },
  {
    name: 'POST /v1/runtime/workflow-approvals/decide',
    caller: 'workflow-approval-request-reader',
    handler: 'decision',
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
    caller: 'channel-reader',
    handler: 'resolve',
    path: '/v1/runtime/workflow-approvals/resolve',
    source: SLACK_SOURCE,
    body: { recipeName: 'daily-report', providerIdentity: SLACK_IDENTITY },
  },
  {
    name: 'POST /v1/runtime/workflow-results/latest',
    caller: 'channel-reader',
    handler: 'resultRequest',
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
    caller: 'workflow-approval-request-reader',
    handler: 'enrollment',
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
    caller: 'channel-reader',
    handler: 'telegramVerification',
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
]

describe('direct service callers reach the Host without a request limit', () => {
  it('serves 650 channel-reader messages sent inside one minute', async () => {
    const host = await bootHost()
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW_MS)
    try {
      const statuses: number[] = []
      const retryAfterHeaders: string[] = []
      for (let index = 0; index < 650; index += 1) {
        const result = await post(
          host.baseUrl,
          '/v1/runtime/messages',
          'channel-reader',
          SLACK_SOURCE,
          slackMessageBody(index)
        )
        statuses.push(result.status)
        if (result.retryAfter !== null) retryAfterHeaders.push(result.retryAfter)
      }
      // Witness: every request reached the message handler and was answered 200.
      expect(host.handlers.message).toHaveBeenCalledTimes(650)
      expect(statuses.filter(status => status === 200)).toHaveLength(650)
      expect(statuses.filter(status => status === 429)).toHaveLength(0)
      expect(retryAfterHeaders).toEqual([])
    } finally {
      await host.server.stop()
    }
  }, 60_000)

  it.each(DIRECT_ROUTE_ROWS)(
    'serves 601 requests to $name from $caller inside one minute',
    async row => {
      const host = await bootHost()
      vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW_MS)
      try {
        const statuses: number[] = []
        for (let index = 0; index < 601; index += 1) {
          const result = await post(host.baseUrl, row.path, row.caller, row.source, row.body)
          statuses.push(result.status)
        }
        // Witness: that route's handler ran for every request, the 601st included.
        expect(host.handlers[row.handler]).toHaveBeenCalledTimes(601)
        expect(statuses.filter(status => status >= 200 && status < 300)).toHaveLength(601)
        expect(statuses.filter(status => status === 429)).toHaveLength(0)
      } finally {
        await host.server.stop()
      }
    },
    60_000
  )
})

describe('POST /v1/runtime/messages from a direct service caller: fence and intake activity', () => {
  it('answers a draining Host 503 before validating a channel-reader body', async () => {
    const gate: LifecycleGateStub = {
      isIntakeFenced: () => true,
      noteIntakeActivity: vi.fn(),
      noteFencedIntake: vi.fn(),
    }
    const host = await bootHost(gate)
    try {
      // Invalid body: no `content`. Validation would answer 400.
      const result = await post(
        host.baseUrl,
        '/v1/runtime/messages',
        'channel-reader',
        SLACK_SOURCE,
        { ...SLACK_SOURCE, timestamp: '2026-01-01T00:00:00.000Z', messageId: 'invalid-1' }
      )
      expect(result.status).toBe(503)
      expect(result.body).toEqual({ code: 'host_draining' })
      // Witness: the fence recorded the fenced intake for the next heartbeat.
      expect(gate.noteFencedIntake).toHaveBeenCalledTimes(1)
      expect(gate.noteIntakeActivity).not.toHaveBeenCalled()
      expect(host.handlers.message).not.toHaveBeenCalled()
    } finally {
      await host.server.stop()
    }
  })

  it('notes intake activity before validating a workflow approval reader body', async () => {
    const gate: LifecycleGateStub = {
      isIntakeFenced: () => false,
      noteIntakeActivity: vi.fn(),
      noteFencedIntake: vi.fn(),
    }
    const host = await bootHost(gate)
    try {
      // Invalid body: no `content`.
      const result = await post(
        host.baseUrl,
        '/v1/runtime/messages',
        'workflow-approval-request-reader',
        SLACK_SOURCE,
        { ...SLACK_SOURCE, timestamp: '2026-01-01T00:00:00.000Z', messageId: 'invalid-2' }
      )
      // Witness: the route validated the body and refused it.
      expect(result.status).toBe(400)
      expect(result.body).toMatchObject({ error: 'content must be a string' })
      expect(gate.noteIntakeActivity).toHaveBeenCalledTimes(1)
      expect(gate.noteFencedIntake).not.toHaveBeenCalled()
      expect(host.handlers.message).not.toHaveBeenCalled()
    } finally {
      await host.server.stop()
    }
  })
})
