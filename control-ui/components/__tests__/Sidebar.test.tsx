import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import * as hook from '../../lib/hooks/usePublishScope'
import { Sidebar } from '../Sidebar'

vi.mock('../../lib/hooks/usePublishScope', async orig => {
  const actual = await orig<typeof import('../../lib/hooks/usePublishScope')>()
  return { ...actual, usePublishScope: vi.fn() }
})

afterEach(cleanup)
beforeEach(() => vi.clearAllMocks())

describe('Sidebar publisher gating', () => {
  it('shows the Publisher entry for an org-bound non-curator deploy', async () => {
    vi.mocked(hook.usePublishScope).mockReturnValue({
      scope: { scope: 'acme', curator: false, orgName: 'Acme' },
      loading: false,
      error: false,
    })
    render(<Sidebar currentTab="hosts" />)
    const link = await screen.findByRole('link', { name: /publisher/i })
    expect(link).toHaveAttribute('href', '/publisher')
  })

  it('hides the Publisher entry on a curator deploy', () => {
    vi.mocked(hook.usePublishScope).mockReturnValue({
      scope: { scope: null, curator: true, orgName: null },
      loading: false,
      error: false,
    })
    render(<Sidebar currentTab="hosts" />)
    expect(screen.queryByRole('link', { name: /publisher/i })).toBeNull()
  })

  it('hides the Publisher entry while publish-scope is loading (fail closed)', () => {
    vi.mocked(hook.usePublishScope).mockReturnValue({ scope: null, loading: true, error: false })
    render(<Sidebar currentTab="hosts" />)
    expect(screen.queryByRole('link', { name: /publisher/i })).toBeNull()
  })

  it('still renders the other nav entries (e.g. Agents)', () => {
    vi.mocked(hook.usePublishScope).mockReturnValue({ scope: null, loading: false, error: true })
    render(<Sidebar currentTab="hosts" />)
    expect(screen.getByRole('link', { name: /agents/i })).toBeInTheDocument()
  })
})
