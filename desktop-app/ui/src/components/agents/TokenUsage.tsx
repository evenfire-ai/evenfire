import { ArrowDownOutlined, ArrowUpOutlined, DatabaseOutlined } from '@ant-design/icons'
import { Typography } from 'antd'
import type { SessionTokensLite } from '../../hooks/useChatStore'
import { formatTokenBreakdown, formatTokenCount } from '../../lib/format'

export function hasCacheInfo(tokens: SessionTokensLite): boolean {
  return tokens.cacheRead !== undefined || tokens.cacheWrite !== undefined
}

export interface TokenUsagePartsProps {
  tokens: SessionTokensLite
}

export function tokenUsageBreakdown(tokens: SessionTokensLite): string {
  return formatTokenBreakdown(tokens)
}

/** Compact token counts; Ant Design supplies the icon and text presentation. */
export function TokenUsageStats({ tokens }: TokenUsagePartsProps) {
  return (
    <Typography.Text type="secondary" aria-hidden="true">
      <ArrowUpOutlined /> {formatTokenCount(tokens.input)} {' · '} <ArrowDownOutlined />{' '}
      {formatTokenCount(tokens.output)}
      {hasCacheInfo(tokens) ? (
        <>
          {' · '} <DatabaseOutlined />
        </>
      ) : null}
    </Typography.Text>
  )
}
