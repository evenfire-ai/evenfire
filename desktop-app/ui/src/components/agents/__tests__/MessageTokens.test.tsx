// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { SessionTokensLite, TurnGuardrailsLite } from '../../../hooks/useChatStore'
import {
  formatGuardrailPercent,
  formatSignedTokenDelta,
  formatTokenCount,
} from '../../../lib/format'
import { MessageTokens } from '../MessageTokens'

afterEach(cleanup)

const tokens: SessionTokensLite = { input: 12345, output: 6789 }

// Internally consistent: net (85100 − 96600 = −11500) == Σ per-source deltas.
const activity = (over: Partial<TurnGuardrailsLite> = {}): TurnGuardrailsLite => ({
  tokensBefore: 96600,
  tokensAfter: 85100,
  llmCalls: 3,
  changes: [
    { sourceId: 'token-trim', kind: 'builtin', deltaTokens: -11900, changed: true, calls: 3 },
    { sourceId: 'prompt-shaping', kind: 'builtin', deltaTokens: 400, changed: true, calls: 3 },
  ],
  ...over,
})

const ariaLabel = (container: HTMLElement) =>
  container.querySelector('.token-usage')?.getAttribute('aria-label') ?? ''

describe('MessageTokens guardrail fold-in (spec §7)', () => {
  it('shows no shield glyph or guardrail section when no source acted', () => {
    const { container } = render(
      <MessageTokens tokens={tokens} guardrails={activity({ changes: [] })} />
    )
    expect(container.querySelector('.token-usage-stat--guardrail')).toBeNull()
    expect(screen.queryByText('Guardrails')).toBeNull()
    expect(ariaLabel(container)).not.toContain('guardrails')
  })

  it('folds the net delta + per-source rows into the input/output tooltip', () => {
    const { container } = render(<MessageTokens tokens={tokens} guardrails={activity()} />)

    // Footer shield shows a PERCENT of the guardrail's own before-total (96600→85100
    // = −12%), NOT an absolute token count that could be read against billed input.
    const shieldStat = container.querySelector('.token-usage-stat--guardrail')
    expect(shieldStat).not.toBeNull()
    expect(shieldStat?.textContent).toContain(formatGuardrailPercent(96600, 85100))
    // Tooltip head: before → after (percent); per-source rows keep ABSOLUTE deltas.
    expect(screen.getByText('Guardrails')).not.toBeNull()
    expect(
      screen.getByText(
        `${formatTokenCount(96600)} → ${formatTokenCount(85100)} (${formatGuardrailPercent(96600, 85100)})`
      )
    ).not.toBeNull()
    expect(screen.getByText('token-trim (built-in)')).not.toBeNull()
    expect(screen.getByText(formatSignedTokenDelta(-11900))).not.toBeNull()
    expect(screen.getByText('prompt-shaping (built-in)')).not.toBeNull()
    expect(screen.getByText(formatSignedTokenDelta(400))).not.toBeNull()
    // Spoken summary spells the direction + percent for AT (stats/tooltip are aria-hidden).
    expect(ariaLabel(container)).toContain('guardrails reduced input by')
  })

  it('shows `changed` for a net-zero rewrite and renders a hook CR name verbatim (§8)', () => {
    render(
      <MessageTokens
        tokens={tokens}
        guardrails={activity({
          tokensBefore: 100,
          tokensAfter: 100,
          changes: [
            { sourceId: 'my-redactor', kind: 'hook', deltaTokens: 0, changed: true, calls: 1 },
          ],
        })}
      />
    )
    // Net is zero → footer stat, tooltip head, and the single source row all show `changed`.
    expect(screen.getAllByText('changed')).toHaveLength(3)
    expect(screen.getByText('my-redactor')).not.toBeNull()
  })
})
