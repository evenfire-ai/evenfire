// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { SessionTokensLite } from '../../hooks/useChatStore'
import { SessionTokensIndicator } from '../agents/SessionTokensIndicator'

afterEach(cleanup)

describe('SessionTokensIndicator', () => {
  it('shows input and output as separate compact stats', () => {
    const tokens: SessionTokensLite = { input: 11_900, output: 500 }
    const { container } = render(<SessionTokensIndicator tokens={tokens} />)
    const stats = container.querySelectorAll('.token-usage-stat')
    expect(stats[0]?.textContent).toBe('11.9k')
    expect(stats[1]?.textContent).toBe('500')
  })

  it('omits the cache glyph and cache rows when the model does not report cache', () => {
    const tokens: SessionTokensLite = { input: 100, output: 40 }
    const { container } = render(<SessionTokensIndicator tokens={tokens} />)
    expect(container.querySelector('.token-usage-stat--cache')).toBeNull()
    const tooltip = container.querySelector('.token-usage-tooltip')
    expect(tooltip?.textContent).toContain('Input')
    expect(tooltip?.textContent).toContain('Output')
    expect(tooltip?.textContent).not.toContain('Cache')
  })

  it('shows the cache glyph and tooltip cache rows when the model reports cache (even at 0)', () => {
    const tokens: SessionTokensLite = { input: 200, output: 80, cacheRead: 13, cacheWrite: 0 }
    const { container } = render(<SessionTokensIndicator tokens={tokens} />)
    expect(container.querySelector('.token-usage-stat--cache')).toBeTruthy()
    const tooltip = container.querySelector('.token-usage-tooltip')
    expect(tooltip?.textContent).toContain('Cache read')
    expect(tooltip?.textContent).toContain('13')
    expect(tooltip?.textContent).toContain('Cache write')
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
