import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RPCClient } from '../src/rpcClient.js'
import type { Message } from '../src/types.js'

const mockCfg = vi.hoisted(() => ({
  mcpHostUrl: 'http://localhost:9999',
  hostRef: 'test-host',
}))

vi.mock('../src/config', () => ({
  get config() {
    return mockCfg
  },
}))

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    channelType: 'telegram',
    channelId: '111222',
    sender: '123456',
    content: 'Hello',
    timestamp: new Date('2024-01-01T10:00:00Z'),
    messageId: 'msg-1',
    rawData: {},
    ...overrides,
  }
}

function mockOkResponse(body: object) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  })
}

function mockErrorResponse(status: number, error?: string) {
  return Promise.resolve({
    ok: false,
    status,
    statusText: `Error ${status}`,
    json: () => Promise.resolve(error ? { error } : {}),
  })
}

function expectChannelReaderEdgeHeaders(headers: Record<string, string>, source?: Message): void {
  expect(headers).toMatchObject({
    'x-clerum-edge-caller': 'channel-reader',
    'x-clerum-edge-host-ref': 'test-host',
  })
  expect(headers.authorization).toBeUndefined()
  expect(headers.Authorization).toBeUndefined()
  if (source) {
    expect(headers).toMatchObject({
      'x-clerum-edge-channel-type': source.channelType,
      'x-clerum-edge-channel-id': source.channelId,
      'x-clerum-edge-sender': source.sender,
    })
  }
}

beforeEach(() => {
  mockFetch.mockReset()
  mockCfg.hostRef = 'test-host'
})

describe('RPCClient - sendMessage()', () => {
  it('posts to /v1/runtime/messages with channel-reader edge context', async () => {
    mockFetch.mockReturnValueOnce(
      mockOkResponse({ success: true, status: 'completed', model: 'gpt-4' })
    )

    const client = new RPCClient('http://mcp-host:8080')
    const msg = makeMessage()
    await client.sendMessage(msg)

    expect(mockFetch).toHaveBeenCalledOnce()
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://mcp-host:8080/v1/runtime/messages')
    expect(opts.method).toBe('POST')
    expectChannelReaderEdgeHeaders(opts.headers as Record<string, string>, msg)

    const body = JSON.parse(opts.body as string)
    expect(body.content).toBe('Hello')
    expect(body.channelType).toBe('telegram')
    expect(body.hostRef).toBe('test-host')
    expect(body.messageId).toBe('msg-1')
  })

  it('forwards stable provider identity to mcp-host for channel workflow tools', async () => {
    mockFetch.mockReturnValueOnce(
      mockOkResponse({ success: true, status: 'completed', model: 'gpt-4' })
    )

    const client = new RPCClient('http://mcp-host:8080')
    await client.sendMessage(
      makeMessage({
        providerIdentity: {
          medium: 'telegram',
          providerUserId: '123456',
          providerChannelId: '111222',
          providerEventId: 'telegram:111222:msg-1',
        },
      })
    )

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(opts.body as string)
    expect(body.providerIdentity).toEqual({
      medium: 'telegram',
      providerUserId: '123456',
      providerChannelId: '111222',
      providerEventId: 'telegram:111222:msg-1',
    })
  })

  it('returns success response from mcp-host', async () => {
    mockFetch.mockReturnValueOnce(
      mockOkResponse({ success: true, status: 'completed', response: 'Hi back', model: 'gpt-4' })
    )

    const client = new RPCClient('http://localhost:9999')
    const result = await client.sendMessage(makeMessage())

    expect(result.success).toBe(true)
    expect(result.response).toBe('Hi back')
    expect(result.status).toBe('completed')
  })

  it('returns waiting_approval status with approval details', async () => {
    mockFetch.mockReturnValueOnce(
      mockOkResponse({
        success: true,
        status: 'waiting_approval',
        approval: {
          taskId: 'task-1',
          requestId: 'req-1',
          userId: 'user-1',
          notification: 'Approve tool use?',
        },
      })
    )

    const client = new RPCClient('http://localhost:9999')
    const result = await client.sendMessage(makeMessage())

    expect(result.status).toBe('waiting_approval')
    expect(result.approval?.requestId).toBe('req-1')
  })

  it('returns error response on HTTP failure', async () => {
    mockFetch.mockReturnValueOnce(mockErrorResponse(500))

    const client = new RPCClient('http://localhost:9999')
    const result = await client.sendMessage(makeMessage())

    expect(result.success).toBe(false)
    expect(result.error?.message).toContain('500')
  })

  it('returns error response when fetch throws', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'))

    const client = new RPCClient('http://localhost:9999')
    const result = await client.sendMessage(makeMessage())

    expect(result.success).toBe(false)
    expect(result.error?.message).toContain('ECONNREFUSED')
  })
})

