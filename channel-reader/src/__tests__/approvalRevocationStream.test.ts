import { afterEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { ChannelReader, type ChannelReaderOptions } from '../main'
import { createProgressStream } from '../progressClient'
import { RPCClient, TaskResultHttpError } from '../rpcClient'
import type { ChannelAdapter, Message } from '../types'

interface CapturedStream {
  taskId: string
  close: ReturnType<typeof vi.fn>
  onSuspended: (data: {
    taskId: string
    requestId: string
    toolName: string
    displayName: string
    reason: string
  }) => Promise<void> | void
  onTerminal: (data: {
    taskId: string
    status: 'completed' | 'failed' | 'cancelled'
    error?: { message: string }
  }) => Promise<void> | void
  onError: (error: string) => Promise<void> | void
}

const streamControl = vi.hoisted(() => ({
  calls: [] as CapturedStream[],
}))

vi.mock('../progressClient', () => ({
  createProgressStream: vi.fn(
    (options: {
      taskId: string
      onSuspended: CapturedStream['onSuspended']
      onTerminal: CapturedStream['onTerminal']
      onError: CapturedStream['onError']
    }) => {
      const close = vi.fn()
      streamControl.calls.push({
        taskId: options.taskId,
        close,
        onSuspended: options.onSuspended,
        onTerminal: options.onTerminal,
        onError: options.onError,
      })
      return {
        close,
        get steps() {
          return []
        },
      }
    }
  ),
}))

vi.hoisted(() => {
  process.env.CLERUM_HOST_REF = process.env.CLERUM_HOST_REF ?? 'test-host'
})

function makeStubAdapter(
  channelType: 'telegram' | 'slack' | 'teams' = 'telegram',
  overrides: Partial<ChannelAdapter> = {}
): ChannelAdapter {
  return {
    channelType,
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    fetchMessages: vi.fn(async () => []),
    sendMessage: vi.fn(async () => 'status-msg-1'),
    editMessage: vi.fn(async () => undefined),
    sendEphemeral: vi.fn(async () => undefined),
    ...overrides,
  }
}

function makeRpc(overrides: Partial<NonNullable<ChannelReaderOptions['rpcClient']>> = {}) {
  return {
    healthCheck: vi.fn(async () => true),
    sendMessage: vi.fn(async () => ({
      success: true,
      status: 'pending' as const,
      taskId: 'task-1',
    })),
    getBaseUrl: vi.fn(() => 'http://mcp-host.test'),
    getTaskResult: vi.fn(async () => ({
      success: true,
      status: 'completed' as const,
      response: 'ok',
    })),
    sendApproval: vi.fn(async () => ({ success: true })),
    sendDenial: vi.fn(async () => ({ success: true })),
    sendWorkflowApprovalDecision: vi.fn(async () => ({ success: true })),
    resolveWorkflowApproval: vi.fn(async () => null),
    fetchDeliveries: vi.fn(async () => []),
    acknowledge: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
    confirmTelegramChallenge: vi.fn(async () => ({ ok: true as const, accountId: 'a1' })),
    getCronResults: vi.fn(async () => []),
    acknowledgeCronResult: vi.fn(async () => undefined),
    authorizeProviderMessage: vi.fn(async () => ({ authorized: true })),
    ...overrides,
  }
}

function makeTelegramMessage(id: string, content = 'save file'): Message {
  return {
    channelType: 'telegram',
    channelId: '111222',
    sender: '123456',
    content,
    timestamp: new Date(),
    messageId: `msg-${id}`,
    providerIdentity: {
      medium: 'telegram',
      providerUserId: '123456',
      providerWorkspaceId: null,
      providerChannelId: '111222',
      providerEventId: `telegram:111222:${id}`,
    },
  }
}

async function startLoopbackServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void
): Promise<{ server: http.Server; baseUrl: string }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    req.on('end', () => {
      handler(req, res, Buffer.concat(chunks).toString('utf8'))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const addr = server.address() as AddressInfo
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` }
}

afterEach(() => {
  streamControl.calls.length = 0
  vi.mocked(createProgressStream).mockClear()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Approval revocation stream handling and HTTP loopback contracts (BR-01 / BR-T2)', () => {
  it('T-BR01-a · onSuspended aborts on TaskResultHttpError 404/403 without prompt disclosure', async () => {
    for (const status of [404, 403] as const) {
      streamControl.calls.length = 0
      const adapter = makeStubAdapter('telegram')
      const getTaskResult = vi.fn(async () => {
        throw new TaskResultHttpError(status, `Failed to get task result: ${status}`)
      })
      const rpc = makeRpc({
        sendMessage: vi.fn(async () => ({
          success: true,
          status: 'pending' as const,
          taskId: `task-${status}`,
        })),
        getTaskResult,
      })
      const reader = new ChannelReader({
        rpcClient: rpc,
        notificationDeliveryClient: null,
        adapters: new Map([['telegram', adapter]]),
      })

      await reader.handleMessages([makeTelegramMessage(`revoked-${status}`)])
      const stream = streamControl.calls[0]!
      await stream.onSuspended({
        taskId: `task-${status}`,
        requestId: `req-${status}`,
        toolName: 'clerum__secret_tool',
        displayName: 'Secret Tool',
        reason: 'approval_required',
      })

      // Liveness witness: getTaskResult was called once and stream closed
      expect(getTaskResult).toHaveBeenCalledTimes(1)
      expect(stream.close).toHaveBeenCalledTimes(1)
      expect(adapter.editMessage).not.toHaveBeenCalled()

      // Verify pendingApprovals is empty via real /approve command behavior
      await reader.handleMessages([makeTelegramMessage(`approve-${status}`, '/approve')])
      expect(rpc.sendApproval).not.toHaveBeenCalled()
      expect(adapter.sendMessage).toHaveBeenLastCalledWith(
        '111222',
        expect.stringContaining('No pending approval found'),
        `msg-approve-${status}`,
        undefined,
        undefined
      )
    }

    // Liveness witness: valid waiting_approval delivers prompt and populates pendingApprovals
    streamControl.calls.length = 0
    const liveAdapter = makeStubAdapter('telegram')
    const liveRpc = makeRpc({
      sendMessage: vi.fn(async () => ({
        success: true,
        status: 'pending' as const,
        taskId: 'task-live',
      })),
      getTaskResult: vi.fn(async () => ({
        success: true,
        status: 'waiting_approval' as const,
        approval: {
          taskId: 'task-live',
          requestId: 'req-live',
          userId: '123456',
          notification: 'Approve X',
        },
      })),
    })
    const liveReader = new ChannelReader({
      rpcClient: liveRpc,
      notificationDeliveryClient: null,
      adapters: new Map([['telegram', liveAdapter]]),
    })
    await liveReader.handleMessages([makeTelegramMessage('live')])
    await streamControl.calls[0]!.onSuspended({
      taskId: 'task-live',
      requestId: 'req-live',
      toolName: 'clerum__live_tool',
      displayName: 'Live Tool',
      reason: 'approval_required',
    })
    expect(liveAdapter.editMessage).toHaveBeenCalledTimes(1)
    expect(String(vi.mocked(liveAdapter.editMessage).mock.calls[0]?.[2])).toContain('Approve X')
    await liveReader.handleMessages([makeTelegramMessage('live-approve', '/approve')])
    expect(liveRpc.sendApproval).toHaveBeenCalledTimes(1)

    // Genuine transient 500 error while !finalDelivered still preserves fallback prompt
    streamControl.calls.length = 0
    const errAdapter = makeStubAdapter('telegram')
    const errRpc = makeRpc({
      sendMessage: vi.fn(async () => ({
        success: true,
        status: 'pending' as const,
        taskId: 'task-500',
      })),
      getTaskResult: vi.fn(async () => {
        throw new TaskResultHttpError(500, 'Failed to get task result: 500')
      }),
    })
    const errReader = new ChannelReader({
      rpcClient: errRpc,
      notificationDeliveryClient: null,
      adapters: new Map([['telegram', errAdapter]]),
    })
    await errReader.handleMessages([makeTelegramMessage('transient-500')])
    await streamControl.calls[0]!.onSuspended({
      taskId: 'task-500',
      requestId: 'req-500',
      toolName: 'clerum__fallback_tool',
      displayName: 'Fallback Tool',
      reason: 'approval_required',
    })
    expect(errAdapter.editMessage).toHaveBeenCalledTimes(1)
    expect(String(vi.mocked(errAdapter.editMessage).mock.calls[0]?.[2])).toContain(
      'clerum__fallback_tool'
    )
  })

  it('T-BR01-b · onSuspended aborts when finalDelivered flips before or during getTaskResult', async () => {
    let releaseSuspendedFetch!: () => void
    const suspendedFetchGate = new Promise<void>(resolve => {
      releaseSuspendedFetch = resolve
    })

    const adapter = makeStubAdapter('telegram')
    let callCount = 0
    const rpc = makeRpc({
      sendMessage: vi.fn(async () => ({
        success: true,
        status: 'pending' as const,
        taskId: 'task-race',
      })),
      getTaskResult: vi.fn(async () => {
        callCount += 1
        if (callCount === 1) {
          await suspendedFetchGate
          return { success: true, status: 'pending' as const }
        }
        return {
          success: true,
          status: 'completed' as const,
          response: 'Final terminal answer',
        }
      }),
    })
    const reader = new ChannelReader({
      rpcClient: rpc,
      notificationDeliveryClient: null,
      adapters: new Map([['telegram', adapter]]),
    })

    await reader.handleMessages([makeTelegramMessage('race')])
    const stream = streamControl.calls[0]!

    // Start onSuspended while its getTaskResult is suspended
    const suspendedPromise = stream.onSuspended({
      taskId: 'task-race',
      requestId: 'req-race',
      toolName: 'clerum__race_tool',
      displayName: 'Race Tool',
      reason: 'approval_required',
    })

    // Terminal completes while onSuspended is in flight -> sets finalDelivered = true
    await stream.onTerminal({ taskId: 'task-race', status: 'completed' })

    // Release onSuspended's getTaskResult -> must observe finalDelivered and NOT deliver prompt
    releaseSuspendedFetch()
    await suspendedPromise

    // Liveness witness: terminal response was delivered exactly once, no approval prompt emitted
    expect(adapter.editMessage).toHaveBeenCalledTimes(1)
    expect(String(vi.mocked(adapter.editMessage).mock.calls[0]?.[2])).toContain(
      'Final terminal answer'
    )

    // Subsequent onSuspended when finalDelivered is already true returns immediately without fetching
    const countBeforeLate = vi.mocked(rpc.getTaskResult).mock.calls.length
    await stream.onSuspended({
      taskId: 'task-race',
      requestId: 'req-late',
      toolName: 'clerum__late_tool',
      displayName: 'Late Tool',
      reason: 'approval_required',
    })
    expect(vi.mocked(rpc.getTaskResult).mock.calls.length).toBe(countBeforeLate)
    expect(adapter.editMessage).toHaveBeenCalledTimes(1)
  })

  it('T-BR01-c · deliverFinalResult cancelled aborts without Done and 403/404 aborts polling/onTerminal/onError', async () => {
    // Part (i): deliverFinalResult on `{ success: false, status: 'cancelled' }` does NOT send 'Done.'
    {
      streamControl.calls.length = 0
      const adapter = makeStubAdapter('telegram')
      const getTaskResult = vi
        .fn()
        .mockResolvedValueOnce({
          success: true,
          status: 'waiting_approval' as const,
          approval: {
            taskId: 'task-cancel',
            requestId: 'req-cancel',
            userId: '123456',
            notification: 'Approve cancel test',
          },
        })
        .mockResolvedValueOnce({
          success: false,
          status: 'cancelled' as const,
        })
      const rpc = makeRpc({
        sendMessage: vi.fn(async () => ({
          success: true,
          status: 'pending' as const,
          taskId: 'task-cancel',
        })),
        getTaskResult,
      })
      const reader = new ChannelReader({
        rpcClient: rpc,
        notificationDeliveryClient: null,
        adapters: new Map([['telegram', adapter]]),
      })

      await reader.handleMessages([makeTelegramMessage('cancel')])
      const stream = streamControl.calls[0]!

      // Register pending approval first so we can prove clearPendingApprovalForTask cleared it
      await stream.onSuspended({
        taskId: 'task-cancel',
        requestId: 'req-cancel',
        toolName: 'tool_a',
        displayName: 'Tool A',
        reason: 'approval_required',
      })
      expect(adapter.editMessage).toHaveBeenCalledTimes(1)

      // Terminal arrives and deliverFinalResult fetches `{ success: false, status: 'cancelled' }`
      await stream.onTerminal({ taskId: 'task-cancel', status: 'completed' })

      // Liveness witness: getTaskResult called twice (once suspended, once terminal), stream closed, NO 'Done.' edit
      expect(getTaskResult).toHaveBeenCalledTimes(2)
      expect(stream.close).toHaveBeenCalled()
      expect(adapter.editMessage).toHaveBeenCalledTimes(1)
      expect(
        vi.mocked(adapter.editMessage).mock.calls.some(c => String(c[2]).includes('Done.'))
      ).toBe(false)

      // Pending approval was cleared
      await reader.handleMessages([makeTelegramMessage('cancel-check', '/approve')])
      expect(rpc.sendApproval).not.toHaveBeenCalled()
    }

    // Part (ii-a): onTerminal receiving TaskResultHttpError(404/403) aborts cleanly without 'Final response is still syncing.'
    for (const status of [404, 403] as const) {
      streamControl.calls.length = 0
      const adapter = makeStubAdapter('telegram')
      const getTaskResult = vi.fn(async () => {
        throw new TaskResultHttpError(status, `Failed to get task result: ${status}`)
      })
      const rpc = makeRpc({
        sendMessage: vi.fn(async () => ({
          success: true,
          status: 'pending' as const,
          taskId: `task-term-${status}`,
        })),
        getTaskResult,
      })
      const reader = new ChannelReader({
        rpcClient: rpc,
        notificationDeliveryClient: null,
        adapters: new Map([['telegram', adapter]]),
      })
      await reader.handleMessages([makeTelegramMessage(`term-${status}`)])
      const stream = streamControl.calls[0]!
      await stream.onTerminal({ taskId: `task-term-${status}`, status: 'completed' })

      expect(getTaskResult).toHaveBeenCalledTimes(1)
      expect(stream.close).toHaveBeenCalledTimes(1)
      expect(adapter.editMessage).not.toHaveBeenCalled()
    }

    // Part (ii-b): onError('task_not_found_or_expired') receiving 404/403 aborts cleanly without 'Still processing'
    for (const status of [404, 403] as const) {
      streamControl.calls.length = 0
      const adapter = makeStubAdapter('telegram')
      const getTaskResult = vi.fn(async () => {
        throw new TaskResultHttpError(status, `Failed to get task result: ${status}`)
      })
      const rpc = makeRpc({
        sendMessage: vi.fn(async () => ({
          success: true,
          status: 'pending' as const,
          taskId: `task-err-${status}`,
        })),
        getTaskResult,
      })
      const reader = new ChannelReader({
        rpcClient: rpc,
        notificationDeliveryClient: null,
        adapters: new Map([['telegram', adapter]]),
      })
      await reader.handleMessages([makeTelegramMessage(`err-${status}`)])
      const stream = streamControl.calls[0]!
      await stream.onError('task_not_found_or_expired')

      expect(getTaskResult).toHaveBeenCalledTimes(1)
      expect(stream.close).toHaveBeenCalledTimes(1)
      expect(adapter.editMessage).not.toHaveBeenCalled()
    }

    // Part (ii-c): startResultPollingFallback (started automatically for slack) aborts on 404 without retrying
    {
      vi.useFakeTimers()
      streamControl.calls.length = 0
      const adapter = makeStubAdapter('slack')
      const getTaskResult = vi.fn(async () => {
        throw new TaskResultHttpError(404, 'Failed to get task result: 404')
      })
      const rpc = makeRpc({
        sendMessage: vi.fn(async () => ({
          success: true,
          status: 'pending' as const,
          taskId: 'task-poll-404',
        })),
        getTaskResult,
      })
      const reader = new ChannelReader({
        rpcClient: rpc,
        notificationDeliveryClient: null,
        adapters: new Map([['slack', adapter]]),
      })
      await reader.handleMessages([
        {
          channelType: 'slack',
          channelId: 'C1',
          sender: 'U1',
          content: 'poll test',
          timestamp: new Date(),
          messageId: '1700.1',
          providerIdentity: {
            medium: 'slack',
            providerUserId: 'U1',
            providerWorkspaceId: 'T1',
            providerChannelId: 'C1',
            providerEventId: 'slack:T1:C1:poll-404',
          },
        },
      ])
      const stream = streamControl.calls[0]!

      // Advance past multiple poll intervals: must call getTaskResult ONCE and then stop
      await vi.advanceTimersByTimeAsync(10_000)

      expect(getTaskResult).toHaveBeenCalledTimes(1)
      expect(stream.close).toHaveBeenCalledTimes(1)
      expect(adapter.editMessage).not.toHaveBeenCalled()
      vi.useRealTimers()
    }

    // Liveness witness: transient 500 on onError('task_not_found_or_expired') DOES edit 'Still processing'
    {
      streamControl.calls.length = 0
      const adapter = makeStubAdapter('telegram')
      const rpc = makeRpc({
        sendMessage: vi.fn(async () => ({
          success: true,
          status: 'pending' as const,
          taskId: 'task-err-500',
        })),
        getTaskResult: vi.fn(async () => {
          throw new TaskResultHttpError(500, 'Failed to get task result: 500')
        }),
      })
      const reader = new ChannelReader({
        rpcClient: rpc,
        notificationDeliveryClient: null,
        adapters: new Map([['telegram', adapter]]),
      })
      await reader.handleMessages([makeTelegramMessage('err-500')])
      const stream = streamControl.calls[0]!
      await stream.onError('task_not_found_or_expired')
      expect(adapter.editMessage).toHaveBeenCalledWith(
        '111222',
        'status-msg-1',
        expect.stringContaining('Still processing'),
        undefined
      )
    }
  })

  it('BR-T2 · real HTTP loopback RPCClient approval/denial 503 retryable retains vs 403 cancelled deletes pendingApprovals', async () => {
    let approveAttempt = 0
    let denyAttempt = 0
    let currentTaskResultStatus = 200
    let currentRequestId = 'req-http-1'
    let currentTaskId = 'task-http-1'

    const { server, baseUrl } = await startLoopbackServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      if (req.url === '/v1/runtime/provider-messages/authorize') {
        res.statusCode = 200
        res.end(JSON.stringify({ authorized: true }))
        return
      }
      if (req.url?.startsWith('/v1/runtime/messages')) {
        res.statusCode = 200
        res.end(JSON.stringify({ success: true, status: 'pending', taskId: currentTaskId }))
        return
      }
      if (req.url?.startsWith('/v1/runtime/tasks/') && req.url.endsWith('/result')) {
        res.statusCode = currentTaskResultStatus
        if (currentTaskResultStatus === 200) {
          res.end(
            JSON.stringify({
              success: true,
              status: 'waiting_approval',
              approval: {
                taskId: currentTaskId,
                requestId: currentRequestId,
                userId: '123456',
                notification: `Approve ${currentRequestId}`,
              },
            })
          )
        } else {
          res.end(JSON.stringify({ error: 'Task not found' }))
        }
        return
      }
      if (req.url === '/v1/runtime/approvals/approve') {
        approveAttempt += 1
        if (approveAttempt === 1) {
          res.statusCode = 503
          res.end(
            JSON.stringify({
              success: false,
              error: 'identity_check_unavailable',
              retryable: true,
            })
          )
          return
        }
        if (approveAttempt === 2) {
          res.statusCode = 200
          res.end(JSON.stringify({ success: true }))
          return
        }
        // Attempt 3: permanent 403 cancelled
        res.statusCode = 403
        res.end(
          JSON.stringify({
            success: false,
            error: 'approval_identity_revoked',
            cancelled: true,
          })
        )
        return
      }
      if (req.url === '/v1/runtime/approvals/deny') {
        denyAttempt += 1
        if (denyAttempt === 1) {
          res.statusCode = 503
          res.end(
            JSON.stringify({
              success: false,
              error: 'identity_check_unavailable',
              retryable: true,
            })
          )
          return
        }
        if (denyAttempt === 2) {
          res.statusCode = 200
          res.end(JSON.stringify({ success: true }))
          return
        }
        // Attempt 3: permanent 403 cancelled
        res.statusCode = 403
        res.end(
          JSON.stringify({
            success: false,
            error: 'approval_identity_revoked',
            cancelled: true,
          })
        )
        return
      }
      res.statusCode = 404
      res.end(JSON.stringify({ error: 'not_found' }))
    })

    try {
      const rpcClient = new RPCClient(baseUrl, { sleep: async () => undefined })

      // Verify real HTTP getTaskResult throws TaskResultHttpError with status 404
      currentTaskResultStatus = 404
      await expect(rpcClient.getTaskResult('missing-task')).rejects.toMatchObject({
        name: 'TaskResultHttpError',
        status: 404,
      })
      currentTaskResultStatus = 200

      const adapter = makeStubAdapter('telegram')
      const reader = new ChannelReader({
        rpcClient,
        notificationDeliveryClient: null,
        adapters: new Map([['telegram', adapter]]),
      })

      // 1. Approve flow: 503 retryable retains pendingApprovals; retry 200 clears it
      await reader.handleMessages([makeTelegramMessage('http-1', 'run tool 1')])
      await streamControl.calls[0]!.onSuspended({
        taskId: 'task-http-1',
        requestId: 'req-http-1',
        toolName: 'tool_1',
        displayName: 'Tool 1',
        reason: 'approval_required',
      })

      await reader.handleMessages([makeTelegramMessage('http-1-a1', '/approve')])
      expect(approveAttempt).toBe(1)
      expect(adapter.sendMessage).toHaveBeenLastCalledWith(
        '111222',
        expect.stringContaining('identity_check_unavailable'),
        'msg-http-1-a1',
        undefined,
        undefined
      )

      // Liveness witness: retry succeeds because pendingApprovals was retained on 503 retryable
      await reader.handleMessages([makeTelegramMessage('http-1-a2', '/approve')])
      expect(approveAttempt).toBe(2)
      expect(adapter.sendMessage).toHaveBeenLastCalledWith(
        '111222',
        expect.stringContaining('Approved. Processing...'),
        'msg-http-1-a2',
        undefined,
        undefined
      )

      // 2. Approve flow: 403 cancelled deletes pendingApprovals immediately
      currentTaskId = 'task-http-2'
      currentRequestId = 'req-http-2'
      await reader.handleMessages([makeTelegramMessage('http-2', 'run tool 2')])
      await streamControl.calls[1]!.onSuspended({
        taskId: 'task-http-2',
        requestId: 'req-http-2',
        toolName: 'tool_2',
        displayName: 'Tool 2',
        reason: 'approval_required',
      })
      await reader.handleMessages([makeTelegramMessage('http-2-a1', '/approve')])
      expect(approveAttempt).toBe(3)
      // Subsequent /approve finds NO pending approval because 403 cancelled deleted it
      await reader.handleMessages([makeTelegramMessage('http-2-a2', '/approve')])
      expect(approveAttempt).toBe(3)
      expect(adapter.sendMessage).toHaveBeenLastCalledWith(
        '111222',
        expect.stringContaining('No pending approval found'),
        'msg-http-2-a2',
        undefined,
        undefined
      )

      // 3. Deny flow: 503 retryable retains -> retry 200 clears -> next 403 cancelled deletes
      currentTaskId = 'task-http-3'
      currentRequestId = 'req-http-3'
      await reader.handleMessages([makeTelegramMessage('http-3', 'run tool 3')])
      await streamControl.calls[2]!.onSuspended({
        taskId: 'task-http-3',
        requestId: 'req-http-3',
        toolName: 'tool_3',
        displayName: 'Tool 3',
        reason: 'approval_required',
      })
      await reader.handleMessages([makeTelegramMessage('http-3-d1', '/deny')])
      expect(denyAttempt).toBe(1)
      await reader.handleMessages([makeTelegramMessage('http-3-d2', '/deny')])
      expect(denyAttempt).toBe(2)
      expect(adapter.sendMessage).toHaveBeenLastCalledWith(
        '111222',
        expect.stringContaining('Denied.'),
        'msg-http-3-d2',
        undefined,
        undefined
      )

      currentTaskId = 'task-http-4'
      currentRequestId = 'req-http-4'
      await reader.handleMessages([makeTelegramMessage('http-4', 'run tool 4')])
      await streamControl.calls[3]!.onSuspended({
        taskId: 'task-http-4',
        requestId: 'req-http-4',
        toolName: 'tool_4',
        displayName: 'Tool 4',
        reason: 'approval_required',
      })
      await reader.handleMessages([makeTelegramMessage('http-4-d1', '/deny')])
      expect(denyAttempt).toBe(3)
      await reader.handleMessages([makeTelegramMessage('http-4-d2', '/deny')])
      expect(denyAttempt).toBe(3)
      expect(adapter.sendMessage).toHaveBeenLastCalledWith(
        '111222',
        expect.stringContaining('No pending approval found'),
        'msg-http-4-d2',
        undefined,
        undefined
      )
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})
