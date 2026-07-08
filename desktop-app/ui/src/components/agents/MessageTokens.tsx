import type { SessionTokensLite } from '../../hooks/useChatStore'
import { formatTokenBreakdown } from '../../lib/format'
import { TokenUsageStats, TokenUsageTooltip } from './TokenUsage'

export interface MessageTokensProps {
  tokens: SessionTokensLite
}

/**
 * Discreet per-turn token usage for the assistant message footer — dim micro
 * input (↑) / output (↓) stats next to the timestamp, plus a cache glyph when
 * the model reports cache figures. Renders nothing when the turn billed no
 * input/output (e.g. a cache-only turn), so it never shows a misleading
 * "0 tokens"; the header SessionTokensIndicator guards the same way. The
 * exact breakdown lives in the custom hover/focus tooltip (see TokenUsage).
 */
export function MessageTokens({ tokens }: MessageTokensProps) {
  if (tokens.input + tokens.output <= 0) return null
  return (
    <span
      className="token-usage token-usage--micro"
      tabIndex={0}
      aria-label={`Turn token usage — ${formatTokenBreakdown(tokens)}`}
    >
      <TokenUsageStats tokens={tokens} />
      <TokenUsageTooltip tokens={tokens} />
    </span>
  )
}
