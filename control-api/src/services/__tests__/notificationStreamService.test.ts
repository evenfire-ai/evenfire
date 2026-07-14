import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({
  pool: {
    query: vi.fn(),
    connect: vi.fn(),
  },
}))

vi.mock('../../config.js', () => ({
  config: {
    notificationsDesktopFirstEnabled: true,
  },
}))

const { pool } = await import('../../db.js')
const { listApprovalNotificationEventsForUser, listSdkNotificationEventsForUser } =
  await import('../notificationStreamService.js')

describe('notification stream service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('maps workflow.run.completed events from terminal workflow runs', async () => {
    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [
        {
          notificationId: '11111111-1111-1111-1111-111111111111',
          eventType: 'workflow.run.completed',
          notificationCreatedAt: new Date('2026-06-04T10:00:00.000Z'),
          approvalRequestId: '22222222-2222-2222-2222-222222222222',
          recipeNamespace: 'sandbox-recipes',
          recipeName: 'due-diligence-package',
          requestedAt: new Date('2026-06-04T09:55:00.000Z'),
          expiresAt: new Date('2026-06-04T11:00:00.000Z'),
          payload: { message: 'approval body' },
          correlation: null,
          targetUserId: '33333333-3333-3333-3333-333333333333',
          targetTeamId: null,
          targetTeamName: null,
          status: null,
          workflowRunId: 'run-1',
          phase: 'Succeeded',
          completedAt: new Date('2026-06-04T10:01:00.000Z'),
          notificationPayload: {
            message:
              'Workflow due-diligence-package completed. Results are ready. Reply: download result',
          },
        },
      ],
    } as never)

    const events = await listApprovalNotificationEventsForUser(
      '33333333-3333-3333-3333-333333333333'
    )

    expect(events).toEqual([
      {
        id: '11111111-1111-1111-1111-111111111111',
        eventType: 'workflow.run.completed',
        cursor: '2026-06-04T10:00:00.000Z::11111111-1111-1111-1111-111111111111',
        workflowRun: {
          workflowRunId: 'run-1',
          approvalRequestId: '22222222-2222-2222-2222-222222222222',
          recipeNamespace: 'sandbox-recipes',
          recipeName: 'due-diligence-package',
          phase: 'Succeeded',
          completedAt: '2026-06-04T10:01:00.000Z',
          message:
            'Workflow due-diligence-package completed. Results are ready. Reply: download result',
          target: {
            userId: '33333333-3333-3333-3333-333333333333',
            teamId: null,
            teamName: null,
          },
        },
      },
    ])
    const sql = String(vi.mocked(pool.query).mock.calls[0]?.[0] || '')
    expect(sql).toContain(
      "nd.event_type IN ('approval.requested', 'approval.updated', 'workflow.run.completed')"
    )
    expect(sql).toContain(
      "war.status IN ('approved', 'denied', 'cancelled', 'expired', 'consumed')"
    )
    expect(sql).toContain('LEFT JOIN workflow_runs wr')
    expect(sql).toContain("wr.phase IN ('Succeeded', 'Failed', 'Canceled')")
  })

  it('maps plugin workload SDK notifications for the target user', async () => {
    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [
        {
          notificationId: '44444444-4444-4444-4444-444444444444',
          notificationCreatedAt: new Date('2026-06-11T10:00:00.000Z'),
          notificationPayload: {
            notificationId: 'sdk-notif-1',
            origin: 'plugin_workload_sdk',
            recipeNamespace: 'sandbox-recipes',
            recipeName: 'demo-recipe',
            callerRef: 'workload-a',
            eventType: 'progress',
            title: 'Step finished',
            body: 'The workload completed a step.',
            data: { stepId: 'summarize' },
            actionRef: null,
            deliveryPolicyRef: null,
          },
        },
      ],
    } as never)

    const events = await listSdkNotificationEventsForUser('33333333-3333-3333-3333-333333333333')

    expect(events).toEqual([
      {
        id: '44444444-4444-4444-4444-444444444444',
        eventType: 'sdk.notification',
        cursor: '2026-06-11T10:00:00.000Z::44444444-4444-4444-4444-444444444444',
        notification: {
          notificationId: 'sdk-notif-1',
          origin: 'plugin_workload_sdk',
          recipeNamespace: 'sandbox-recipes',
          recipeName: 'demo-recipe',
          callerRef: 'workload-a',
          eventType: 'progress',
          title: 'Step finished',
          body: 'The workload completed a step.',
          data: { stepId: 'summarize' },
          actionRef: null,
          deliveryPolicyRef: null,
        },
      },
    ])
  })
})
