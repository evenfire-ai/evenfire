import { Tag, Tooltip } from 'antd'
import type { HostRuntimeStatus } from '../../../../src/types'

export interface FallbackBadgeProps {
  /** `StatusResponse.servedBy` projected onto the Host runtime status (R5.9). */
  servedBy?: HostRuntimeStatus['servedBy']
}

/** Shows which configured fallback currently serves this agent. */
export function FallbackBadge({ servedBy }: FallbackBadgeProps) {
  if (!servedBy || !servedBy.fallback) return null

  const pair = `${servedBy.provider}/${servedBy.name}`
  const label = `Running on fallback: ${pair}`
  const tooltip = `The primary model is unavailable — this agent is temporarily served by a configured fallback (${pair}). It returns to the primary automatically once it recovers.`

  return (
    <Tooltip title={tooltip}>
      <Tag color="warning" role="status" aria-label={label} title={tooltip}>
        {label}
      </Tag>
    </Tooltip>
  )
}
