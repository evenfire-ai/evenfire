// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useToastController } from '../useToastController'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('useToastController', () => {
  it('pushes a toast with an inline action', () => {
    const onAction = vi.fn()
    const { result } = renderHook(() => useToastController())

    act(() => {
      result.current.pushToast('Attachments kept', 'info', {
        action: { label: 'Discard all', onAction },
      })
    })

    expect(result.current.toasts).toHaveLength(1)
    expect(result.current.toasts[0]).toMatchObject({
      text: 'Attachments kept',
      tone: 'info',
      action: { label: 'Discard all', onAction },
    })
  })

  it('dismissToast removes the toast immediately', async () => {
    const onAction = vi.fn()
    const { result } = renderHook(() => useToastController())
    act(() => {
      result.current.pushToast('Attachments kept', 'info', {
        action: { label: 'Discard all', onAction },
      })
    })
    const id = result.current.toasts[0]!.id

    act(() => {
      result.current.dismissToast(id)
    })

    expect(result.current.toasts).toHaveLength(0)
    // Dismissing before the auto-dismiss timer must not resurrect the toast.
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(result.current.toasts).toHaveLength(0)
  })

  it('still auto-dismisses toasts without an action', async () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useToastController())
    act(() => {
      result.current.pushToast('Saved.', 'success')
    })
    expect(result.current.toasts).toHaveLength(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(result.current.toasts).toHaveLength(0)
  })
})
