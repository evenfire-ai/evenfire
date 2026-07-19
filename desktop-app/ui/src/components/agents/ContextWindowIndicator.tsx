import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { makeTaskKey } from '@contexts/AgentTaskTrackerContext/types'
import { useClickOutside } from '@hooks/useClickOutside'
import type { ContextBreakdownLite } from '../../hooks/useChatStore'
import { useContextBreakdown } from '../../hooks/useContextBreakdown'
import { formatBucketPercent, formatContextFill, formatTokenCount } from '../../lib/format'
import { Pill } from '../Common'

export interface ContextWindowIndicatorProps {
  agentRef: string
  chatId: string
  /**
   * A monotonically-advancing turn signal for the active chat (the lifetime
   * input-token count from the session poll). Each time it advances we force a
   * re-probe of the breakdown, so the chip appears as soon as a turn completes
   * without the user having to leave and re-enter the chat. Undefined until the
   * first poll lands.
   */
  turnSignal?: number
}

/** Human-readable labels + stable order for the four breakdown buckets. */
const BUCKET_LABELS: Record<keyof ContextBreakdownLite['buckets'], string> = {
  messages: 'Messages',
  systemTools: 'System tools',
  metaContext: 'Meta context',
  systemPrompt: 'System prompt',
}

interface ComputedBucket {
  key: keyof ContextBreakdownLite['buckets']
  label: string
  raw: number
  fraction: number
  tokens: number
}

/**
 * Derives display rows from the raw bucket counts: percentage = bucket / Σbuckets,
 * absolute tokens scaled to the authoritative `totalInputTokens`
 * (`round(bucket / Σ × total)`). Rows are sorted descending by share.
 */
function computeBuckets(breakdown: ContextBreakdownLite): ComputedBucket[] {
  const entries = Object.entries(breakdown.buckets) as Array<
    [keyof ContextBreakdownLite['buckets'], number]
  >
  const sum = entries.reduce((acc, [, value]) => acc + (value > 0 ? value : 0), 0)
  return entries
    .map(([key, raw]) => {
      const fraction = sum > 0 ? Math.max(0, raw) / sum : 0
      return {
        key,
        label: BUCKET_LABELS[key],
        raw,
        fraction,
        tokens: Math.round(fraction * breakdown.totalInputTokens),
      }
    })
    .sort((a, b) => b.fraction - a.fraction)
}

/**
 * Discreet header chip showing the CURRENT context-window fill (`N/M (P%)`), and
 * a click-to-open popover with a stacked bar + per-bucket rows. Unlike the
 * lifetime-token pill, the breakdown is fetched lazily: a single probe runs on
 * mount / chat change so we know whether a snapshot exists, and the popover
 * refetches (if stale) on open (#4).
 *
 * Empty-state policy: the chip renders nothing until we actually have a fill
 * figure to show. While the probe is in flight (loading, no data yet) we render
 * a muted icon-only pill so the header doesn't flash; once the probe resolves to
 * `null` (cold session / no snapshot) the chip is hidden entirely — no bare "—".
 * As soon as a snapshot arrives the full `N/M (P%)` chip appears.
 */
