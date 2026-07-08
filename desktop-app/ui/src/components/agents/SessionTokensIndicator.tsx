import type { SessionTokensLite } from '../../hooks/useChatStore'
import { formatTokenBreakdown } from '../../lib/format'
import { Pill } from '../Common'
import { TokenUsageStats, TokenUsageTooltip } from './TokenUsage'

export interface SessionTokensIndicatorProps {
  tokens: SessionTokensLite
}

/**
 * Discreet header pill showing the active conversation's lifetime token usage
 * as separate input (↑) / output (↓) compact stats, plus a cache glyph when
 * the model reports cache figures. The exact breakdown lives in the custom
 * hover/focus tooltip (see TokenUsage). Updates on re-poll, like `turnCount`.
 */
export function SessionTokensIndicator({ tokens }: SessionTokensIndicatorProps) {
  if (tokens.input + tokens.output <= 0) return null

  return (
    <div className="agent-chat-tokens-row">
      <Pill
        tone="neutral"
        size="sm"
        className="token-usage token-usage--pill"
        tabIndex={0}
        aria-label={`Conversation token usage — ${formatTokenBreakdown(tokens)}`}
      >
        <TokenUsageStats tokens={tokens} />
        <TokenUsageTooltip tokens={tokens} />
      </Pill>
    </div>
  )
}
