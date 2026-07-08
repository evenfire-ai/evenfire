// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { AgentTaskTrackerProvider } from '../context'
import { makeTaskKey } from '../types'
import { useAgentTaskTracker } from '../useAgentTaskTracker'

function installRpc() {
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    writable: true,
    value: {
      rpc: {
        subscribeTaskProgress: vi.fn(async () => async () => undefined),
        getTaskResult: vi.fn(async () => ({ response: 'ok' })),
        cancelTask: vi.fn(async () => undefined),
      },
    },
  })
}

const wrapper = ({ children }: { children: ReactNode }) => (
  <AgentTaskTrackerProvider>{children}</AgentTaskTrackerProvider>
)

beforeEach(() => installRpc())
afterEach(() => {
  vi.restoreAllMocks()
  delete (window as { clerum?: unknown }).clerum
})

describe('AgentTaskTrackerProvider', () => {
  it('throws when useAgentTaskTracker is used without a provider', () => {
    expect(() => renderHook(() => useAgentTaskTracker())).toThrow(/within AgentTaskTrackerProvider/)
  })

  it('provides a single tracker instance to consumers', () => {
    const { result } = renderHook(() => useAgentTaskTracker(), { wrapper })
    const tracker = result.current
    expect(tracker).toBeDefined()
    expect(typeof tracker.start).toBe('function')
  })

  it('fans the same state out to multiple subscribers of a key', () => {
    const { result } = renderHook(() => useAgentTaskTracker(), { wrapper })
    const tracker = result.current
    const key = makeTaskKey('agent-x', 'chat-1')

    const a = vi.fn()
    const b = vi.fn()
    tracker.subscribe(key, a)
    tracker.subscribe(key, b)
    tracker.start(key, 'task-1', 'um-1')

    expect(a).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'task-1' }))
    expect(b).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'task-1' }))
  })

  it('setCallbacks does not reset existing task state', () => {
    const { result } = renderHook(() => useAgentTaskTracker(), { wrapper })
    const tracker = result.current
    const key = makeTaskKey('agent-x', 'chat-1')
    tracker.start(key, 'task-1', 'um-1')
    tracker.setCallbacks({ onTerminal: vi.fn() })
    expect(tracker.get(key)?.taskId).toBe('task-1')
  })
})
