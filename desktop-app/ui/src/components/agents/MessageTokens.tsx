import type { SessionTokensLite, TurnGuardrailsLite } from '../../hooks/useChatStore'
import { formatTokenBreakdown } from '../../lib/format'
import { TokenUsageStats, TokenUsageTooltip } from './TokenUsage'

export interface MessageTokensProps {
  tokens: SessionTokensLite
  /** Per-turn guardrail-input activity (spec §7), surfaced in this footer's popup. */
  guardrails?: TurnGuardrailsLite
}

/** Spoken summary of the guardrail net for the wrapper's aria-label (§7) — a percent
 *  of the guardrail's own before-total, matching the visible footer figure. */
function guardrailAriaSuffix(guardrails?: TurnGuardrailsLite): string {
  if (!guardrails || guardrails.changes.length === 0) return ''
  const { tokensBefore, tokensAfter } = guardrails
  if (tokensAfter === tokensBefore || tokensBefore <= 0) return '; guardrails changed your input'
  const pct = Math.abs(Math.round(((tokensAfter - tokensBefore) / tokensBefore) * 100))
  return `; guardrails ${tokensAfter < tokensBefore ? 'reduced' : 'added'} input by ${pct}%`
}

/**
 * Discreet per-turn token usage for the assistant message footer — dim micro
 * input (↑) / output (↓) stats next to the timestamp, plus a cache glyph when
 * the model reports cache figures and a shield glyph when a guardrail changed
 * the input. Renders nothing when the turn billed no input/output (e.g. a
 * cache-only turn), so it never shows a misleading "0 tokens"; the header
 * SessionTokensIndicator guards the same way. The exact breakdown — including
 * the guardrail net + per-source rows — lives in the custom hover/focus tooltip
 * (see TokenUsage).
 */
export function MessageTokens({ tokens, guardrails }: MessageTokensProps) {
  if (tokens.input + tokens.output <= 0) return null
  return (
    <span
      className="token-usage token-usage--micro"
      tabIndex={0}
      aria-label={`Turn token usage — ${formatTokenBreakdown(tokens)}${guardrailAriaSuffix(guardrails)}`}
    >
      <TokenUsageStats tokens={tokens} guardrails={guardrails} />
      <TokenUsageTooltip tokens={tokens} guardrails={guardrails} />
    </span>
  )
}
