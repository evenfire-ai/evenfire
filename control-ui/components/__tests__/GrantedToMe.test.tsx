import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { GrantedToMe } from '../PublisherView/GrantedToMe'

afterEach(cleanup)

describe('GrantedToMe (presentational)', () => {
  it('renders inbound grants read-only (no revoke)', () => {
    render(
      <GrantedToMe
        status="available"
        grants={[{ pluginName: '@beta/tool', ownerOrg: 'beta', createdAt: '2026-06-01T00:00:00Z' }]}
        reload={vi.fn()}
      />
    )
    expect(screen.getByText('@beta/tool')).toBeInTheDocument()
    expect(screen.getByText('beta')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /revoke/i })).toBeNull()
  })

  it('empty state', () => {
    render(<GrantedToMe status="available" grants={[]} reload={vi.fn()} />)
    expect(screen.getByText(/no plugins.*shared with/i)).toBeInTheDocument()
  })

  it('error → Retry calls reload', () => {
    const reload = vi.fn()
    render(<GrantedToMe status="error" grants={[]} reload={reload} />)
    fireEvent.click(screen.getByRole('button', { name: /retry/i }))
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('unavailable (403) → Marketplace signpost, no error/retry', () => {
    // The deep-link case: the tab is hidden, but a direct nav still renders. It
    // must reassure (shared plugins install from the Marketplace), not error.
    render(<GrantedToMe status="unavailable" grants={[]} reload={vi.fn()} />)
    const link = screen.getByRole('link', { name: /marketplace catalog/i })
    expect(link).toHaveAttribute('href', '/marketplace')
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull()
    expect(screen.queryByText(/could not load/i)).toBeNull()
  })
})