export function ContextWindowIndicator({
  agentRef,
  chatId,
  turnSignal,
}: ContextWindowIndicatorProps) {
  const { getBreakdown, isLoading, fetchContextBreakdown } = useContextBreakdown()
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)

  useClickOutside(containerRef, open, () => setOpen(false))

  const breakdown = getBreakdown(agentRef, chatId)
  const loading = isLoading(agentRef, chatId)

  // Probe once per chat so the chip can decide whether to show itself without a
  // click. The hook short-circuits on a fresh-enough/in-flight entry, so this is
  // a single round-trip; the popover still refetches-on-open below.
  useEffect(() => {
    void fetchContextBreakdown(agentRef, chatId)
  }, [agentRef, chatId, fetchContextBreakdown])

  // A new session's mount probe runs before the task registers its snapshot
  // server-side, so it resolves to `null` and the chip stays hidden. When the
  // turn completes the poll's input-token count advances; re-probe (forced, to
  // skip the fresh/TTL short-circuit that would otherwise honour the cached
  // `null`) so the chip surfaces without a leave/re-enter. Skip the first
  // observation for a chat — the mount probe above already covers it — and no-op
  // when the signal hasn't actually advanced.
  const lastTurnSignalRef = useRef<{ key: string; signal: number | undefined } | null>(null)
  useEffect(() => {
    const key = makeTaskKey(agentRef, chatId)
    const prev = lastTurnSignalRef.current
    lastTurnSignalRef.current = { key, signal: turnSignal }
    if (!prev || prev.key !== key) return
    if (prev.signal === turnSignal) return
    void fetchContextBreakdown(agentRef, chatId, { force: true })
  }, [agentRef, chatId, turnSignal, fetchContextBreakdown])

  const handleToggle = useCallback(() => {
    setOpen(prev => {
      const next = !prev
      if (next) void fetchContextBreakdown(agentRef, chatId)
      return next
    })
  }, [agentRef, chatId, fetchContextBreakdown])

  const buckets = useMemo(() => (breakdown ? computeBuckets(breakdown) : []), [breakdown])

  // `undefined` = never fetched; `null` = fetched, no snapshot. Hide the chip
  // entirely when there is nothing to show and nothing is loading — a cold chat
  // shouldn't surface a bare "—". The muted icon-only pill below only appears
  // while the probe is in flight.
  if (!breakdown && !loading) return null

  // While loading without data we still have no fill figure: show an icon-only
  // muted pill (no "—") so the header stays calm until the probe resolves.
  const fillLabel = breakdown
    ? formatContextFill(breakdown.totalInputTokens, breakdown.maxTokens, breakdown.fillRatio)
    : null

  return (
    <div className="context-window-indicator" ref={containerRef}>
      <Pill
        tone="neutral"
        size="sm"
        interactive
        className={`context-window-chip${fillLabel ? '' : ' context-window-chip--loading'}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={fillLabel ? `Context window — ${fillLabel}` : 'Context window — loading'}
        onClick={handleToggle}
      >
        <span className="context-window-chip-glyph" aria-hidden="true" />
        {fillLabel && <span className="context-window-chip-label">{fillLabel}</span>}
      </Pill>

      {open && (
        <div className="context-window-popover" role="dialog" aria-label="Context window breakdown">
          {breakdown ? (
            <>
              <div className="context-window-popover-head">
                <span className="context-window-popover-title">Context window</span>
                <span className="context-window-popover-fill">{fillLabel}</span>
              </div>

              <div
                className="context-window-bar"
                role="img"
                aria-label={`Context composition: ${buckets
                  .map(b => `${b.label} ${formatBucketPercent(b.fraction)}`)
                  .join(', ')}`}
              >
                {buckets.map(bucket => (
                  <span
                    key={bucket.key}
                    className={`context-window-bar-seg context-window-bar-seg--${bucket.key}`}
                    // Runtime, data-driven width fed through a CSS custom property
                    // (consumed by `.context-window-bar-seg` in styles.css). The
                    // per-bucket background stays class-driven from design tokens.
                    style={{ ['--seg-width' as string]: `${(bucket.fraction * 100).toFixed(3)}%` }}
                  />
                ))}
              </div>

              <ul className="context-window-rows">
                {buckets.map(bucket => (
                  <li
                    key={bucket.key}
                    className="context-window-row"
                    title={`${formatTokenCount(bucket.tokens)} tokens`}
                  >
                    <span
                      className={`context-window-dot context-window-dot--${bucket.key}`}
                      aria-hidden="true"
                    />
                    <span className="context-window-row-label">{bucket.label}</span>
                    <span className="context-window-row-pct">
                      {formatBucketPercent(bucket.fraction)}
                    </span>
                  </li>
                ))}
              </ul>

              {breakdown.cacheHitRate !== undefined && (
                <div className="context-window-cache">
                  Average cache hit rate {formatBucketPercent(breakdown.cacheHitRate)}
                </div>
              )}
            </>
          ) : loading ? (
            <div className="context-window-empty">Loading…</div>
          ) : (
            <div className="context-window-empty">No context snapshot yet.</div>
          )}
        </div>
      )}
    </div>
  )
}
