// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AgentTaskTrackerContext,
  type TaskState,
  type TaskTracker,
} from '@contexts/AgentTaskTrackerContext'
import { act, cleanup, render, screen } from '@testing-library/react'
import { NudgeArea } from '../NudgeArea'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    writable: true,
    value: {
      window: {
        getVisibility: vi.fn(async () => ({ visible: true })),
        onVisibilityChange: vi.fn(() => () => undefined),
      },
    },
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  delete (window as { clerum?: unknown }).clerum
})

function task(ageMs: number, overrides: Partial<TaskState> = {}): TaskState {
  return {
    taskId: 't1',
    userMessageId: 'm1',
    status: 'streaming',
    startedAt: Date.now() - ageMs,
    lastEventAt: Date.now(),
    steps: [
      {
        toolCallId: 'tc1',
        toolName: 'shell',
        displayName: 'Run shell',
        intentSummary: '',
        iteration: 2,
        stepIndex: 0,
        totalSteps: 0,
        state: 'running',
      },
    ],
    currentIteration: 2,
    ...overrides,
  }
}

/** Fake tracker that yields a fixed state — avoids the real tracker's SSE timers. */
function trackerWith(state: TaskState | undefined): TaskTracker {
  return {
    get: () => state,
    subscribe: (_key: string, fn: (s: TaskState) => void) => {
      if (state) fn(state)
      return () => undefined
    },
    start: vi.fn(),
    rejoinIfRunning: vi.fn(),
    ack: vi.fn(),
    cancel: vi.fn(async () => undefined),
    setCallbacks: vi.fn(),
  } as unknown as TaskTracker
}

function renderNudge(state: TaskState | undefined) {
  return render(
    <AgentTaskTrackerContext.Provider value={trackerWith(state)}>
      <NudgeArea agentRef="agent-x" chatId="c1" onStartNewChat={vi.fn()} onRefreshState={vi.fn()} />
    </AgentTaskTrackerContext.Provider>
  )
}

describe('NudgeArea (D.5b)', () => {
  it('renders nothing for T1 (<30s)', () => {
    const { container } = renderNudge(task(5_000))
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing for T2 (30s–2min)', () => {
    const { container } = renderNudge(task(60_000))
    expect(container.firstChild).toBeNull()
  })

  it('renders the T3 nudge with a "Start a new chat" button that fires the handler', () => {
    const onStartNewChat = vi.fn()
    render(
      <AgentTaskTrackerContext.Provider value={trackerWith(task(150_000))}>
        <NudgeArea
          agentRef="agent-x"
          chatId="c1"
          onStartNewChat={onStartNewChat}
          onRefreshState={vi.fn()}
        />
      </AgentTaskTrackerContext.Provider>
    )
    expect(screen.getByText(/taking longer than usual/i)).toBeTruthy()
    const button = screen.getByRole('button', { name: /start a new chat/i })
    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onStartNewChat).toHaveBeenCalledTimes(1)
  })

  it('renders the T4 nudge with a mini-summary and the window-visible copy', () => {
    renderNudge(task(400_000))
    expect(screen.getByText(/safe to close this window/i)).toBeTruthy()
    expect(screen.getByText(/Last tool: Run shell/i)).toBeTruthy()
    expect(screen.getByText(/Iteration 2/i)).toBeTruthy()
  })

  it('renders the T5 nudge with a "Refresh state" button', () => {
    renderNudge(task(1_000_000))
    expect(screen.getByRole('button', { name: /refresh state/i })).toBeTruthy()
  })

  it('renders nothing once the task is terminal', () => {
    const { container } = renderNudge(task(1_000_000, { status: 'completed' }))
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing while suspended even if the computed tier is T3+', () => {
    // Genuinely worked 2.5–16min BEFORE suspending (T3/T4/T5), so §AC3's freeze
    // at `pausedAt` still lands on a nudge tier — but "your agent is still
    // working" is false at an approval gate. The approval card is the
    // affordance; the nudge stays out.
    for (const ageMs of [150_000, 400_000, 1_000_000]) {
      const { container, unmount } = renderNudge(
        task(ageMs, { status: 'suspended', pausedAt: Date.now() })
      )
      expect(container.firstChild).toBeNull()
      unmount()
    }
  })

  it('stops showing a nudge after switching to a chat with no task', () => {
    // Key-aware fake: agent-x::c1 has a long-running (T3) task; c2 has none.
    const byKey = new Map<string, TaskState>([['agent-x::c1', task(150_000)]])
    const tracker = {
      get: (key: string) => byKey.get(key),
      subscribe: (key: string, fn: (s: TaskState) => void) => {
        const s = byKey.get(key)
        if (s) fn(s)
        return () => undefined
      },
      start: vi.fn(),
      rejoinIfRunning: vi.fn(),
      ack: vi.fn(),
      cancel: vi.fn(async () => undefined),
      setCallbacks: vi.fn(),
    } as unknown as TaskTracker
    const element = (chatId: string) => (
      <AgentTaskTrackerContext.Provider value={tracker}>
        <NudgeArea
          agentRef="agent-x"
          chatId={chatId}
          onStartNewChat={vi.fn()}
          onRefreshState={vi.fn()}
        />
      </AgentTaskTrackerContext.Provider>
    )
    const { container, rerender } = render(element('c1'))
    expect(screen.getByText(/taking longer than usual/i)).toBeTruthy()
    // Switch to c2 (no task) — the nudge must NOT leak in from c1.
    act(() => {
      rerender(element('c2'))
    })
    expect(container.firstChild).toBeNull()
  })
})
