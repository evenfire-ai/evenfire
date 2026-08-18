import { useState } from 'react'
import type { TurnGuardrailsLite } from '../../hooks/useChatStore'
import { formatSignedTokenDelta, formatTokenCount } from '../../lib/format'
import { guardrailRowValue, guardrailSourceLabel } from '../../lib/guardrailLabels'

export interface MessageGuardrailsProps {
  guardrails: TurnGuardrailsLite
}

/**
 * Discreet per-turn guardrail-input-transparency note for the assistant footer
 * (spec §7.1). Collapsed: a shield glyph + the signed NET delta; expandable to
 * per-source rows. Counts + admin-authored ids only — never message content
 * (§8). Renders nothing when no source acted, so a quiet turn shows no shield
 * (matching `MessageTokens`' "never a misleading zero" rule).
 */
export function MessageGuardrails({ guardrails }: MessageGuardrailsProps) {
  const [expanded, setExpanded] = useState(false)
  if (guardrails.changes.length === 0) return null

  const net = guardrails.tokensAfter - guardrails.tokensBefore
  const netLabel = net === 0 ? 'changed' : formatSignedTokenDelta(net)
  const ariaLabel =
    net === 0
      ? 'Guardrails changed your input'
      : `Guardrails ${net < 0 ? 'reduced' : 'added'} input by ${formatTokenCount(Math.abs(net))} tokens`

  return (
    <span className="guardrail-note">
      <button
        type="button"
        className="guardrail-note__toggle"
        aria-expanded={expanded}
        aria-label={ariaLabel}
        onClick={() => setExpanded(value => !value)}
      >
        <span className="guardrail-note__glyph" aria-hidden="true">
          🛡
        </span>
        <span className="guardrail-note__net">{netLabel}</span>
        <span className="guardrail-note__caret" aria-hidden="true">
          {expanded ? '⌃' : '⌄'}
        </span>
      </button>
      {expanded && (
        <span className="guardrail-note__rows" role="list">
          {guardrails.changes.map(change => (
            <span className="guardrail-note__row" role="listitem" key={change.sourceId}>
              <span className="guardrail-note__source">{guardrailSourceLabel(change)}</span>
              <span className="guardrail-note__value">{guardrailRowValue(change)}</span>
            </span>
          ))}
        </span>
      )}
    </span>
  )
}
