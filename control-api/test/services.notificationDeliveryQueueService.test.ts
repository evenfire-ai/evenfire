import { beforeEach, describe, expect, it, vi } from 'vitest'
import { pool, withTransaction } from '../src/db.js'
import {
  claimNotificationDeliveries,
  claimUserBoundNotificationDeliveries,
  markUserBoundNotificationDeliverySkippedNoBot,
} from '../src/services/notificationDeliveryQueueService.js'

vi.mock('../src/db.js', () => ({
  pool: {
    query: vi.fn(),
  },
  withTransaction: vi.fn(),
}))

const mockedWithTransaction = vi.mocked(withTransaction)
const mockedPoolQuery = vi.mocked(pool.query as unknown as ReturnType<typeof vi.fn>)

describe('notificationDeliveryQueueService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedWithTransaction.mockReset()
  })

  it('claims Telegram approval notifications to the trigger channel while verifying the actor account', async () => {
    const txQuery = vi.fn().mockResolvedValue({
      rows: [
        {
          id: 'delivery-1',
          eventType: 'approval.requested',
          payload: { approvalRequestId: 'approval-1' },
          attempts: 1,
          medium: 'telegram',
          providerUserId: '123456',
          providerWorkspaceId: null,
          providerChannelId: 'telegram-chat-1',
        },
      ],
      rowCount: 1,
    } as any)
    mockedWithTransaction.mockImplementation(async work => work({ query: txQuery } as any))

    await expect(
      claimNotificationDeliveries({
        medium: 'telegram',
        providerChannelIds: ['telegram-chat-1', 'telegram-chat-1', ' '],
        hostRef: 'chatllm',
        limit: '5',
      })
    ).resolves.toEqual([
      {
        id: 'delivery-1',
        eventType: 'approval.requested',
        payload: { approvalRequestId: 'approval-1' },
        attempts: 1,
        medium: 'telegram',
        providerUserId: '123456',
        providerWorkspaceId: null,
        providerChannelId: 'telegram-chat-1',
      },
    ])

    const claimSql = String(txQuery.mock.calls[0]![0])
    expect(claimSql).toContain('JOIN workflow_approval_medium_accounts')
    expect(claimSql).toContain('team_members tm')
    expect(claimSql).toContain("nd.audience->>'teamId'")
    expect(claimSql).toContain("tm.status = 'active'")
    expect(claimSql).toContain('wati.trigger_caller_key = $3')
    expect(claimSql).not.toContain('JOIN workflow_approval_trigger_run_intents watri')
    expect(claimSql).not.toContain("watri.actor_type = 'user'")
    expect(claimSql).not.toContain('watri.actor_id = wama.user_id')
    expect(claimSql).toContain('JOIN workflow_approval_requests war')
    expect(claimSql).toContain("war.status = 'pending'")
    expect(claimSql).toContain('war.expires_at IS NULL OR war.expires_at > NOW()')
    expect(claimSql).toContain("CASE WHEN $1 = 'telegram'")
    expect(claimSql).toContain(
      "war.payload #>> '{metadata,workflowTrigger,providerBinding,providerChannelId}'"
    )
    expect(claimSql).toContain(
      "war.payload #>> '{metadata,workflowTrigger,providerBinding,medium}' = $1"
    )
    expect(claimSql).toContain('wama.provider_channel_id = ANY($2::text[])')
    expect(txQuery).toHaveBeenCalledWith(expect.any(String), [
      'telegram',
      ['telegram-chat-1'],
      'chatllm',
      5,
      null,
    ])
  })

  it('requires and applies Slack workspace binding when claiming approval notifications', async () => {
    const txQuery = vi.fn().mockResolvedValue({
      rows: [
        {
          id: 'delivery-1',
          eventType: 'approval.requested',
          payload: { approvalRequestId: 'approval-1' },
          attempts: 1,
          medium: 'slack',
          providerUserId: 'U123',
          providerWorkspaceId: 'T123',
          providerChannelId: 'C123',
        },
      ],
      rowCount: 1,
    } as any)
    mockedWithTransaction.mockImplementation(async work => work({ query: txQuery } as any))

    await expect(
      claimNotificationDeliveries({
        medium: 'slack',
        providerChannelIds: ['C123'],
        providerWorkspaceId: 'T123',
        hostRef: 'chatllm',
      })
    ).resolves.toMatchObject([
      {
        medium: 'slack',
        providerUserId: 'U123',
        providerWorkspaceId: 'T123',
        providerChannelId: 'C123',
      },
    ])

    const claimSql = String(txQuery.mock.calls[0]![0])
    expect(claimSql).toContain('wama.provider_workspace_id = $5')
    expect(claimSql).toContain(
      "war.payload #>> '{metadata,workflowTrigger,providerBinding,medium}' = $1"
    )
    expect(claimSql).toContain(
      "war.payload #>> '{metadata,workflowTrigger,providerBinding,providerChannelId}' = ANY($2::text[])"
    )
    expect(claimSql).toContain(
      "war.payload #>> '{metadata,workflowTrigger,providerBinding,providerWorkspaceId}' = $5"
    )
    expect(claimSql).toContain(
      "wama.provider_channel_id = war.payload #>> '{metadata,workflowTrigger,providerBinding,providerChannelId}'"
    )
    expect(txQuery).toHaveBeenCalledWith(expect.any(String), [
      'slack',
      ['C123'],
      'chatllm',
      10,
      'T123',
    ])
  })

  it('claims Figure D notifications from verified user bindings without host communication channels', async () => {
    const txQuery = vi.fn().mockResolvedValue({
      rows: [
        {
          id: 'delivery-figd-1',
          eventType: 'approval.requested',
          payload: { approvalRequestId: 'approval-figd-1' },
          attempts: 1,
          medium: 'telegram',
          providerUserId: '123456',
          providerWorkspaceId: null,
          providerChannelId: 'private-telegram-chat',
          mcpHostRef: 'sandbox-recipes/figure-d-caller',
        },
      ],
      rowCount: 1,
    } as any)
    mockedWithTransaction.mockImplementation(async work => work({ query: txQuery } as any))

    await expect(
      claimUserBoundNotificationDeliveries({
        medium: 'telegram',
        limit: '3',
      })
    ).resolves.toEqual([
      {
        id: 'delivery-figd-1',
        eventType: 'approval.requested',
        payload: { approvalRequestId: 'approval-figd-1' },
        attempts: 1,
        medium: 'telegram',
        providerUserId: '123456',
        providerWorkspaceId: null,
        providerChannelId: 'private-telegram-chat',
        mcpHostRef: 'sandbox-recipes/figure-d-caller',
      },
    ])

    const claimSql = String(txQuery.mock.calls[0]![0])
    expect(claimSql).toContain('FROM workflow_approval_medium_accounts wama')
    expect(claimSql).toContain('wama.provider_channel_id IS NOT NULL')
    expect(claimSql).toContain('workflow_approval_medium_accounts preferred')
    expect(claimSql).toContain('preferred.user_id = wama.user_id')
    expect(claimSql).toContain('preferred.updated_at > wama.updated_at')
    expect(claimSql).toContain("NULLIF(war.payload #>> '{metadata,runtimeMcpHostRef}', '')")
    expect(claimSql).toContain('wati.trigger_caller_key')
    expect(claimSql).toContain("~ '^sandbox-recipes/[a-z0-9]([a-z0-9.-]*[a-z0-9])?$'")
    expect(claimSql).toContain(
      "NULLIF(war.payload #>> '{metadata,workflowTrigger,providerBinding,medium}', '') IS NULL"
    )
    expect(claimSql).toContain("nd.audience->>'userId'")
    expect(claimSql).toContain("tm.status = 'active'")
    expect(claimSql).not.toContain('ANY($2::text[])')
    expect(claimSql).not.toContain(
      "war.payload #>> '{metadata,workflowTrigger,providerBinding,providerChannelId}'"
    )
    expect(txQuery).toHaveBeenCalledWith(expect.any(String), ['telegram', 3, null])
  })

  it('claims workflow run completion notifications with terminal-run predicates', async () => {
    const txQuery = vi.fn().mockResolvedValue({
      rows: [
        {
          id: 'delivery-2',
          eventType: 'workflow.run.completed',
          payload: {
            workflowRunId: 'run-1',
            approvalRequestId: 'approval-1',
            recipeName: 'due-diligence',
            phase: 'Succeeded',
            providerMedium: 'telegram',
            providerChannelId: 'telegram-chat-1',
          },
          attempts: 1,
          medium: 'telegram',
          providerUserId: '123456',
          providerWorkspaceId: null,
          providerChannelId: 'telegram-chat-1',
        },
      ],
      rowCount: 1,
    } as any)
    mockedWithTransaction.mockImplementation(async work => work({ query: txQuery } as any))

    const deliveries = await claimNotificationDeliveries({
      medium: 'telegram',
      providerChannelIds: ['telegram-chat-1'],
      hostRef: 'chatllm',
    })

    expect(deliveries[0]?.eventType).toBe('workflow.run.completed')
    const claimSql = String(txQuery.mock.calls[0]![0])
    expect(claimSql).toContain("nd.event_type = 'approval.requested'")
    expect(claimSql).toContain("war.status = 'pending'")
    expect(claimSql).toContain("nd.event_type = 'workflow.run.completed'")
    expect(claimSql).toContain('JOIN workflow_runs wr')
    expect(claimSql).toContain("wr.phase IN ('Succeeded', 'Failed', 'Canceled')")
    expect(claimSql).toContain('wati.trigger_caller_key = $3')
    expect(claimSql).not.toContain('JOIN workflow_approval_trigger_run_intents watri')
    expect(claimSql).not.toContain("watri.actor_type = 'user'")
    expect(claimSql).not.toContain('watri.actor_id = wama.user_id')
    expect(claimSql).toContain("nd.payload->>'providerMedium' = wama.medium")
    expect(claimSql).toContain("CASE WHEN $1 = 'telegram'")
    expect(claimSql).toContain("nd.payload->>'providerChannelId' = ANY($2::text[])")
    expect(claimSql).toContain("nd.payload->>'providerChannelId' = wama.provider_channel_id")
    expect(claimSql).toContain("nd.payload->>'providerWorkspaceId'")
  })

  it('claims approval update notifications to reconcile provider-side pending caches', async () => {
    const txQuery = vi.fn().mockResolvedValue({
      rows: [
        {
          id: 'delivery-3',
          eventType: 'approval.updated',
          payload: {
            approvalRequestId: 'approval-1',
            recipeNamespace: 'sandbox-recipes',
            recipeName: 'due-diligence',
            status: 'cancelled',
          },
          attempts: 1,
          medium: 'telegram',
          providerUserId: '123456',
          providerWorkspaceId: null,
          providerChannelId: 'telegram-chat-1',
        },
      ],
      rowCount: 1,
    } as any)
    mockedWithTransaction.mockImplementation(async work => work({ query: txQuery } as any))

    const deliveries = await claimNotificationDeliveries({
      medium: 'telegram',
      providerChannelIds: ['telegram-chat-1'],
      hostRef: 'chatllm',
    })

    expect(deliveries[0]?.eventType).toBe('approval.updated')
    const claimSql = String(txQuery.mock.calls[0]![0])
    expect(claimSql).toContain("nd.event_type = 'approval.updated'")
    expect(claimSql).toContain(
      "nd.payload->>'status' IN ('approved', 'denied', 'cancelled', 'expired', 'consumed')"
    )
    expect(claimSql).toContain(
      "war.status IN ('approved', 'denied', 'cancelled', 'expired', 'consumed')"
    )
    expect(claimSql).toContain('JOIN workflow_approval_requests war')
    expect(claimSql).toContain('JOIN workflow_approval_medium_accounts wama')
    expect(claimSql).toContain('wati.trigger_caller_key = $3')
    expect(claimSql).toContain(
      "war.payload #>> '{metadata,workflowTrigger,providerBinding,providerChannelId}' = ANY($2::text[])"
    )
  })

  it('rejects Slack delivery claims without workspace identity', async () => {
    await expect(
      claimNotificationDeliveries({
        medium: 'slack',
        providerChannelIds: ['C123'],
        hostRef: 'chatllm',
      })
    ).rejects.toThrow('provider_workspace_id_required')
    expect(mockedWithTransaction).not.toHaveBeenCalled()
  })

  it('rejects unsupported notification media before opening a transaction', async () => {
    await expect(claimNotificationDeliveries({ medium: 'discord' })).rejects.toThrow(
      'unsupported_notification_medium'
    )
    expect(mockedWithTransaction).not.toHaveBeenCalled()
  })

  it('requires explicit provider channel ids before opening a transaction', async () => {
    await expect(
      claimNotificationDeliveries({
        medium: 'telegram',
        providerChannelIds: [' ', ''],
        hostRef: 'chatllm',
      })
    ).rejects.toThrow('provider_channel_id_required')
    expect(mockedWithTransaction).not.toHaveBeenCalled()
  })

  it('caps provider channel ids before opening a transaction', async () => {
    await expect(
      claimNotificationDeliveries({
        medium: 'telegram',
        providerChannelIds: Array.from({ length: 101 }, (_, index) => `telegram-chat-${index}`),
        hostRef: 'chatllm',
      })
    ).rejects.toThrow('provider_channel_id_limit_exceeded')
    expect(mockedWithTransaction).not.toHaveBeenCalled()
  })

  it('requires the caller hostRef before opening a transaction', async () => {
    await expect(
      claimNotificationDeliveries({
        medium: 'telegram',
        providerChannelIds: ['telegram-chat-1'],
        hostRef: ' ',
      })
    ).rejects.toThrow('host_ref_required')
    expect(mockedWithTransaction).not.toHaveBeenCalled()
  })

  // ─── Figure D multi-bot ───────────────────────────────────────────────────
  it('projects communication_channel_ref in the user-bound claim (CTEs + RETURNING)', async () => {
    const txQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
    mockedWithTransaction.mockImplementation(async work => work({ query: txQuery } as never))

    await claimUserBoundNotificationDeliveries({ medium: 'telegram', limit: 5 })

    const sql = String(txQuery.mock.calls[0]![0])
    expect(sql).toContain('wama.communication_channel_ref')
    expect(sql).toContain('c.communication_channel_ref AS "communicationChannelRef"')
  })

  it('markUserBoundNotificationDeliverySkippedNoBot writes the terminal skipped_no_bot status', async () => {
    mockedPoolQuery.mockResolvedValue({ rows: [{ id: 'd-1' }], rowCount: 1 } as never)

    await expect(markUserBoundNotificationDeliverySkippedNoBot('d-1')).resolves.toBe(true)

    const sql = String(mockedPoolQuery.mock.calls[0]![0])
    expect(sql).toContain("status = 'skipped_no_bot'")
    // Terminal: only transitions from non-terminal states, never re-queues/retries.
    expect(sql).toContain("status IN ('queued', 'retrying')")
    expect(mockedPoolQuery.mock.calls[0]![1]).toEqual(['d-1'])
  })
})
