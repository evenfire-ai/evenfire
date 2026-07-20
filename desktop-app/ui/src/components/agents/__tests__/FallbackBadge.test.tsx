// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { FallbackBadge } from '../FallbackBadge'

afterEach(cleanup)

describe('FallbackBadge (spec §3-R5.9)', () => {
  it('renders nothing when servedBy is absent (older host / no policy)', () => {
    const { container } = render(<FallbackBadge servedBy={undefined} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when servedBy is null', () => {
    const { container } = render(<FallbackBadge servedBy={null} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when the primary is serving (fallback === false)', () => {
    const { container } = render(
      <FallbackBadge servedBy={{ provider: 'claude', name: 'claude-opus-4-8', fallback: false }} />
    )
    expect(container.firstChild).toBeNull()
  })

  it('shows the fallback provider/model when fallback === true', () => {
    render(<FallbackBadge servedBy={{ provider: 'openai', name: 'gpt-5.4', fallback: true }} />)
    const badge = screen.getByRole('status')
    expect(badge.textContent).toContain('Running on fallback: openai/gpt-5.4')
    // Tooltip present for context on the (possibly costlier) fallback.
    const title = badge.getAttribute('title')
    expect(title).toBeTruthy()
    expect(title).toContain('openai/gpt-5.4')
  })
})
