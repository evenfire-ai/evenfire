// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AgentTaskTrackerContext,
  TaskTracker,
  makeTaskKey,
} from '@contexts/AgentTaskTrackerContext'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { InFlightAssistantPlaceholder } from '../InFlightAssistantPlaceholder'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  // Minimal bridge so tracker.start() can open its SSE without throwing.
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    writable: true,
    value: {
      rpc: {
        subscribeTaskProgress: vi.fn(async () => async () => undefined),
        getTaskResult: vi.fn(async () => ({ response: 'ok' })),
        cancelTask: vi.fn(async () => undefined),
        approveToolCall: vi.fn(async () => undefined),
        denyToolCall: vi.fn(async () => undefined),
      },
    },
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  delete (window as { clerum?: unknown }).clerum
})

function renderWith(tracker: TaskTracker, localMessageIds: Set<string>, chatId = 'c1') {
  return render(
    <AgentTaskTrackerContext.Provider value={tracker}>
      <InFlightAssistantPlaceholder
        agentRef="agent-x"
        chatId={chatId}
        localMessageIds={localMessageIds}
        onCancelTask={vi.fn()}
        decideApproval={vi.fn(async () => undefined)}
      />
    </AgentTaskTrackerContext.Provider>
  )
}

describe('InFlightAssistantPlaceholder (D.5)', () => {
  it('renders a progress bubble carrying the task id for a tracked task', () => {
    const tracker = new TaskTracker()
    tracker.start(makeTaskKey('agent-x', 'c1'), 'task-1', 'rejoined-unknown')
    const { container } = renderWith(tracker, new Set())
    expect(container.querySelector('[data-task-id="task-1"]')).not.toBeNull()
  })

  it('renders nothing when a local message bubble already represents the task', () => {
    const tracker = new TaskTracker()
    tracker.start(makeTaskKey('agent-x', 'c1'), 'task-1', 'msg-local')
    const { container } = renderWith(tracker, new Set(['msg-local']))
    expect(container.querySelector('[data-task-id]')).toBeNull()
  })

  it('renders nothing when there is no tracked task for the chat', () => {
    const tracker = new TaskTracker()
    const { container } = renderWith(tracker, new Set())
    expect(container.firstChild).toBeNull()
  })

  it('stops showing a task after switching to a chat with no task', () => {
    const tracker = new TaskTracker()
    // c1 has a running task; c2 does not.
    tracker.start(makeTaskKey('agent-x', 'c1'), 'task-1', 'rejoined-unknown')
    const element = (chatId: string) => (
      <AgentTaskTrackerContext.Provider value={tracker}>
        <InFlightAssistantPlaceholder
          agentRef="agent-x"
          chatId={chatId}
          localMessageIds={new Set()}
          onCancelTask={vi.fn()}
          decideApproval={vi.fn(async () => undefined)}
        />
      </AgentTaskTrackerContext.Provider>
    )
    const { container, rerender } = render(element('c1'))
    expect(container.querySelector('[data-task-id="task-1"]')).not.toBeNull()
    // Switch to c2 (no task) — the stepper must NOT leak in from c1.
    rerender(element('c2'))
    expect(container.querySelector('[data-task-id]')).toBeNull()
  })

  it('R4-L1: a rejecting connectMcpServer is caught (no unhandled rejection), not floated as `void`', async () => {
    // T1: the suspended-connect state is DERIVED from the real TaskTracker by
    // feeding the exact `suspended` stream event the live tracker consumes —
    // NOT hand-built — so `progress.suspendedInfo` has the real shape and the
    // Connect button renders as it does in production.
    let handler: ((e: unknown) => void | Promise<void>) | null = null
    const connectMcpServer = vi.fn(() => Promise.reject(new Error('403 not a member')))
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      writable: true,
      value: {
        rpc: {
          subscribeTaskProgress: vi.fn(async (_h: string, _t: string, onEvent: typeof handler) => {
            handler = onEvent
            return async () => undefined
          }),
          getTaskResult: vi.fn(async () => ({ response: 'ok' })),
          cancelTask: vi.fn(async () => undefined),
          connectMcpServer,
        },
      },
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const tracker = new TaskTracker()
    const key = makeTaskKey('agent-x', 'c1')
    tracker.start(key, 'task-1', 'um-1')
    const emit = async (event: unknown) => {
      if (!handler) throw new Error('no progress handler registered')
      await handler(event)
    }

    const { getByTestId } = render(
      <AgentTaskTrackerContext.Provider value={tracker}>
        <InFlightAssistantPlaceholder
          agentRef="agent-x"
          chatId="c1"
          localMessageIds={new Set()}
          onCancelTask={vi.fn()}
          decideApproval={vi.fn(async () => undefined)}
        />
      </AgentTaskTrackerContext.Provider>
    )

    // Drive the task into a `connect_required` suspension through the real reducer.
    await act(async () => {
      await emit({
        type: 'suspended',
        data: {
          taskId: 'task-1',
          requestId: 'req-1',
          displayName: 'monday tool',
          reason: 'connect_required',
          mcpServerName: 'monday',
        },
      })
    })

    const btn = getByTestId('connect-mcp-btn')
    await act(async () => {
      fireEvent.click(btn)
      // Let the rejected connect promise settle so the call-site `.catch` runs.
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(connectMcpServer).toHaveBeenCalledWith('monday', 'agent-x')
    // The rejection is handled by the call-site `.catch` — it does NOT float as an
    // unhandled rejection. Its observable is the error log; delete the `.catch`
    // (revert to `void connectMcpServer(...)`) and this assertion goes red.
    expect(errSpy).toHaveBeenCalledWith(
      '[connect] connectMcpServer failed',
      expect.objectContaining({ mcpServerName: 'monday' })
    )
    // The button is still mounted (the failure did not tear the stepper down) so
    // the ProgressStepper's re-enable timer can return it to an actionable state.
    expect(getByTestId('connect-mcp-btn')).not.toBeNull()
    errSpy.mockRestore()
  })
})
