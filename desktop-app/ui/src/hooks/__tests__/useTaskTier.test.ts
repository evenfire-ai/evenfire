// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TaskState } from '@contexts/AgentTaskTrackerContext'
import { act, renderHook } from '@testing-library/react'
import { classifyTier, useTaskTier } from '../useTaskTier'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => {
  vi.useRealTimers()
})

function task(overrides: Partial<TaskState> = {}): TaskState {
  return {
    taskId: 't1',
    userMessageId: 'm1',
    status: 'streaming',
    startedAt: Date.now(),
    lastEventAt: Date.now(),
    steps: [],
    currentIteration: 0,
    ...overrides,
  }
}

describe('classifyTier', () => {
  it('maps age ranges to tiers', () => {
    expect(classifyTier(0)).toBe('T1')
    expect(classifyTier(29_000)).toBe('T1')
    expect(classifyTier(30_000)).toBe('T2')
    expect(classifyTier(119_000)).toBe('T2')
    expect(classifyTier(120_000)).toBe('T3')
    expect(classifyTier(299_000)).toBe('T3')
    expect(classifyTier(300_000)).toBe('T4')
    expect(classifyTier(899_000)).toBe('T4')
    expect(classifyTier(900_000)).toBe('T5')
  })
})

describe('useTaskTier', () => {
  it('returns the tier for the current age', () => {
    const now = Date.now()
    expect(renderHook(() => useTaskTier(task({ startedAt: now - 10_000 }))).result.current).toBe(
      'T1'
    )
    expect(renderHook(() => useTaskTier(task({ startedAt: now - 60_000 }))).result.current).toBe(
      'T2'
    )
    expect(renderHook(() => useTaskTier(task({ startedAt: now - 150_000 }))).result.current).toBe(
      'T3'
    )
    expect(renderHook(() => useTaskTier(task({ startedAt: now - 400_000 }))).result.current).toBe(
      'T4'
    )
    expect(renderHook(() => useTaskTier(task({ startedAt: now - 1_000_000 }))).result.current).toBe(
      'T5'
    )
  })

  it('returns T1 when there is no task', () => {
    expect(renderHook(() => useTaskTier(undefined)).result.current).toBe('T1')
  })

  it('freezes at pausedAt while suspended (an approval wait must not escalate)', () => {
    const now = Date.now()
    const tier = renderHook(() =>
      useTaskTier(
        task({
          status: 'suspended',
          startedAt: now - 1_000_000,
          pausedAt: now - 1_000_000 + 10_000,
        })
      )
    ).result.current
    expect(tier).toBe('T1') // age frozen at 10s despite 1000s of wall-clock
  })

  it('unfreezes once no longer suspended (stale pausedAt is ignored)', () => {
    const now = Date.now()
    // Ran 150s ago, suspended at the 50s mark, but has since resumed (streaming).
    const tier = renderHook(() =>
      useTaskTier(task({ status: 'streaming', startedAt: now - 150_000, pausedAt: now - 100_000 }))
    ).result.current
    expect(tier).toBe('T3') // age = 150s from startedAt, NOT frozen at pausedAt's 50s
  })

  it('recomputes every 5s without a manual rerender', () => {
    vi.useFakeTimers()
    const base = Date.now()
    const { result } = renderHook(() => useTaskTier(task({ startedAt: base - 28_000 })))
    expect(result.current).toBe('T1')
    act(() => {
      vi.advanceTimersByTime(5_000) // age now ~33s
    })
    expect(result.current).toBe('T2')
  })
})
