import { Tag, Tooltip } from 'antd'
import type { SessionTokensLite } from '../../hooks/useChatStore'
import { formatTokenBreakdown } from '../../lib/format'
import { TokenUsageStats } from './TokenUsage'

export interface SessionTokensIndicatorProps {
  tokens: SessionTokensLite
}

/** Conversation token usage with the exact breakdown available on hover/focus. */
export function SessionTokensIndicator({ tokens }: SessionTokensIndicatorProps) {
  if (tokens.input + tokens.output <= 0) return null

  const breakdown = formatTokenBreakdown(tokens)
  return (
    <Tooltip title={breakdown}>
      <Tag
        color="default"
        tabIndex={0}
        aria-label={`Conversation token usage — ${breakdown}`}
        title={breakdown}
      >
        <TokenUsageStats tokens={tokens} />
      </Tag>
    </Tooltip>
  )
}
