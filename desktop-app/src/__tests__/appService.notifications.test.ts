import { describe, expect, it, vi } from 'vitest'
import { AppService } from '../appService.js'
import type { WorkflowNotificationStreamEvent } from '../types.js'

vi.mock('electron', () => ({
  app: {
    isReady: vi.fn(() => false),
    getPath: vi.fn(() => '/tmp/clerum-desktop-test'),
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
  shell: {
    openExternal: vi.fn(),
  },
}))

async function flushAsyncWork(iterations = 6): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await Promise.resolve()
  }
}

describe('AppService.startWorkflowNotificationStream', () => {
  it('forwards validated notification stream events to the renderer', async () => {
    const service = new AppService() as any
    service.sessionToken = 'session-token'
    service.authClient = {
      openWorkflowNotificationStream: vi.fn().mockImplementation(async (_token, onEvent) => {
        onEvent({ type: 'open' })
        onEvent({
          type: 'notification.snapshot',
          items: [],
          cursor: null,
          observedAt: '2026-05-20T10:00:00.000Z',
        })
      }),
    }

    const events: Array<{ type: string }> = []
    service.startWorkflowNotificationStream(
      'stream-1',
      7,
      (event: WorkflowNotificationStreamEvent) => {
        events.push({ type: event.type })
      }
    )

    await flushAsyncWork()

    expect(events.map(event => event.type)).toEqual(['open', 'notification.snapshot', 'error'])
    expect(service.authClient.openWorkflowNotificationStream).toHaveBeenCalledWith(
      'session-token',
      expect.any(Function),
      expect.any(AbortSignal)
    )
    service.stopWorkflowNotificationStream('stream-1', 7)
  })

  it('does not report an announced stream rollover as degraded', async () => {
    const service = new AppService() as any
    service.sessionToken = 'session-token'
    service.authClient = {
      openWorkflowNotificationStream: vi.fn().mockImplementation(async (_token, onEvent) => {
        onEvent({ type: 'open' })
        onEvent({
          type: 'stream.closing',
          reason: 'max_lifetime',
          observedAt: '2026-05-20T10:00:00.000Z',
        })
      }),
    }

    const events: Array<{ type: string }> = []
    service.startWorkflowNotificationStream(
      'stream-1',
      7,
      (event: WorkflowNotificationStreamEvent) => {
        events.push({ type: event.type })
      }
    )

    await flushAsyncWork()

    expect(events.map(event => event.type)).toEqual(['open', 'stream.closing'])
    expect(service.getWorkflowNotificationStreamStatus()).toEqual({
      active: 1,
      open: 0,
      connecting: 1,
      error: 0,
      approvalRequested: 0,
      snapshot: 0,
      updated: 0,
      completed: 0,
    })
    service.stopWorkflowNotificationStream('stream-1', 7)
  })

  it('prevents a renderer from stopping another renderer notification stream', () => {
    const service = new AppService() as any
    service.sessionToken = 'session-token'
    service.authClient = {
      openWorkflowNotificationStream: vi.fn(),
    }

    service.startWorkflowNotificationStream('stream-1', 7, vi.fn())

    expect(service.stopWorkflowNotificationStream('stream-1', 8)).toBe(false)
    expect(service.stopWorkflowNotificationStream('stream-1', 7)).toBe(true)
  })

  it('reports a stream as open only after the upstream connection opens', async () => {
    const service = new AppService() as any
    service.sessionToken = 'session-token'
    let emit: ((event: WorkflowNotificationStreamEvent) => void) | null = null
    let releaseStream!: () => void
    const streamClosed = new Promise<void>(resolve => {
      releaseStream = resolve
    })
    service.authClient = {
      openWorkflowNotificationStream: vi.fn().mockImplementation(async (_token, onEvent) => {
        emit = onEvent
        await streamClosed
      }),
    }

    service.startWorkflowNotificationStream('stream-1', 7, vi.fn())
    await flushAsyncWork()

    expect(service.getWorkflowNotificationStreamStatus()).toEqual({
      active: 1,
      open: 0,
      connecting: 1,
      error: 0,
      approvalRequested: 0,
      snapshot: 0,
      updated: 0,
      completed: 0,
    })

    const emitEvent = emit as ((event: WorkflowNotificationStreamEvent) => void) | null
    if (!emitEvent) throw new Error('notification stream test did not capture event callback')
    emitEvent({ type: 'open' })

    expect(service.getWorkflowNotificationStreamStatus()).toEqual({
      active: 1,
      open: 1,
      connecting: 0,
      error: 0,
      approvalRequested: 0,
      snapshot: 0,
      updated: 0,
      completed: 0,
    })

    releaseStream()
    service.stopWorkflowNotificationStream('stream-1', 7)
  })

  it('reports notification event counters for stream-delivered approval events', async () => {
    const service = new AppService() as any
    service.sessionToken = 'session-token'
    let emit: ((event: WorkflowNotificationStreamEvent) => void) | null = null
    let releaseStream!: () => void
    const streamClosed = new Promise<void>(resolve => {
      releaseStream = resolve
    })
    service.authClient = {
      openWorkflowNotificationStream: vi.fn().mockImplementation(async (_token, onEvent) => {
        emit = onEvent
        await streamClosed
      }),
    }

    service.startWorkflowNotificationStream('stream-1', 7, vi.fn())
    await flushAsyncWork()
    const emitEvent = emit as ((event: WorkflowNotificationStreamEvent) => void) | null
    if (!emitEvent) throw new Error('notification stream test did not capture event callback')
    emitEvent({ type: 'open' })
    emitEvent({
      type: 'notification.snapshot',
      items: [],
      cursor: null,
      observedAt: '2026-05-20T10:00:00.000Z',
    })
    emitEvent({
      type: 'approval.requested',
      id: '11111111-1111-1111-1111-111111111111',
      cursor: '2026-05-20T10:00:01.000Z::11111111-1111-1111-1111-111111111111',
      observedAt: '2026-05-20T10:00:01.000Z',
      approval: {
        id: '22222222-2222-2222-2222-222222222222',
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'target-recipe',
        requestedAt: '2026-05-20T10:00:01.000Z',
        expiresAt: '2026-05-20T11:00:01.000Z',
        payload: { message: 'Approve workflow trigger' },
        correlation: null,
        target: { userId: 'user-1', teamId: null, teamName: null },
      },
    })
    emitEvent({
      type: 'approval.updated',
      id: '33333333-3333-3333-3333-333333333333',
      cursor: '2026-05-20T10:00:02.000Z::33333333-3333-3333-3333-333333333333',
      approvalRequestId: '22222222-2222-2222-2222-222222222222',
      status: 'consumed',
      observedAt: '2026-05-20T10:00:02.000Z',
    })
    emitEvent({
      type: 'workflow.run.completed',
      id: '44444444-4444-4444-4444-444444444444',
      cursor: '2026-05-20T10:00:03.000Z::44444444-4444-4444-4444-444444444444',
      workflowRun: {
        workflowRunId: 'run-1',
        approvalRequestId: '22222222-2222-2222-2222-222222222222',
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'target-recipe',
        phase: 'Succeeded',
        completedAt: '2026-05-20T10:00:03.000Z',
        message: null,
        target: { userId: 'user-1', teamId: null, teamName: null },
      },
      observedAt: '2026-05-20T10:00:03.000Z',
    })

    expect(service.getWorkflowNotificationStreamStatus()).toEqual({
      active: 1,
      open: 1,
      connecting: 0,
      error: 0,
      approvalRequested: 1,
      snapshot: 1,
      updated: 1,
      completed: 1,
    })

    releaseStream()
    service.stopWorkflowNotificationStream('stream-1', 7)
  })
})
