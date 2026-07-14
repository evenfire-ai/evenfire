// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AgentTaskTrackerContext,
  TaskTracker,
  makeTaskKey,
} from '@contexts/AgentTaskTrackerContext'
import { cleanup, render } from '@testing-library/react'
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
})
