// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ContextBreakdownLite } from '../../hooks/useChatStore'
import { ContextWindowIndicator } from '../agents/ContextWindowIndicator'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const breakdown: ContextBreakdownLite = {
  // messages 53.7%, systemTools 30.6%, metaContext 11.5%, systemPrompt 4.2%
  buckets: { messages: 537, systemTools: 306, metaContext: 115, systemPrompt: 42 },
  totalInputTokens: 32_900,
  maxTokens: 100_000,
  fillRatio: 0.329,
  capturedAtTurn: 4,
}

function installClerum(result: { breakdown: ContextBreakdownLite | null }) {
  const getContextBreakdown = vi.fn(async () => result)
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    writable: true,
    value: { rpc: { getContextBreakdown } },
  })
  return getContextBreakdown
}

afterEach(() => {
  cleanup()
  delete (window as { clerum?: unknown }).clerum
})

describe('ContextWindowIndicator', () => {
  it('probes on mount and shows the fill chip once a snapshot resolves (no bare "—")', async () => {
    const getContextBreakdown = installClerum({ breakdown })
    render(<ContextWindowIndicator agentRef="trader" chatId="c1" />)

    // The mount-time probe runs without a click.
    await waitFor(() => expect(getContextBreakdown).toHaveBeenCalledWith('trader', 'trader', 'c1'))

    const chip = await screen.findByRole('button', { name: /Context window — / })
    expect(chip.textContent).toContain('32.9k/100k (33%)')
    expect(chip.textContent).not.toContain('—')
  })

  it('renders four bucket rows sorted by share, with a stacked bar and the fill label', async () => {
    installClerum({ breakdown })
    const { container } = render(<ContextWindowIndicator agentRef="trader" chatId="c1" />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Context window/ }))
    })

    await waitFor(() => expect(container.querySelector('.context-window-popover')).toBeTruthy())

    const rows = container.querySelectorAll('.context-window-row')
    expect(rows.length).toBe(4)
    // Sorted desc by share: Messages first, System prompt last.
    expect(rows[0]?.querySelector('.context-window-row-label')?.textContent).toBe('Messages')
    expect(rows[0]?.querySelector('.context-window-row-pct')?.textContent).toBe('53.7%')
    expect(rows[3]?.querySelector('.context-window-row-label')?.textContent).toBe('System prompt')
    expect(rows[3]?.querySelector('.context-window-row-pct')?.textContent).toBe('4.2%')

    // Stacked bar has one segment per bucket.
    expect(container.querySelectorAll('.context-window-bar-seg').length).toBe(4)

    // Fill label appears in head + chip.
    expect(container.querySelector('.context-window-popover-fill')?.textContent).toBe(
      '32.9k/100k (33%)'
    )
  })

  it('shows the average cache hit rate row only when cacheHitRate is present', async () => {
    installClerum({ breakdown: { ...breakdown, cacheHitRate: 0.82 } })
    const { container } = render(<ContextWindowIndicator agentRef="trader" chatId="c1" />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Context window/ }))
    })

    await waitFor(() => expect(container.querySelector('.context-window-cache')).toBeTruthy())
    expect(container.querySelector('.context-window-cache')?.textContent).toContain(
      'Average cache hit rate 82.0%'
    )
  })

  it('omits the cache row when cacheHitRate is absent', async () => {
    installClerum({ breakdown })
    const { container } = render(<ContextWindowIndicator agentRef="trader" chatId="c1" />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Context window/ }))
    })

    await waitFor(() => expect(container.querySelector('.context-window-popover')).toBeTruthy())
    expect(container.querySelector('.context-window-cache')).toBeNull()
  })

  it('shows a "Loading…" state in the popover while the breakdown fetch is in flight', async () => {
    // Never-resolving fetch keeps `isLoading` true with no breakdown yet.
    const getContextBreakdown = vi.fn(
      () => new Promise<{ breakdown: ContextBreakdownLite | null }>(() => {})
    )
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      writable: true,
      value: { rpc: { getContextBreakdown } },
    })
    const { container } = render(<ContextWindowIndicator agentRef="trader" chatId="c1" />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Context window/ }))
    })

    await waitFor(() => expect(container.querySelector('.context-window-empty')).toBeTruthy())
    expect(container.querySelector('.context-window-empty')?.textContent).toBe('Loading…')
    expect(container.querySelector('.context-window-row')).toBeNull()
  })

  it('hides the chip entirely when the probe resolves to no snapshot (cold session)', async () => {
    const getContextBreakdown = installClerum({ breakdown: null })
    const { container } = render(<ContextWindowIndicator agentRef="trader" chatId="c1" />)

    // Probe runs on mount and resolves to null → nothing rendered, no bare "—".
    await waitFor(() => expect(getContextBreakdown).toHaveBeenCalledWith('trader', 'trader', 'c1'))
    await waitFor(() => expect(container.querySelector('.context-window-chip')).toBeNull())
    expect(screen.queryByRole('button', { name: /Context window/ })).toBeNull()
  })
})