describe('RPCClient - sendWorkflowApprovalDecision()', () => {
  const decision = {
    approvalRequestId: '00000000-0000-0000-0000-000000000111',
    decision: 'approve' as const,
    providerIdentity: {
      medium: 'telegram' as const,
      providerUserId: '123456',
      providerChannelId: '111222',
      providerEventId: 'telegram:111222:msg-1',
    },
  }

  it('uses channel-reader edge context for provider workflow approval decisions', async () => {
    mockFetch.mockReturnValueOnce(mockOkResponse({ success: true, duplicate: false }))

    const client = new RPCClient('http://mcp-host:8080')
    const result = await client.sendWorkflowApprovalDecision(decision)

    expect(result.success).toBe(true)
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://mcp-host:8080/v1/runtime/workflow-approvals/decide')
    expectChannelReaderEdgeHeaders(opts.headers as Record<string, string>, {
      ...makeMessage(),
      channelId: '111222',
      sender: '123456',
    })
  })

  it('does not retry with runtime tokens when mcp-host rejects the edge request', async () => {
    mockFetch.mockReturnValueOnce(mockErrorResponse(401))

    const client = new RPCClient('http://mcp-host:8080')
    const result = await client.sendWorkflowApprovalDecision(decision)

    expect(result.success).toBe(false)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })
})

describe('RPCClient - resolveWorkflowApproval()', () => {
  const payload = {
    recipeName: 'due-diligence',
    providerIdentity: {
      medium: 'telegram' as const,
      providerUserId: '123456',
      providerChannelId: '111222',
    },
  }

  it('uses channel-reader edge context for pending workflow approval resolution', async () => {
    mockFetch.mockReturnValueOnce(
      mockOkResponse({ approvalRequestId: '00000000-0000-0000-0000-000000000111' })
    )

    const client = new RPCClient('http://mcp-host:8080')
    const result = await client.resolveWorkflowApproval(payload)

    expect(result?.approvalRequestId).toBe('00000000-0000-0000-0000-000000000111')
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://mcp-host:8080/v1/runtime/workflow-approvals/resolve')
    expectChannelReaderEdgeHeaders(opts.headers as Record<string, string>, {
      ...makeMessage(),
      channelId: '111222',
      sender: '123456',
    })
  })

  it('preserves mcp-host ambiguity errors', async () => {
    mockFetch.mockReturnValueOnce(mockErrorResponse(409, 'pending_workflow_approval_ambiguous'))

    const client = new RPCClient('http://mcp-host:8080')

    await expect(client.resolveWorkflowApproval(payload)).rejects.toThrow(
      'pending_workflow_approval_ambiguous'
    )
  })
})

