import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthClient } from '../authClient.js'

vi.mock('../config.js', () => ({
  config: {
    externalRestApiBaseUrl: 'http://rest',
    requestTimeoutMs: 60000,
  },
}))

function ndjsonStream(lines: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`))
      }
      controller.close()
    },
  })
}

describe('AuthClient.openWorkflowNotificationStream', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('parses snapshot and approval.requested events from the Desktop notification stream', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: ndjsonStream([
          {
            type: 'notification.snapshot',
            observedAt: '2026-05-20T10:00:00.000Z',
            cursor: null,
            items: [],
          },
          {
            type: 'approval.requested',
            id: 'event-1',
            cursor: '2026-05-20T10:00:01.000Z::11111111-1111-1111-1111-111111111111',
            observedAt: '2026-05-20T10:00:01.000Z',
            approval: {
              id: 'approval-1',
              recipeNamespace: 'sandbox-recipes',
              recipeName: 'target',
              requestedAt: '2026-05-20T10:00:00.000Z',
              expiresAt: '2026-05-20T11:00:00.000Z',
              payload: { message: 'Approve workflow trigger' },
              correlation: { taskId: 'task-1' },
              target: { userId: 'user-1', teamId: null, teamName: null },
            },
          },
          {
            type: 'approval.updated',
            id: 'event-2',
            cursor: '2026-05-20T10:00:02.000Z::22222222-2222-2222-2222-222222222222',
            observedAt: '2026-05-20T10:00:02.000Z',
            approvalRequestId: 'approval-1',
            status: 'approved',
          },
          {
            type: 'workflow.run.completed',
            id: 'event-3',
            cursor: '2026-05-20T10:00:03.000Z::33333333-3333-3333-3333-333333333333',
            observedAt: '2026-05-20T10:00:03.000Z',
            workflowRun: {
              workflowRunId: 'run-1',
              approvalRequestId: 'approval-1',
              recipeNamespace: 'sandbox-recipes',
              recipeName: 'target',
              phase: 'Succeeded',
              completedAt: '2026-05-20T10:00:03.000Z',
              message: 'Workflow target completed. Results are ready. Reply: download result',
              target: { userId: 'user-1', teamId: null, teamName: null },
            },
          },
        ]),
      })
    )

    const events: Array<{ type: string; workflowRun?: { recipeName: string; phase: string } }> = []
    await new AuthClient().openWorkflowNotificationStream(
      'session-token',
      event => events.push(event),
      new AbortController().signal
    )

    expect(events.map(event => event.type)).toEqual([
      'open',
      'notification.snapshot',
      'approval.requested',
      'approval.updated',
      'workflow.run.completed',
    ])
    expect(events[4]?.workflowRun).toMatchObject({ recipeName: 'target', phase: 'Succeeded' })
  })

  it('parses sdk.notification events from the Desktop notification stream', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: ndjsonStream([
          {
            type: 'sdk.notification',
            id: '55555555-5555-5555-5555-555555555555',
            cursor: '2026-06-11T10:00:00.000Z::55555555-5555-5555-5555-555555555555',
            observedAt: '2026-06-11T10:00:00.000Z',
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
        ]),
      })
    )

    const events: Array<{ type: string; notification?: { title: string } }> = []
    await new AuthClient().openWorkflowNotificationStream(
      'session-token',
      event => events.push(event),
      new AbortController().signal
    )

    expect(events.map(event => event.type)).toEqual(['open', 'sdk.notification'])
    expect(events[1]?.notification).toMatchObject({ title: 'Step finished' })
    expect(fetch).toHaveBeenCalledWith(
      'http://rest/api/v1/notifications/stream',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          authorization: 'Bearer session-token',
        }),
      })
    )
  })

  it('does not render malformed notification events', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: ndjsonStream([{ type: 'approval.requested', approval: { id: 'missing-fields' } }]),
      })
    )

    const events: Array<{ type: string; message?: string }> = []
    await new AuthClient().openWorkflowNotificationStream(
      'session-token',
      event => events.push(event),
      new AbortController().signal
    )

    expect(events).toEqual([
      { type: 'open' },
      { type: 'error', message: 'Invalid notification stream payload' },
    ])
  })
})
