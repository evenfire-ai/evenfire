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
    // (A streaming state with `pausedAt` still set violates the §AC3 invariant —
    // the tracker closes the segment on resume — so this is a defensive case.)
    const tier = renderHook(() =>
      useTaskTier(task({ status: 'streaming', startedAt: now - 150_000, pausedAt: now - 100_000 }))
    ).result.current
    expect(tier).toBe('T3') // age = 150s from startedAt, NOT frozen at pausedAt's 50s
  })

  it('subtracts pausedMs so a resumed task is tiered on ACTIVE time (§AC3)', () => {
    const now = Date.now()
    // The reported bug: 10min parked on an approval + ~20s of real work. Without
    // the accumulator the resume lands on T4 ("still working, safe to close").
    const tier = renderHook(() =>
      useTaskTier(task({ status: 'streaming', startedAt: now - 620_000, pausedMs: 600_000 }))
    ).result.current
    expect(tier).toBe('T1') // active age = 20s
  })

  it('combines the closed accumulator with the open-segment freeze', () => {
    const now = Date.now()
    // 10min of earlier waits already closed, 20s of work, now parked again for
    // another 10min: both waits must stay out of the age.
    const tier = renderHook(() =>
      useTaskTier(
        task({
          status: 'suspended',
          startedAt: now - 1_220_000,
          pausedMs: 600_000,
          pausedAt: now - 600_000,
        })
      )
    ).result.current
    expect(tier).toBe('T1') // active age = 1_220_000 - 600_000 (open) - 600_000 = 20s
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
