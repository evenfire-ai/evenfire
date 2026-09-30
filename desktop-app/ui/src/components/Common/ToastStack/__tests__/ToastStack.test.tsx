// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ToastStack } from '../index'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ToastStack', () => {
  it('renders nothing without items', () => {
    const { container } = render(<ToastStack items={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders each toast with its tone role and no action button by default', () => {
    render(
      <ToastStack
        items={[
          { id: 1, tone: 'info', text: 'Saved.' },
          { id: 2, tone: 'error', text: 'Boom.' },
        ]}
      />
    )
    expect(screen.getByRole('status').textContent).toContain('Saved.')
    expect(screen.getByRole('alert').textContent).toContain('Boom.')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('runs the toast action and dismisses through onDismiss when clicked', () => {
    const onAction = vi.fn()
    const onDismiss = vi.fn()
    render(
      <ToastStack
        items={[
          {
            id: 7,
            tone: 'info',
            text: 'Attachments kept',
            action: { label: 'Discard all', onAction },
          },
        ]}
        onDismiss={onDismiss}
      />
    )
    const action = screen.getByRole('button', { name: 'Discard all' })
    fireEvent.click(action)
    expect(onAction).toHaveBeenCalledTimes(1)
    expect(onDismiss).toHaveBeenCalledWith(7)
  })

  it('runs the action without an onDismiss handler', () => {
    const onAction = vi.fn()
    render(
      <ToastStack
        items={[
          {
            id: 8,
            tone: 'info',
            text: 'Attachments kept',
            action: { label: 'Discard all', onAction },
          },
        ]}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Discard all' }))
    expect(onAction).toHaveBeenCalledTimes(1)
  })
})
