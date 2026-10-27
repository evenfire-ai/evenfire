// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useDesktopController } from '../useDesktopController'

describe('useDesktopController window-close events', () => {
  let unmount: (() => void) | undefined

  afterEach(() => {
    unmount?.()
    unmount = undefined
    vi.useRealTimers()
    delete (window as { clerum?: unknown }).clerum
  })

  it('clears the retired host state and stops authenticated status polling', async () => {
    vi.useFakeTimers()
    let emitWindowClosed: ((event: { hostRef: string }) => void) | undefined
    const getStatus = vi.fn(async () => ({ status: 'running' }))
    const onWindowClosed = vi.fn((listener: (event: { hostRef: string }) => void) => {
      emitWindowClosed = listener
      return () => {
        if (emitWindowClosed === listener) emitWindowClosed = undefined
      }
    })

    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        desktop: {
          getStatus,
          openWindow: vi.fn(async () => undefined),
          onWindowClosed,
        },
      },
    })

    const app = renderHook(() =>
      useDesktopController({ selectedAgent: 'chatllm', pushToast: vi.fn() })
    )
    unmount = app.unmount

    await act(async () => {
      await app.result.current.handleOpenDesktop()
      await Promise.resolve()
    })
    expect(app.result.current.desktopStatus).toBe('running')
    expect(onWindowClosed).toHaveBeenCalledTimes(2)
    const statusCallsAfterOpen = getStatus.mock.calls.length

    await act(async () => {
      emitWindowClosed?.({ hostRef: 'chatllm' })
    })

    expect(app.result.current.desktopStatus).toBe('inactive')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000)
    })

    expect(getStatus).toHaveBeenCalledTimes(statusCallsAfterOpen)
  })
})
