// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ToastStack } from '../index'

// Resolve the stylesheet relative to THIS test file so the assertion passes
// regardless of the directory vitest is launched from.
const toastStyles = readFileSync(resolve(__dirname, '../../../../styles.css'), 'utf8')

function cssRule(selector: string) {
  const match = toastStyles.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`))
  return match?.[1] ?? ''
}

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

  it('renders a warn toast with the warn tone class, warning glyph and amber border (L1)', () => {
    render(<ToastStack items={[{ id: 3, tone: 'warn', text: 'Skipped 1 entry' }]} />)
    const toast = screen.getByRole('status')
    expect(toast.className).toBe('toast tone-warn')
    expect(toast.querySelector('.toast-icon')?.textContent).toBe('▲')
    expect(cssRule('.toast.tone-warn')).toContain('rgba(var(--warning-rgb)')
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
