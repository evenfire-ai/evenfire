import type { SessionTokensLite } from '../../hooks/useChatStore'
import { formatTokenCount } from '../../lib/format'

/**
 * Shared internals for the two token-usage indicators (header pill +
 * per-message micro label). Input and output render as separate compact
 * stats with direction glyphs (↑ sent to the model, ↓ generated); a cache
 * glyph appears ONLY when the model reports cache figures (cacheRead/
 * cacheWrite defined) — providers that don't expose cache info (OpenAI /
 * zai / bailian) show input/output only. The exact breakdown lives in a
 * custom hover/focus tooltip (same pattern as .agent-runtime-age-tooltip),
 * so the wrapper element must be focusable and `position: relative`
 * (`.token-usage` provides both hooks).
 */

export function hasCacheInfo(tokens: SessionTokensLite): boolean {
  return tokens.cacheRead !== undefined || tokens.cacheWrite !== undefined
}

function ArrowUpIcon() {
  return (
    <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
      <path
        d="M6 10V2M6 2 2.5 5.5M6 2l3.5 3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ArrowDownIcon() {
  return (
    <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
      <path
        d="M6 2v8m0 0 3.5-3.5M6 10 2.5 6.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function CacheIcon() {
  return (
    <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
      <ellipse cx="6" cy="3" rx="4" ry="1.7" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M2 3v3c0 .94 1.79 1.7 4 1.7S10 6.94 10 6V3M2 6v3c0 .94 1.79 1.7 4 1.7S10 9.94 10 9V6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  )
}

export interface TokenUsagePartsProps {
  tokens: SessionTokensLite
}

/** Visible stat segments. Hidden from AT — the wrapper's aria-label carries the figures. */
export function TokenUsageStats({ tokens }: TokenUsagePartsProps) {
  return (
    <>
      <span className="token-usage-stat" aria-hidden="true">
        <ArrowUpIcon />
        {formatTokenCount(tokens.input)}
      </span>
      <span className="token-usage-stat" aria-hidden="true">
        <ArrowDownIcon />
        {formatTokenCount(tokens.output)}
      </span>
      {hasCacheInfo(tokens) && (
        <span className="token-usage-stat token-usage-stat--cache" aria-hidden="true">
          <CacheIcon />
        </span>
      )}
    </>
  )
}

function TooltipRow({ label, value }: { label: string; value: number }) {
  return (
    <span className="token-usage-tooltip-row">
      <span className="token-usage-tooltip-label">{label}</span>
      <span className="token-usage-tooltip-value">{value.toLocaleString()}</span>
    </span>
  )
}

/** Hover/focus breakdown panel. Hidden from AT — the wrapper's aria-label carries the figures. */
export function TokenUsageTooltip({ tokens }: TokenUsagePartsProps) {
  return (
    <span className="token-usage-tooltip" aria-hidden="true">
      <TooltipRow label="Input" value={tokens.input} />
      <TooltipRow label="Output" value={tokens.output} />
      {hasCacheInfo(tokens) && (
        <>
          <span className="token-usage-tooltip-divider" />
          <TooltipRow label="Cache read" value={tokens.cacheRead ?? 0} />
          <TooltipRow label="Cache write" value={tokens.cacheWrite ?? 0} />
        </>
      )}
    </span>
  )
}
