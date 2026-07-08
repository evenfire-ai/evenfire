import { beforeEach, describe, expect, it, vi } from 'vitest'
import { pool } from '../src/db.js'
import {
  cursorPredicateSql,
  listActiveApprovalNotificationsForUser,
  listApprovalNotificationEventsForUser,
  listSdkNotificationEventsForUser,
  parseNotificationCursor,
} from '../src/services/notificationStreamService.js'

vi.mock('../src/db.js', () => ({
  pool: {
    query: vi.fn(),
    connect: vi.fn(),
  },
}))

const mockedQuery = vi.mocked(pool.query) as ReturnType<typeof vi.fn>

describe('notificationStreamService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedQuery.mockReset()
  })

  it('lists active approval notifications only when current approval visibility still applies', async () => {
    mockedQuery.mockResolvedValueOnce({
      rows: [
        {
          notificationId: '11111111-1111-1111-1111-111111111111',
          notificationCreatedAt: '2026-05-20T10:00:00.000Z',
          approvalRequestId: '22222222-2222-2222-2222-222222222222',
          recipeNamespace: 'sandbox-recipes',
          recipeName: 'target-recipe',
          requestedAt: '2026-05-20T10:00:00.000Z',
          expiresAt: '2026-05-20T11:00:00.000Z',
          payload: { message: 'Approve workflow trigger' },
          correlation: { taskId: 'task-1', stepId: 'step-1' },
          targetUserId: 'user-1',
          targetTeamId: null,
          targetTeamName: null,
        },
      ],
      rowCount: 1,
    } as any)

    const items = await listActiveApprovalNotificationsForUser('user-1')

    expect(items).toEqual([
      {
        id: '11111111-1111-1111-1111-111111111111',
        eventType: 'approval.requested',
        cursor: '2026-05-20T10:00:00.000Z::11111111-1111-1111-1111-111111111111',
        approval: {
          id: '22222222-2222-2222-2222-222222222222',
          recipeNamespace: 'sandbox-recipes',
          recipeName: 'target-recipe',
          requestedAt: '2026-05-20T10:00:00.000Z',
          expiresAt: '2026-05-20T11:00:00.000Z',
          payload: { message: 'Approve workflow trigger' },
          correlation: { taskId: 'task-1', stepId: 'step-1' },
          target: { userId: 'user-1', teamId: null, teamName: null },
        },
      },
    ])

    const sql = String(mockedQuery.mock.calls[0]?.[0])
    expect(sql).toContain('war.target_user_id = $1')
    expect(sql).toContain("tm.status = 'active'")
    expect(sql).toContain('FROM user_workflow_triggers uwt')
    expect(sql).toContain('FROM workflow_recipe_allowed_teams wat')
    expect(sql).not.toContain('team_workflow_triggers')
  })

  it('uses a created_at/id cursor for replay', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)

    await listActiveApprovalNotificationsForUser('user-1', {
      after: {
        createdAt: '2026-05-20T10:00:00.000Z',
        id: '11111111-1111-1111-1111-111111111111',
      },
    })

    const sql = String(mockedQuery.mock.calls[0]?.[0])
    const values = mockedQuery.mock.calls[0]?.[1]
    expect(sql).toContain('nd.created_at > $3::timestamptz')
    expect(sql).toContain('nd.id::text > $4')
    expect(values).toEqual([
      'user-1',
      50,
      '2026-05-20T10:00:00.000Z',
      '11111111-1111-1111-1111-111111111111',
    ])
  })

  it('emits approval.updated events without exposing raw notification audience', async () => {
    mockedQuery.mockResolvedValueOnce({
      rows: [
        {
          notificationId: '11111111-1111-1111-1111-111111111111',
          notificationCreatedAt: '2026-05-20T10:00:00.000Z',
          eventType: 'approval.updated',
          approvalRequestId: '22222222-2222-2222-2222-222222222222',
          status: 'approved',
        },
      ],
      rowCount: 1,
    } as any)

    const events = await listApprovalNotificationEventsForUser('user-1')

    expect(events).toEqual([
      {
        id: '11111111-1111-1111-1111-111111111111',
        eventType: 'approval.updated',
        cursor: '2026-05-20T10:00:00.000Z::11111111-1111-1111-1111-111111111111',
        approvalRequestId: '22222222-2222-2222-2222-222222222222',
        status: 'approved',
      },
    ])
    const sql = String(mockedQuery.mock.calls[0]?.[0])
    expect(sql).toContain(
      "nd.event_type IN ('approval.requested', 'approval.updated', 'workflow.run.completed')"
    )
    expect(sql).toContain('FROM user_workflow_triggers uwt')
    expect(sql).toContain('FROM workflow_recipe_allowed_teams wat')
    expect(sql).not.toContain('team_workflow_triggers')
  })

  it('delivers SDK notifications addressed by userId OR a matching targetRef medium account', async () => {
    mockedQuery.mockResolvedValueOnce({
      rows: [
        {
          notificationId: '33333333-3333-3333-3333-333333333333',
          notificationCreatedAt: '2026-05-20T10:00:00.000Z',
          notificationPayload: {
            title: 'Build done',
            body: 'Your workflow finished',
            recipeNamespace: 'sandbox-recipes',
            recipeName: 'sdk-recipe',
            callerRef: 'api',
            eventType: 'build.completed',
          },
        },
      ],
      rowCount: 1,
    } as any)

    const events = await listSdkNotificationEventsForUser('user-1')

    expect(events).toHaveLength(1)
    expect(events[0]?.id).toBe('33333333-3333-3333-3333-333333333333')

    const sql = String(mockedQuery.mock.calls[0]?.[0])
    // F5: both audience shapes are deliverable — userId AND targetRef resolved
    // against the user's active verified medium accounts.
    expect(sql).toContain("nd.audience->>'userId' = $1")
    expect(sql).toContain("nd.audience->>'targetRef' IS NOT NULL")
    expect(sql).toContain('FROM workflow_approval_medium_accounts wama')
    expect(sql).toContain("wama.provider_user_id = nd.audience->>'targetRef'")
    expect(sql).toContain('wama.disabled_at IS NULL')
  })

  it('returns empty cursor predicate when after is absent', () => {
    expect(cursorPredicateSql(null, 3)).toEqual({ sql: '', params: [] })
    expect(cursorPredicateSql(undefined, 3)).toEqual({ sql: '', params: [] })
  })

  it('builds cursor predicate with the requested parameter indexes', () => {
    const result = cursorPredicateSql(
      {
        createdAt: '2026-05-20T10:00:00.000Z',
        id: '11111111-1111-1111-1111-111111111111',
      },
      5
    )

    expect(result.params).toEqual([
      '2026-05-20T10:00:00.000Z',
      '11111111-1111-1111-1111-111111111111',
    ])
    expect(result.sql).toContain('nd.created_at > $5::timestamptz')
    expect(result.sql).toContain('nd.id::text > $6')
  })

  it('rejects malformed replay cursors', () => {
    expect(parseNotificationCursor('bad')).toBeNull()
    expect(parseNotificationCursor('2026-05-20T10:00:00.000Z::not-a-uuid')).toBeNull()
    expect(
      parseNotificationCursor('2026-05-20T10:00:00.000Z::11111111-1111-1111-1111-111111111111')
    ).toEqual({
      createdAt: '2026-05-20T10:00:00.000Z',
      id: '11111111-1111-1111-1111-111111111111',
    })
  })
})
