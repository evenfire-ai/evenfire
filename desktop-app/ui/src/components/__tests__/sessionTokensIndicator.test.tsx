// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { SessionTokensLite } from '../../hooks/useChatStore'
import { SessionTokensIndicator } from '../agents/SessionTokensIndicator'

afterEach(cleanup)

describe('SessionTokensIndicator', () => {
  it('shows input and output as separate compact stats', () => {
    const tokens: SessionTokensLite = { input: 11_900, output: 500 }
    render(<SessionTokensIndicator tokens={tokens} />)
    const stats = screen.getByLabelText(/Conversation token usage/)
    expect(stats.textContent).toContain('11.9k')
    expect(stats.textContent).toContain('500')
  })

  it('omits the cache glyph and cache rows when the model does not report cache', () => {
    const tokens: SessionTokensLite = { input: 100, output: 40 }
    render(<SessionTokensIndicator tokens={tokens} />)
    expect(screen.getByLabelText(/Conversation token usage/).getAttribute('aria-label')).toMatch(
      /Input .* · Output /
    )
    expect(
      screen.getByLabelText(/Conversation token usage/).getAttribute('aria-label')
    ).not.toContain('Cache')
  })

  it('shows the cache glyph and tooltip cache rows when the model reports cache (even at 0)', () => {
    const tokens: SessionTokensLite = { input: 200, output: 80, cacheRead: 13, cacheWrite: 0 }
    render(<SessionTokensIndicator tokens={tokens} />)
    expect(screen.getByLabelText(/Conversation token usage/).getAttribute('aria-label')).toMatch(
      /Cache read 13.*Cache write 0/
    )
  })

  it('renders nothing when the total is zero', () => {
    const { container } = render(<SessionTokensIndicator tokens={{ input: 0, output: 0 }} />)
    expect(container.firstChild).toBeNull()
  })

  it('exposes an accessible label with the exact breakdown', () => {
    render(<SessionTokensIndicator tokens={{ input: 1500, output: 200 }} />)
    // Compute the expected separator via toLocaleString so the assertion is
    // locale-independent (CI may not default to en-US).
    const expected = `Conversation token usage — Input ${(1500).toLocaleString()} · Output 200`
    expect(screen.getByLabelText(expected)).toBeTruthy()
  })
})
