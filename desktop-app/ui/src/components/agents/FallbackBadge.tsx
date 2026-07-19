import type { HostRuntimeStatus } from '../../../../src/types'
import { Pill } from '../Common'

export interface FallbackBadgeProps {
  /** `StatusResponse.servedBy` projected onto the Host runtime status (R5.9). */
  servedBy?: HostRuntimeStatus['servedBy']
}

/**
 * "Running on fallback" indicator for the chat indicators row (spec §3-R5.9),
 * sat next to the ContextWindowIndicator / ModelSelector in AgentWorkspace.
 *
 * Renders ONLY when the Host is actively serving from a configured fallback
 * (`servedBy.fallback === true`). Absent `servedBy` (older mcp-host builds, or a
 * Host with no `spec.llmPolicy`) and the normal case (`fallback === false`,
 * primary serving) render nothing — no noise. The label names the pair actually
 * serving the request so the operator can see the (possibly costlier) fallback.
 */
export function FallbackBadge({ servedBy }: FallbackBadgeProps) {
  if (!servedBy || !servedBy.fallback) return null

  const pair = `${servedBy.provider}/${servedBy.name}`
  const label = `Running on fallback: ${pair}`
  const tooltip = `The primary model is unavailable — this agent is temporarily served by a configured fallback (${pair}). It returns to the primary automatically once it recovers.`

  return (
    <Pill
      tone="warning"
      size="sm"
      className="fallback-badge"
      role="status"
      aria-label={label}
      title={tooltip}
    >
      <span className="fallback-badge-glyph" aria-hidden="true" />
      <span className="fallback-badge-label">{label}</span>
    </Pill>
  )
}
