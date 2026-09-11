import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ToastProvider, useToast } from '../Toast'

function Trigger() {
  const { showToast } = useToast()
  return <button onClick={() => showToast('Saved', { durationMs: 1_000 })}>Show toast</button>
}

describe('ToastProvider lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('clears delayed dismissals when the provider unmounts', () => {
    vi.useFakeTimers()
    const { unmount } = render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Show toast' }))
    expect(screen.getByRole('status')).toHaveTextContent('Saved')

    unmount()
    expect(() => vi.advanceTimersByTime(1_000)).not.toThrow()
    expect(vi.getTimerCount()).toBe(0)
  })
})
