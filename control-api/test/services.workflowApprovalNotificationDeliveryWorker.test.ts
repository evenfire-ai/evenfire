import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import {
  claimUserBoundNotificationDeliveries,
  markUserBoundNotificationDeliveryFailed,
  markUserBoundNotificationDeliverySent,
  markUserBoundNotificationDeliverySkippedNoBot,
} from '../src/services/notificationDeliveryQueueService.js'
import {
  type DeliveryWorkerConfig,
  deliverWorkflowApprovalNotificationsOnce,
} from '../src/services/workflowApprovalNotificationDeliveryWorker.js'

vi.mock('../src/services/notificationDeliveryQueueService.js', () => ({
  claimUserBoundNotificationDeliveries: vi.fn(),
  markUserBoundNotificationDeliveryFailed: vi.fn(),
  markUserBoundNotificationDeliverySent: vi.fn(),
  markUserBoundNotificationDeliverySkippedNoBot: vi.fn(),
}))

const claimMock = vi.mocked(claimUserBoundNotificationDeliveries)
const sentMock = vi.mocked(markUserBoundNotificationDeliverySent)
const failedMock = vi.mocked(markUserBoundNotificationDeliveryFailed)
const skippedMock = vi.mocked(markUserBoundNotificationDeliverySkippedNoBot)

const baseConfig: DeliveryWorkerConfig = {
  enabled: true,
  intervalMs: 1000,
  batchSize: 10,
  telegramApiRoot: 'http://provider.local',
  slackApiRoot: 'http://provider.local',
}

function compactApprovalId(id: string): string {
  return Buffer.from(id.replace(/-/g, ''), 'hex').toString('base64url')
}

function routeAlias(hostRef: string): string {
  return createHash('sha256').update(hostRef).digest('hex').slice(0, 16)
}

function approvalDelivery(overrides: Record<string, unknown> = {}) {
  return {
    id: 'delivery-1',
    eventType: 'approval.requested',
    attempts: 1,
    medium: 'telegram',
    providerUserId: '123',
    providerWorkspaceId: null,
    providerChannelId: '123',
    mcpHostRef: 'sandbox-recipes/runtime-recipe',
    payload: {
      approvalRequestId: '99999999-8888-7777-6666-555555555555',
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'runtime-recipe',
      title: 'Approve runtime recipe',
      body: 'Approval requested for sandbox-recipes/runtime-recipe',
      actions: [
        {
          id: 'approve:99999999-8888-7777-6666-555555555555',
          decision: 'approve',
          label: 'Approve',
        },
        { id: 'deny:99999999-8888-7777-6666-555555555555', decision: 'deny', label: 'Deny' },
      ],
      metadata: {},
    },
    ...overrides,
  } as any
}

describe('workflowApprovalNotificationDeliveryWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sentMock.mockResolvedValue(true)
    failedMock.mockResolvedValue(true)
    skippedMock.mockResolvedValue(true)
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, channel: { id: 'D-figure-d' } }),
    } as Response)
  })

  it('claims both media without global provider credentials', async () => {
    claimMock.mockResolvedValue([])

    await expect(deliverWorkflowApprovalNotificationsOnce(baseConfig)).resolves.toBe(0)

    expect(claimMock).toHaveBeenCalledTimes(2)
    expect(claimMock).toHaveBeenCalledWith({
      medium: 'telegram',
      providerWorkspaceId: null,
      limit: 10,
    })
    expect(claimMock).toHaveBeenCalledWith({
      medium: 'slack',
      providerWorkspaceId: null,
      limit: 10,
    })
    expect(global.fetch).not.toHaveBeenCalled()
    expect(sentMock).not.toHaveBeenCalled()
    expect(failedMock).not.toHaveBeenCalled()
    expect(skippedMock).not.toHaveBeenCalled()
  })

  it('marks telegram skipped_no_bot when the delivery has no channel ref', async () => {
    claimMock
      .mockResolvedValueOnce([approvalDelivery({ communicationChannelRef: null })])
      .mockResolvedValueOnce([])

    await expect(deliverWorkflowApprovalNotificationsOnce({ ...baseConfig })).resolves.toBe(1)

    expect(global.fetch).not.toHaveBeenCalled()
    expect(skippedMock).toHaveBeenCalledWith('delivery-1')
    expect(sentMock).not.toHaveBeenCalled()
    expect(failedMock).not.toHaveBeenCalled()
  })

  it('resolves the per-channel bot token from the channel Secret', async () => {
    claimMock
      .mockResolvedValueOnce([approvalDelivery({ communicationChannelRef: 'channels/cc-a' })])
      .mockResolvedValueOnce([])
    const resolver = { resolve: vi.fn().mockResolvedValue({ telegramBotToken: 'cc-a-token' }) }

    await expect(
      deliverWorkflowApprovalNotificationsOnce({ ...baseConfig }, resolver)
    ).resolves.toBe(1)

    expect(resolver.resolve).toHaveBeenCalledWith('channels/cc-a')
    const fetchCall = vi.mocked(global.fetch).mock.calls[0]!
    expect(String(fetchCall[0])).toBe('http://provider.local/botcc-a-token/sendMessage')
    expect(sentMock).toHaveBeenCalledWith('delivery-1')
  })

  it('marks skipped_no_bot when channel ref present but its Secret has no bot (NO global fallback → no cross-bot)', async () => {
    claimMock
      .mockResolvedValueOnce([approvalDelivery({ communicationChannelRef: 'channels/cc-a' })])
      .mockResolvedValueOnce([])
    // Resolver finds the channel but its Secret carries no telegram token.
    const resolver = { resolve: vi.fn().mockResolvedValue({}) }

    // cfg STILL has a global token — using it would deliver via the wrong bot.
    await expect(
      deliverWorkflowApprovalNotificationsOnce({ ...baseConfig }, resolver)
    ).resolves.toBe(1)

    expect(global.fetch).not.toHaveBeenCalled()
    expect(skippedMock).toHaveBeenCalledWith('delivery-1')
    expect(sentMock).not.toHaveBeenCalled()
    expect(failedMock).not.toHaveBeenCalled()
  })

  it('marks transient_failure (retry) when the resolver throws (Secret read error, not no_bot)', async () => {
    claimMock
      .mockResolvedValueOnce([approvalDelivery({ communicationChannelRef: 'channels/cc-a' })])
      .mockResolvedValueOnce([])
    const resolver = {
      resolve: vi.fn().mockRejectedValue(Object.assign(new Error('rbac'), { code: 403 })),
    }

    await expect(
      deliverWorkflowApprovalNotificationsOnce({ ...baseConfig }, resolver)
    ).resolves.toBe(1)

    expect(failedMock).toHaveBeenCalledWith('delivery-1')
    expect(skippedMock).not.toHaveBeenCalled()
    expect(sentMock).not.toHaveBeenCalled()
  })

  it('treats a Telegram HTTP-200 with ok:false (provider error) as a failure, never sent', async () => {
    claimMock
      .mockResolvedValueOnce([approvalDelivery({ communicationChannelRef: 'channels/cc-a' })])
      .mockResolvedValueOnce([])
    const resolver = { resolve: vi.fn().mockResolvedValue({ telegramBotToken: 'cc-a-token' }) }
    // Telegram answers 200 OK but {ok:false} (e.g. 400 chat-not-found / 403 blocked).
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: false,
        error_code: 400,
        description: 'Bad Request: chat not found',
      }),
    } as Response)

    await expect(deliverWorkflowApprovalNotificationsOnce(baseConfig, resolver)).resolves.toBe(1)

    expect(resolver.resolve).toHaveBeenCalledWith('channels/cc-a')
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(failedMock).toHaveBeenCalledWith('delivery-1')
    expect(sentMock).not.toHaveBeenCalled()
    expect(skippedMock).not.toHaveBeenCalled()
  })

  it('channel-bound delivery with NO resolver → skipped_no_bot, NEVER the global bot (cross-bot guard)', async () => {
    claimMock
      .mockResolvedValueOnce([approvalDelivery({ communicationChannelRef: 'channels/cc-a' })])
      .mockResolvedValueOnce([])

    // No resolver passed (no gateway) AND a global token IS configured. The
    // delivery is channel-bound, so it must NOT fall back to the global bot.
    await expect(deliverWorkflowApprovalNotificationsOnce({ ...baseConfig })).resolves.toBe(1)

    expect(global.fetch).not.toHaveBeenCalled()
    expect(skippedMock).toHaveBeenCalledWith('delivery-1')
    expect(sentMock).not.toHaveBeenCalled()
    expect(failedMock).not.toHaveBeenCalled()
  })

  it('sends Telegram approval DMs with a sandbox-recipes runtime route hint', async () => {
    claimMock
      .mockResolvedValueOnce([approvalDelivery({ communicationChannelRef: 'channels/cc-a' })])
      .mockResolvedValueOnce([])
    const resolver = { resolve: vi.fn().mockResolvedValue({ telegramBotToken: 'cc-a-token' }) }

    await expect(deliverWorkflowApprovalNotificationsOnce(baseConfig, resolver)).resolves.toBe(1)

    expect(claimMock).toHaveBeenCalledWith({
      medium: 'telegram',
      providerWorkspaceId: null,
      limit: 10,
    })
    const fetchCall = vi.mocked(global.fetch).mock.calls[0]!
    expect(String(fetchCall[0])).toBe('http://provider.local/botcc-a-token/sendMessage')
    const body = JSON.parse(String((fetchCall[1] as RequestInit).body))
    expect(body.chat_id).toBe('123')
    expect(body.text).toContain('runtime-recipe')
    const callbackData = body.reply_markup.inline_keyboard[0][0].callback_data
    expect(callbackData).toBe(
      `a:${compactApprovalId('99999999-8888-7777-6666-555555555555')}:~${routeAlias(
        'sandbox-recipes/runtime-recipe'
      )}:${routeAlias('channels/cc-a')}`
    )
    expect(Buffer.byteLength(callbackData, 'utf8')).toBeLessThanOrEqual(64)
    expect(sentMock).toHaveBeenCalledWith('delivery-1')
    expect(failedMock).not.toHaveBeenCalled()
  })

  it('posts Slack approval actions into the verified conversation', async () => {
    claimMock.mockResolvedValueOnce([]).mockResolvedValueOnce([
      approvalDelivery({
        medium: 'slack',
        providerUserId: 'U123',
        providerWorkspaceId: 'T-figure-d',
        providerChannelId: 'D-figure-d',
        communicationChannelRef: 'channels/slack-a',
      }),
    ])
    const resolver = { resolve: vi.fn().mockResolvedValue({ slackBotToken: 'slack-a-token' }) }

    await expect(deliverWorkflowApprovalNotificationsOnce(baseConfig, resolver)).resolves.toBe(1)

    expect(claimMock).toHaveBeenCalledWith({
      medium: 'slack',
      providerWorkspaceId: null,
      limit: 10,
    })
    expect(resolver.resolve).toHaveBeenCalledWith('channels/slack-a')
    const calls = vi.mocked(global.fetch).mock.calls
    expect(calls).toHaveLength(1)
    expect(String(calls[0]![0])).toBe('http://provider.local/chat.postMessage')
    const postBody = JSON.parse(String((calls[0]![1] as RequestInit).body))
    expect(postBody.channel).toBe('D-figure-d')
    expect(postBody.thread_ts).toBeUndefined()
    expect(postBody.blocks[1].elements[0].action_id).toBe('workflow_approval_approve')
    expect(postBody.blocks[1].elements[0].style).toBe('primary')
    expect(postBody.blocks[1].elements[0].value).toBe(
      `approve:99999999-8888-7777-6666-555555555555:sandbox-recipes/runtime-recipe:${routeAlias(
        'channels/slack-a'
      )}`
    )
    expect(postBody.blocks[1].elements[1].action_id).toBe('workflow_approval_deny')
    expect(postBody.blocks[1].elements[1].style).toBe('danger')
    expect(sentMock).toHaveBeenCalledWith('delivery-1')
  })

  it('posts Slack workflow-trigger approvals in the source thread', async () => {
    claimMock.mockResolvedValueOnce([]).mockResolvedValueOnce([
      approvalDelivery({
        medium: 'slack',
        providerUserId: 'U123',
        providerWorkspaceId: 'T-figure-d',
        providerChannelId: 'D-figure-d',
        communicationChannelRef: 'channels/slack-a',
        payload: {
          ...approvalDelivery().payload,
          metadata: {
            workflowTrigger: {
              providerBinding: {
                medium: 'slack',
                providerWorkspaceId: 'T-figure-d',
                providerChannelId: 'C-threaded',
                providerThreadId: '1710000000.000001',
              },
            },
          },
        },
      }),
    ])
    const resolver = { resolve: vi.fn().mockResolvedValue({ slackBotToken: 'slack-a-token' }) }

    await expect(deliverWorkflowApprovalNotificationsOnce(baseConfig, resolver)).resolves.toBe(1)

    const calls = vi.mocked(global.fetch).mock.calls
    expect(calls).toHaveLength(1)
    expect(String(calls[0]![0])).toBe('http://provider.local/chat.postMessage')
    const postBody = JSON.parse(String((calls[0]![1] as RequestInit).body))
    expect(postBody.channel).toBe('C-threaded')
    expect(postBody.thread_ts).toBe('1710000000.000001')
    expect(postBody.blocks[1].elements[0].value).toBe(
      `approve:99999999-8888-7777-6666-555555555555:sandbox-recipes/runtime-recipe:${routeAlias(
        'channels/slack-a'
      )}`
    )
    expect(sentMock).toHaveBeenCalledWith('delivery-1')
  })

  it('marks Slack skipped_no_bot when the delivery has no channel ref', async () => {
    claimMock.mockResolvedValueOnce([]).mockResolvedValueOnce([
      approvalDelivery({
        medium: 'slack',
        providerUserId: 'U123',
        providerWorkspaceId: 'T-figure-d',
        providerChannelId: 'D-figure-d',
        communicationChannelRef: null,
      }),
    ])

    await expect(deliverWorkflowApprovalNotificationsOnce(baseConfig)).resolves.toBe(1)

    expect(global.fetch).not.toHaveBeenCalled()
    expect(skippedMock).toHaveBeenCalledWith('delivery-1')
    expect(sentMock).not.toHaveBeenCalled()
    expect(failedMock).not.toHaveBeenCalled()
  })

  it('marks Slack skipped_no_bot when the channel Secret has no Slack bot token', async () => {
    claimMock.mockResolvedValueOnce([]).mockResolvedValueOnce([
      approvalDelivery({
        medium: 'slack',
        providerUserId: 'U123',
        providerWorkspaceId: 'T-figure-d',
        providerChannelId: 'D-figure-d',
        communicationChannelRef: 'channels/slack-a',
      }),
    ])
    const resolver = { resolve: vi.fn().mockResolvedValue({ telegramBotToken: 'tg-token' }) }

    await expect(deliverWorkflowApprovalNotificationsOnce(baseConfig, resolver)).resolves.toBe(1)

    expect(resolver.resolve).toHaveBeenCalledWith('channels/slack-a')
    expect(global.fetch).not.toHaveBeenCalled()
    expect(skippedMock).toHaveBeenCalledWith('delivery-1')
    expect(sentMock).not.toHaveBeenCalled()
  })

  it('marks channel-bound Slack skipped_no_bot when no resolver is available', async () => {
    claimMock.mockResolvedValueOnce([]).mockResolvedValueOnce([
      approvalDelivery({
        medium: 'slack',
        providerUserId: 'U123',
        providerWorkspaceId: 'T-figure-d',
        providerChannelId: 'D-figure-d',
        communicationChannelRef: 'channels/slack-a',
      }),
    ])

    await expect(deliverWorkflowApprovalNotificationsOnce(baseConfig)).resolves.toBe(1)

    expect(global.fetch).not.toHaveBeenCalled()
    expect(skippedMock).toHaveBeenCalledWith('delivery-1')
    expect(sentMock).not.toHaveBeenCalled()
  })

  it('marks a delivery failed when the provider send fails', async () => {
    claimMock
      .mockResolvedValueOnce([approvalDelivery({ communicationChannelRef: 'channels/cc-a' })])
      .mockResolvedValueOnce([])
    const resolver = { resolve: vi.fn().mockResolvedValue({ telegramBotToken: 'cc-a-token' }) }
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ ok: false }),
    } as Response)

    await expect(deliverWorkflowApprovalNotificationsOnce(baseConfig, resolver)).resolves.toBe(1)

    expect(failedMock).toHaveBeenCalledWith('delivery-1')
    expect(sentMock).not.toHaveBeenCalled()
  })

  it('sends Telegram approval DMs for long runtime recipe names through a short route alias', async () => {
    const hostRef =
      'sandbox-recipes/this-runtime-recipe-name-is-too-long-for-telegram-callback-data'
    claimMock
      .mockResolvedValueOnce([
        approvalDelivery({
          mcpHostRef: hostRef,
          communicationChannelRef: 'channels/cc-a',
        }),
      ])
      .mockResolvedValueOnce([])
    const resolver = { resolve: vi.fn().mockResolvedValue({ telegramBotToken: 'cc-a-token' }) }

    await expect(deliverWorkflowApprovalNotificationsOnce(baseConfig, resolver)).resolves.toBe(1)

    const fetchCall = vi.mocked(global.fetch).mock.calls[0]!
    const body = JSON.parse(String((fetchCall[1] as RequestInit).body))
    const callbackData = body.reply_markup.inline_keyboard[0][0].callback_data
    expect(callbackData).toBe(
      `a:${compactApprovalId('99999999-8888-7777-6666-555555555555')}:~${routeAlias(
        hostRef
      )}:${routeAlias('channels/cc-a')}`
    )
    expect(Buffer.byteLength(callbackData, 'utf8')).toBeLessThanOrEqual(64)
    expect(sentMock).toHaveBeenCalledWith('delivery-1')
    expect(failedMock).not.toHaveBeenCalled()
  })

  it('delivers terminal approval updates instead of marking them sent as a no-op', async () => {
    claimMock
      .mockResolvedValueOnce([
        approvalDelivery({
          communicationChannelRef: 'channels/cc-a',
          eventType: 'approval.updated',
          payload: {
            approvalRequestId: '99999999-8888-7777-6666-555555555555',
            recipeNamespace: 'sandbox-recipes',
            recipeName: 'runtime-recipe',
            status: 'cancelled',
          },
        }),
      ])
      .mockResolvedValueOnce([])
    const resolver = { resolve: vi.fn().mockResolvedValue({ telegramBotToken: 'cc-a-token' }) }

    await expect(deliverWorkflowApprovalNotificationsOnce(baseConfig, resolver)).resolves.toBe(1)

    const fetchCall = vi.mocked(global.fetch).mock.calls[0]!
    const body = JSON.parse(String((fetchCall[1] as RequestInit).body))
    expect(body.text).toBe('Approval cancelled for sandbox-recipes/runtime-recipe')
    expect(body.reply_markup).toBeUndefined()
    expect(sentMock).toHaveBeenCalledWith('delivery-1')
  })

  it('delivers Slack workflow completion notifications without action buttons', async () => {
    claimMock.mockResolvedValueOnce([]).mockResolvedValueOnce([
      approvalDelivery({
        eventType: 'workflow.run.completed',
        medium: 'slack',
        providerUserId: 'U123',
        providerWorkspaceId: 'T-figure-d',
        providerChannelId: 'D-figure-d',
        communicationChannelRef: 'channels/slack-a',
        payload: {
          workflowRunId: 'run-1',
          approvalRequestId: '99999999-8888-7777-6666-555555555555',
          recipeNamespace: 'sandbox-recipes',
          recipeName: 'runtime-recipe',
          phase: 'Succeeded',
          providerMedium: 'slack',
          providerChannelId: 'D-figure-d',
          providerWorkspaceId: 'T-figure-d',
          providerThreadId: '1710000000.000001',
          message: 'done',
        },
      }),
    ])
    const resolver = { resolve: vi.fn().mockResolvedValue({ slackBotToken: 'slack-a-token' }) }

    await expect(deliverWorkflowApprovalNotificationsOnce(baseConfig, resolver)).resolves.toBe(1)

    const calls = vi.mocked(global.fetch).mock.calls
    expect(calls).toHaveLength(1)
    expect(String(calls[0]![0])).toBe('http://provider.local/chat.postMessage')
    const postBody = JSON.parse(String((calls[0]![1] as RequestInit).body))
    expect(postBody.text).toContain('Workflow Succeeded for sandbox-recipes/runtime-recipe')
    expect(postBody.thread_ts).toBe('1710000000.000001')
    expect(postBody.blocks).toBeUndefined()
    expect(sentMock).toHaveBeenCalledWith('delivery-1')
  })

  it('rewrites any preexisting action route hint to the claimed runtime mcp-host ref', async () => {
    claimMock
      .mockResolvedValueOnce([
        approvalDelivery({
          communicationChannelRef: 'channels/cc-a',
          payload: {
            ...approvalDelivery().payload,
            actions: [
              {
                id: 'approve:99999999-8888-7777-6666-555555555555:chatllm',
                decision: 'approve',
                label: 'Approve',
              },
            ],
          },
        }),
      ])
      .mockResolvedValueOnce([])
    const resolver = { resolve: vi.fn().mockResolvedValue({ telegramBotToken: 'cc-a-token' }) }

    await expect(deliverWorkflowApprovalNotificationsOnce(baseConfig, resolver)).resolves.toBe(1)

    const fetchCall = vi.mocked(global.fetch).mock.calls[0]!
    const body = JSON.parse(String((fetchCall[1] as RequestInit).body))
    expect(body.reply_markup.inline_keyboard[0][0].callback_data).toBe(
      `a:${compactApprovalId('99999999-8888-7777-6666-555555555555')}:~${routeAlias(
        'sandbox-recipes/runtime-recipe'
      )}:${routeAlias('channels/cc-a')}`
    )
  })
})