describe('RPCClient - workflow approval notifications', () => {
  it('claims deliveries through mcp-host runtime with channel-reader edge context', async () => {
    mockFetch.mockReturnValueOnce(mockOkResponse({ deliveries: [] }))

    const client = new RPCClient('http://mcp-host:8080')
    const result = await client.fetchDeliveries({
      medium: 'telegram',
      providerChannelIds: ['111222'],
      hostRef: 'chatllm',
      limit: 10,
    })

    expect(result).toEqual([])
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://mcp-host:8080/v1/runtime/workflow-approval-notifications/claim')
    expect(opts.method).toBe('POST')
    expectChannelReaderEdgeHeaders(opts.headers as Record<string, string>)
    expect(JSON.parse(opts.body as string)).toEqual({
      medium: 'telegram',
      providerChannelIds: ['111222'],
      hostRef: 'chatllm',
      limit: 10,
    })
  })

  it('acknowledges and fails deliveries through mcp-host runtime', async () => {
    mockFetch.mockReturnValueOnce(mockOkResponse({})).mockReturnValueOnce(mockOkResponse({}))

    const client = new RPCClient('http://mcp-host:8080')
    const params = {
      medium: 'telegram' as const,
      providerUserId: '123456',
      providerChannelId: '111222',
      hostRef: 'chatllm',
    }
    await client.acknowledge('delivery-1', params)
    await client.fail('delivery-2', params)

    expect(mockFetch.mock.calls[0][0]).toBe(
      'http://mcp-host:8080/v1/runtime/workflow-approval-notifications/deliveries/delivery-1/ack'
    )
    expect(mockFetch.mock.calls[1][0]).toBe(
      'http://mcp-host:8080/v1/runtime/workflow-approval-notifications/deliveries/delivery-2/fail'
    )
    expectChannelReaderEdgeHeaders(mockFetch.mock.calls[0][1].headers as Record<string, string>, {
      ...makeMessage(),
      channelId: '111222',
      sender: '123456',
    })
    expectChannelReaderEdgeHeaders(mockFetch.mock.calls[1][1].headers as Record<string, string>, {
      ...makeMessage(),
      channelId: '111222',
      sender: '123456',
    })
  })
})

describe('RPCClient - Telegram workflow approval verification', () => {
  it('confirms Telegram challenges through mcp-host runtime with private chat edge context', async () => {
    mockFetch.mockReturnValueOnce(
      mockOkResponse({ ok: true, accountId: 'account-1', userEmail: 'user@example.com' })
    )

    const client = new RPCClient('http://mcp-host:8080')
    const result = await client.confirmTelegramChallenge({
      code: '123456',
      providerUserId: '123456',
      providerChannelId: '123456',
      providerChannelType: 'private',
      providerTarget: {
        hostRef: 'chatllm',
        communicationChannelNamespace: 'channels',
        communicationChannelName: 'groupevenfire',
        providerBotId: '999',
        providerBotUsername: 'alfmotlybot',
      },
    })

    expect(result).toEqual({
      ok: true,
      accountId: 'account-1',
      userEmail: 'user@example.com',
    })
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(
      'http://mcp-host:8080/v1/runtime/workflow-approval-mediums/telegram/challenges/confirm-provider-event'
    )
    expectChannelReaderEdgeHeaders(opts.headers as Record<string, string>, {
      ...makeMessage(),
      channelId: '123456',
      sender: '123456',
    })
  })

  it('keeps a successful confirmation when control-api omits the optional email', async () => {
    mockFetch.mockReturnValueOnce(mockOkResponse({ ok: true, accountId: 'account-1' }))

    const client = new RPCClient('http://mcp-host:8080')
    await expect(
      client.confirmTelegramChallenge({
        code: '123456',
        providerUserId: '123456',
        providerChannelId: '123456',
        providerChannelType: 'private',
        providerTarget: {
          hostRef: 'chatllm',
          communicationChannelNamespace: 'channels',
          communicationChannelName: 'groupevenfire',
        },
      })
    ).resolves.toEqual({ ok: true, accountId: 'account-1' })
  })
})

