import { Tooltip, Typography } from 'antd'
import type { SessionTokensLite } from '../../hooks/useChatStore'
import { formatTokenBreakdown } from '../../lib/format'
import { TokenUsageStats } from './TokenUsage'

export interface MessageTokensProps {
  tokens: SessionTokensLite
}

/** Per-turn token usage with its complete breakdown on hover/focus. */
export function MessageTokens({ tokens }: MessageTokensProps) {
  if (tokens.input + tokens.output <= 0) return null

  const breakdown = formatTokenBreakdown(tokens)
  return (
    <Tooltip title={breakdown}>
      <Typography.Text
        type="secondary"
        tabIndex={0}
        aria-label={`Turn token usage — ${breakdown}`}
        title={breakdown}
      >
        <TokenUsageStats tokens={tokens} />
      </Typography.Text>
    </Tooltip>
  )
}
