import { beforeEach, describe, expect, it, vi } from 'vitest'
import { pool } from '../src/db.js'
import {
  acknowledgeNotificationDelivery,
  failNotificationDelivery,
  resolvePendingWorkflowApprovalDelivery,
} from '../src/services/notificationDeliveryQueueService.js'

vi.mock('../src/db.js', () => ({
  pool: {
    query: vi.fn(),
  },
  withTransaction: vi.fn(),
}))

const mockedPoolQuery = vi.mocked(pool.query) as ReturnType<typeof vi.fn>

describe('notificationDeliveryTerminalService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedPoolQuery.mockReset()
  })

  it('acknowledges or fails queued/retrying deliveries with event-specific predicates', async () => {
    mockedPoolQuery
      .mockResolvedValueOnce({ rows: [{ id: 'delivery-1' }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)

    await expect(
      acknowledgeNotificationDelivery({
        id: 'delivery-1',
        medium: 'telegram',
        providerUserId: '123456',
        providerChannelId: 'telegram-chat-1',
        hostRef: 'chatllm',
      })
    ).resolves.toBe(true)
    await expect(
      failNotificationDelivery({
        id: 'delivery-2',
        medium: 'telegram',
        providerUserId: '123456',
        providerChannelId: 'telegram-chat-1',
        hostRef: 'chatllm',
      })
    ).resolves.toBe(false)

    expect(mockedPoolQuery).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("SET status = 'sent'"),
      ['delivery-1', 'telegram', 'telegram-chat-1', 'chatllm', null, '123456']
    )
    expect(mockedPoolQuery).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining(
        "SET status = CASE WHEN attempts >= 5 THEN 'failed' ELSE 'retrying' END"
      ),
      ['delivery-2', 'telegram', 'telegram-chat-1', 'chatllm', null, '123456']
    )
    const ackSql = String(mockedPoolQuery.mock.calls[0]![0])
    const failSql = String(mockedPoolQuery.mock.calls[1]![0])
    // S4: a successful 'sent' ACK records which channel delivered it; the
    // retry/failed path must never write delivered_medium.
    expect(ackSql).toContain("status = 'sent', delivered_medium = $2")
    expect(failSql).not.toContain('delivered_medium')
    expect(ackSql).toContain("'approval.requested'")
    expect(ackSql).toContain("'approval.updated'")
    expect(ackSql).toContain("'workflow.run.completed'")
    expect(ackSql).toContain("'plugin_workload_sdk.notification'")
    expect(ackSql).toContain("event_type = 'approval.requested'")
    expect(ackSql).toContain("event_type = 'approval.updated'")
    expect(ackSql).toContain("event_type = 'workflow.run.completed'")
    expect(ackSql).toContain("event_type = 'plugin_workload_sdk.notification'")
    expect(ackSql).toContain('wati.trigger_caller_key = $4')
    expect(ackSql).not.toContain('JOIN workflow_approval_trigger_run_intents watri')
    expect(ackSql).not.toContain("watri.actor_type = 'user'")
    expect(ackSql).not.toContain('watri.actor_id = wama.user_id')
    expect(ackSql).toContain('team_members tm')
    expect(ackSql).toContain("notification_deliveries.audience->>'teamId'")
    expect(ackSql).toContain("tm.status = 'active'")
    expect(ackSql).toContain(
      "notification_deliveries.payload #>> '{metadata,workflowTrigger,providerBinding,providerChannelId}' = $3"
    )
    expect(ackSql).toContain('wama.provider_channel_id = $3')
    expect(ackSql).toContain('wama.provider_user_id = $6')
    expect(ackSql).toContain('wama.provider_workspace_id = $5')
    expect(ackSql).toContain(
      "notification_deliveries.payload->>'status' IN ('approved', 'denied', 'cancelled', 'expired', 'consumed')"
    )
    expect(ackSql).toContain(
      "war.status IN ('approved', 'denied', 'cancelled', 'expired', 'consumed')"
    )
    expect(ackSql).toContain(
      "war.payload #>> '{metadata,workflowTrigger,providerBinding,providerChannelId}' = $3"
    )
    expect(ackSql).toContain("wr.phase IN ('Succeeded', 'Failed', 'Canceled')")
    expect(ackSql).toContain("notification_deliveries.payload->>'providerMedium' = wama.medium")
    expect(ackSql).toContain(
      "notification_deliveries.payload->>'providerChannelId' = wama.provider_channel_id"
    )
    expect(failSql).toContain('wati.trigger_caller_key = $4')
    expect(failSql).not.toContain('watri.actor_id = wama.user_id')
    expect(failSql).toContain('wama.provider_channel_id = $3')
    expect(failSql).toContain('wama.provider_user_id = $6')
    expect(failSql).toContain('wama.provider_workspace_id = $5')
  })

  it('acknowledges plugin workload SDK deliveries by user/medium binding', async () => {
    mockedPoolQuery.mockResolvedValueOnce({ rows: [{ id: 'sdk-1' }], rowCount: 1 } as any)

    await expect(
      acknowledgeNotificationDelivery({
        id: 'sdk-1',
        medium: 'telegram',
        providerUserId: '424242',
        providerChannelId: 'telegram-private-1',
        hostRef: 'chatllm',
      })
    ).resolves.toBe(true)

    const sdkSql = String(mockedPoolQuery.mock.calls[0]![0])
    expect(sdkSql).toContain("event_type = 'plugin_workload_sdk.notification'")
    expect(sdkSql).toContain("wama.user_id::text = notification_deliveries.audience->>'userId'")
    expect(sdkSql).toContain('wama.medium = $2')
    expect(sdkSql).toContain('wama.provider_user_id = $6')
    expect(sdkSql).toContain('wama.provider_channel_id = $3')
    expect(sdkSql).toContain('wama.disabled_at IS NULL')
    expect(mockedPoolQuery).toHaveBeenCalledWith(expect.any(String), [
      'sdk-1',
      'telegram',
      'telegram-private-1',
      'chatllm',
      null,
      '424242',
    ])
  })

  it('transitions the SDK invocation accepted → delivered on a successful channel ACK', async () => {
    // Call 1: the terminal delivery UPDATE returns the SDK event type + the
    // invocation id (payload notificationId). Call 2: the invocation UPDATE.
    mockedPoolQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'sdk-1',
            eventType: 'plugin_workload_sdk.notification',
            notificationId: 'invocation-1',
          },
        ],
        rowCount: 1,
      } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any)

    await expect(
      acknowledgeNotificationDelivery({
        id: 'sdk-1',
        medium: 'telegram',
        providerUserId: '424242',
        providerChannelId: 'telegram-private-1',
        hostRef: 'chatllm',
      })
    ).resolves.toBe(true)

    expect(mockedPoolQuery).toHaveBeenCalledTimes(2)
    const invocationSql = String(mockedPoolQuery.mock.calls[1]![0])
    expect(invocationSql).toContain('UPDATE plugin_workload_sdk_invocations')
    // Guarded transition: only from 'accepted', sets completed_at.
    expect(mockedPoolQuery.mock.calls[1]![1]).toEqual([
      'invocation-1',
      'delivered',
      true,
      'accepted',
    ])
  })

  it('does NOT transition the invocation when the channel delivery fails/retries', async () => {
    mockedPoolQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'sdk-1',
          eventType: 'plugin_workload_sdk.notification',
          notificationId: 'invocation-1',
        },
      ],
      rowCount: 1,
    } as any)

    await failNotificationDelivery({
      id: 'sdk-1',
      medium: 'telegram',
      providerUserId: '424242',
      providerChannelId: 'telegram-private-1',
      hostRef: 'chatllm',
    })

    // Only the delivery UPDATE ran — no invocation transition on a failed send.
    expect(mockedPoolQuery).toHaveBeenCalledTimes(1)
  })

  it('does NOT transition any invocation for a non-SDK (approval) ACK', async () => {
    mockedPoolQuery.mockResolvedValueOnce({
      rows: [{ id: 'delivery-1', eventType: 'approval.requested', notificationId: null }],
      rowCount: 1,
    } as any)

    await acknowledgeNotificationDelivery({
      id: 'delivery-1',
      medium: 'telegram',
      providerUserId: '123456',
      providerChannelId: 'telegram-chat-1',
      hostRef: 'chatllm',
    })

    expect(mockedPoolQuery).toHaveBeenCalledTimes(1)
  })

  it('requires Slack workspace identity before terminal delivery updates', async () => {
    await expect(
      acknowledgeNotificationDelivery({
        id: 'delivery-1',
        medium: 'slack',
        providerUserId: 'U123',
        providerChannelId: 'C123',
        hostRef: 'chatllm',
      })
    ).rejects.toThrow('provider_workspace_id_required')
    expect(mockedPoolQuery).not.toHaveBeenCalled()
  })

  it('rejects terminal delivery updates without provider channel and host binding', async () => {
    await expect(
      acknowledgeNotificationDelivery({
        id: 'delivery-1',
        medium: 'telegram',
        providerUserId: '123456',
        providerChannelId: '',
        hostRef: 'chatllm',
      })
    ).rejects.toThrow('provider_channel_id_required')
    await expect(
      failNotificationDelivery({
        id: 'delivery-2',
        medium: 'telegram',
        providerUserId: '123456',
        providerChannelId: 'telegram-chat-1',
        hostRef: '',
      })
    ).rejects.toThrow('host_ref_required')
    await expect(
      failNotificationDelivery({
        id: 'delivery-3',
        medium: 'telegram',
        providerUserId: '',
        providerChannelId: 'telegram-chat-1',
        hostRef: 'chatllm',
      })
    ).rejects.toThrow('provider_user_id_required')
    expect(mockedPoolQuery).not.toHaveBeenCalled()
  })

  it('resolves a sent pending workflow approval by provider binding and recipe name', async () => {
    mockedPoolQuery.mockResolvedValueOnce({
      rows: [{ id: '00000000-0000-0000-0000-000000000333' }],
      rowCount: 1,
    } as any)

    await expect(
      resolvePendingWorkflowApprovalDelivery({
        medium: 'telegram',
        providerUserId: '123456',
        providerChannelId: 'telegram-chat-1',
        hostRef: 'chatllm',
        recipeName: 'team.daily-report',
      })
    ).resolves.toEqual({
      status: 'found',
      approvalRequestId: '00000000-0000-0000-0000-000000000333',
    })

    const sql = String(mockedPoolQuery.mock.calls[0]![0])
    expect(sql).toContain("nd.status = 'sent'")
    expect(sql).toContain('team_members tm')
    expect(sql).toContain("nd.audience->>'teamId'")
    expect(sql).toContain("tm.status = 'active'")
    expect(sql).toContain("war.status = 'pending'")
    expect(sql).toContain('wati.trigger_caller_key = $3')
    expect(sql).not.toContain('JOIN workflow_approval_trigger_run_intents watri')
    expect(sql).not.toContain("watri.actor_type = 'user'")
    expect(sql).not.toContain('watri.actor_id = wama.user_id')
    expect(sql).toContain('wama.provider_user_id = $6')
    expect(sql).toContain(
      "nd.payload #>> '{metadata,workflowTrigger,providerBinding,providerChannelId}' = $2"
    )
    expect(sql).toContain('war.recipe_name = $5')
    expect(mockedPoolQuery).toHaveBeenCalledWith(expect.any(String), [
      'telegram',
      'telegram-chat-1',
      'chatllm',
      null,
      'team.daily-report',
      '123456',
    ])
  })

  it('requires provider user identity when resolving pending workflow approvals', async () => {
    await expect(
      resolvePendingWorkflowApprovalDelivery({
        medium: 'telegram',
        providerChannelId: 'telegram-chat-1',
        hostRef: 'chatllm',
        recipeName: 'team.daily-report',
      })
    ).rejects.toThrow('provider_user_id_required')
    expect(mockedPoolQuery).not.toHaveBeenCalled()
  })

  it('treats multiple provider-bound sent approvals for the same recipe as ambiguous', async () => {
    mockedPoolQuery.mockResolvedValueOnce({
      rows: [
        { id: '00000000-0000-0000-0000-000000000333' },
        { id: '00000000-0000-0000-0000-000000000444' },
      ],
      rowCount: 2,
    } as any)

    await expect(
      resolvePendingWorkflowApprovalDelivery({
        medium: 'telegram',
        providerUserId: '123456',
        providerChannelId: 'telegram-chat-1',
        hostRef: 'chatllm',
        recipeName: 'due-diligence',
      })
    ).resolves.toEqual({ status: 'ambiguous' })
  })
})
