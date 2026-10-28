import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ToastProvider, useToast } from '../Toast'

function Trigger() {
  const { showToast } = useToast()
  return <button onClick={() => showToast('Saved', { durationMs: 1_000 })}>Show toast</button>
}

function WarningTrigger() {
  const { showToast } = useToast()
  return (
    <button
      onClick={() => showToast('Check your connection.', { tone: 'warning', durationMs: 1_000 })}
    >
      Show warning
    </button>
  )
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

  it('renders the warning tone for honestly-unknown move outcomes', () => {
    vi.useFakeTimers()
    render(
      <ToastProvider>
        <WarningTrigger />
      </ToastProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Show warning' }))
    const toast = screen.getByRole('status')
    expect(toast).toHaveTextContent('Check your connection.')
    expect(toast).toHaveClass('cu-toast--warning')
  })
})
