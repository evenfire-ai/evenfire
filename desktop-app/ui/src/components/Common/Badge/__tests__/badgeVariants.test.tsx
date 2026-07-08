// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { Badge } from '../index'

afterEach(cleanup)

describe('Badge variants (D.5)', () => {
  it('applies the running variant modifier class and accessible label', () => {
    render(<Badge variant="running" label="Running" />)
    const el = screen.getByLabelText('Running')
    expect(el.className).toContain('badge--running')
    expect(el.className).toContain('badge')
  })

  it('applies the awaiting_approval variant', () => {
    render(<Badge variant="awaiting_approval" label="Awaiting approval" />)
    expect(screen.getByLabelText('Awaiting approval').className).toContain(
      'badge--awaiting_approval'
    )
  })

  it('applies the completed_unread variant', () => {
    render(<Badge variant="completed_unread" label="Completed, unread" />)
    expect(screen.getByLabelText('Completed, unread').className).toContain(
      'badge--completed_unread'
    )
  })

  it('renders a plain badge (no variant modifier) when none is given', () => {
    render(<Badge>Hello</Badge>)
    const el = screen.getByText('Hello')
    expect(el.className).toContain('badge')
    expect(el.className).not.toContain('badge--')
  })
})
