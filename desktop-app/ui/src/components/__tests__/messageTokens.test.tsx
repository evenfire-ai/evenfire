// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { SessionTokensLite } from '../../hooks/useChatStore'
import { MessageTokens } from '../agents/MessageTokens'

afterEach(cleanup)

describe('MessageTokens', () => {
  it('shows input and output as separate compact stats', () => {
    const { container } = render(<MessageTokens tokens={{ input: 11_900, output: 500 }} />)
    const stats = container.querySelectorAll('.token-usage-stat')
    expect(stats[0]?.textContent).toBe('11.9k')
    expect(stats[1]?.textContent).toBe('500')
  })

  it('omits the cache glyph and cache rows when the model does not report cache', () => {
    const { container } = render(<MessageTokens tokens={{ input: 100, output: 40 }} />)
    expect(container.querySelector('.token-usage-stat--cache')).toBeNull()
    expect(container.querySelector('.token-usage-tooltip')?.textContent).not.toContain('Cache')
  })

  it('shows the cache glyph and tooltip cache rows when cache is reported (even at 0)', () => {
    const { container } = render(
      <MessageTokens tokens={{ input: 200, output: 80, cacheRead: 13, cacheWrite: 0 }} />
    )
    expect(container.querySelector('.token-usage-stat--cache')).toBeTruthy()
    const tooltip = container.querySelector('.token-usage-tooltip')
    expect(tooltip?.textContent).toContain('Cache read')
    expect(tooltip?.textContent).toContain('Cache write')
  })

  it('renders nothing when input+output is zero — incl. a cache-only turn (no "0" stats)', () => {
    const cacheOnly: SessionTokensLite = { input: 0, output: 0, cacheRead: 50, cacheWrite: 0 }
    const { container } = render(<MessageTokens tokens={cacheOnly} />)
    expect(container.firstChild).toBeNull()
  })

  it('exposes an accessible label with the exact breakdown', () => {
    render(<MessageTokens tokens={{ input: 100, output: 40 }} />)
    expect(screen.getByLabelText('Turn token usage — Input 100 · Output 40')).toBeTruthy()
  })
})
