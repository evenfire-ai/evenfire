// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useOnboardingController } from '../useOnboardingController'

describe('useOnboardingController', () => {
  it('starts on Q1 with no history', () => {
    const { result } = renderHook(() => useOnboardingController())

    expect(result.current.step).toBe('origin')
    expect(result.current.canGoBack).toBe(false)
  })

  it('ignores back at the root instead of unwinding past Q1', () => {
    const { result } = renderHook(() => useOnboardingController())

    act(() => result.current.back())

    expect(result.current.step).toBe('origin')
    expect(result.current.canGoBack).toBe(false)
  })

  it('records one history entry per transition, not two', () => {
    // Guards the StrictMode hazard that made step and history one state value:
    // a duplicated history entry would need two backs to leave a one-step path.
    const { result } = renderHook(() => useOnboardingController())

    act(() => result.current.answerOrigin('haveAddress'))
    expect(result.current.step).toBe('manual')

    act(() => result.current.back())
    expect(result.current.step).toBe('origin')
    expect(result.current.canGoBack).toBe(false)
  })

  it('skips Q2 while the hosted path is unavailable', () => {
    const { result } = renderHook(() => useOnboardingController())

    expect(result.current.hostedAvailable).toBe(false)

    act(() => result.current.answerOrigin('gettingStarted'))

    expect(result.current.step).toBe('selfHosted')
  })

  it('reset returns to Q1 and clears the history', () => {
    const { result } = renderHook(() => useOnboardingController())

    act(() => result.current.answerOrigin('gettingStarted'))
    act(() => result.current.goToManual())
    expect(result.current.canGoBack).toBe(true)

    act(() => result.current.reset())

    expect(result.current.step).toBe('origin')
    expect(result.current.canGoBack).toBe(false)
  })
})
