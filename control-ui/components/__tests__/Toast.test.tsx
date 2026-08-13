import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { ToastProvider, useToast } from '../Toast'

function ToastTrigger({ message }: { message: string }) {
  const { showToast } = useToast()
  return (
    <button type="button" onClick={() => showToast(message)}>
      fire
    </button>
  )
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('ToastProvider timer lifecycle', () => {
  // Regression guard: a toast schedules a 3500ms auto-dismiss setTimeout. If the
  // provider unmounts (test teardown, route change) before it fires, the timer
  // must be cleared — otherwise it runs setItems after the environment is gone
  // ("window is not defined" under vitest/jsdom teardown). React 18 silences a
  // post-unmount setState (no throw), so the observable contract is precisely
  // "the pending handle gets clearTimeout'd on unmount" — which is asserted here.
  it('clears the exact pending auto-dismiss handle on unmount', () => {
    vi.useFakeTimers()
    const setSpy = vi.spyOn(globalThis, 'setTimeout')
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout')

    const { getByText, unmount } = render(
      <ToastProvider>
        <ToastTrigger message="hello" />
      </ToastProvider>
    )

    act(() => {
      getByText('fire').click()
    })
    // Capture the auto-dismiss handle that showToast just scheduled.
    expect(setSpy).toHaveBeenCalledTimes(1)
    const pendingHandle = setSpy.mock.results[0].value
    expect(clearSpy).not.toHaveBeenCalledWith(pendingHandle)

    unmount()

    // The provider must have cleared that specific still-pending handle.
    expect(clearSpy).toHaveBeenCalledWith(pendingHandle)
  })
})