describe('RPCClient - provider message authorization', () => {
  it('forwards the provider target and returns the authorization verdict', async () => {
    mockFetch.mockReturnValueOnce(mockOkResponse({ authorized: true }))
    const identity = {
      medium: 'telegram' as const,
      providerUserId: '123456',
      providerWorkspaceId: null,
      providerChannelId: '111222',
      providerChannelType: 'private',
      providerEventId: 'telegram:111222:msg-1',
      providerTarget: {
        hostRef: 'test-host',
        communicationChannelNamespace: 'channels',
        communicationChannelName: 'test-host-telegram',
      },
    }
    const client = new RPCClient('http://mcp-host:8080')

    await expect(client.authorizeProviderMessage(identity)).resolves.toEqual({ authorized: true })

    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://mcp-host:8080/v1/runtime/provider-messages/authorize')
    expect(options.signal).toBeInstanceOf(AbortSignal)
    expect(JSON.parse(String(options.body))).toEqual({ providerIdentity: identity })
    expectChannelReaderEdgeHeaders(options.headers as Record<string, string>, makeMessage())
  })
})

describe('RPCClient - sendApproval()', () => {
  it('posts to /v1/runtime/approvals/approve with edge context', async () => {
    mockFetch.mockReturnValueOnce(mockOkResponse({ success: true }))

    const client = new RPCClient('http://mcp-host:8080')
    await client.sendApproval('user-1', 'req-1', false, 'telegram', '111222')

    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/approvals/approve')
    expectChannelReaderEdgeHeaders(opts.headers as Record<string, string>, {
      ...makeMessage(),
      channelId: '111222',
      sender: 'user-1',
    })
    const body = JSON.parse(opts.body as string)
    expect(body.requestId).toBe('req-1')
    expect(body.alwaysApprove).toBe(false)
  })

  it('returns success false on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network down'))

    const client = new RPCClient('http://localhost:9999')
    const result = await client.sendApproval('u', 'r', false, 'telegram', 'c')

    expect(result.success).toBe(false)
    expect(result.error).toContain('Network down')
  })
})

describe('RPCClient - read-side direct mcp-host calls', () => {
  it('uses source edge context when fetching an async task result', async () => {
    mockFetch.mockReturnValueOnce(mockOkResponse({ success: true, response: 'done' }))

    const client = new RPCClient('http://mcp-host:8080')
    const source = makeMessage()
    const result = await client.getTaskResult('task-1', source)

    expect(result.success).toBe(true)
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://mcp-host:8080/v1/runtime/tasks/task-1/result')
    expectChannelReaderEdgeHeaders(opts.headers as Record<string, string>, source)
  })

  it('uses source edge context when acknowledging a delivered cron result', async () => {
    mockFetch
      .mockReturnValueOnce(mockOkResponse({ results: [{ id: 'cron-result-1' }] }))
      .mockReturnValueOnce(mockOkResponse({}))

    const client = new RPCClient('http://mcp-host:8080')
    const source = makeMessage()
    await client.getCronResults()
    await client.acknowledgeCronResult('cron-result-1', source)

    expectChannelReaderEdgeHeaders(mockFetch.mock.calls[0][1].headers as Record<string, string>)
    expectChannelReaderEdgeHeaders(
      mockFetch.mock.calls[1][1].headers as Record<string, string>,
      source
    )
  })

  it('does not retry with runtime tokens when task result fetch is rejected', async () => {
    mockFetch.mockReturnValueOnce(mockErrorResponse(401))

    const client = new RPCClient('http://mcp-host:8080')
    await expect(client.getTaskResult('task-1', makeMessage())).rejects.toThrow(
      'Failed to get task result: 401'
    )
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })
})

describe('RPCClient - healthCheck()', () => {
  it('returns true when mcp-host responds OK', async () => {
    mockFetch.mockReturnValueOnce(mockOkResponse({ status: 'ok' }))

    const client = new RPCClient('http://localhost:9999')
    const healthy = await client.healthCheck()

    expect(healthy).toBe(true)
  })

  it('returns false when mcp-host is down', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'))

    const client = new RPCClient('http://localhost:9999')
    const healthy = await client.healthCheck()

    expect(healthy).toBe(false)
  })
})
