import { useEffect, useMemo, useRef, useState } from 'react'
import { makeTaskKey } from '@contexts/AgentTaskTrackerContext/types'
import { Button, Flex, Listy, Popover, Progress, Spin, Typography } from 'antd'
import type { ContextBreakdownLite } from '../../hooks/useChatStore'
import { useContextBreakdown } from '../../hooks/useContextBreakdown'
import { formatBucketPercent, formatContextFill, formatTokenCount } from '../../lib/format'

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

  const content = breakdown ? (
    <div role="dialog" aria-label="Context window breakdown">
      <Flex align="center" justify="space-between">
        <Typography.Text strong>Context window</Typography.Text>
        <Typography.Text>{fillLabel}</Typography.Text>
      </Flex>
      <div role="list" aria-label="Context token groups">
        <Listy
          items={buckets}
          rowKey="key"
          virtual={false}
          itemRender={bucket => (
            <div role="listitem">
              <Flex align="center" gap="small">
                <Typography.Text>{bucket.label}</Typography.Text>
                <Flex flex={1}>
                  <Progress percent={bucket.fraction * 100} size="small" showInfo={false} />
                </Flex>
                <Typography.Text>{formatBucketPercent(bucket.fraction)}</Typography.Text>
                <Typography.Text
                  title={`${formatTokenCount(bucket.tokens)} tokens`}
                  type="secondary"
                >
                  {formatTokenCount(bucket.tokens)}
                </Typography.Text>
              </Flex>
            </div>
          )}
        />
      </div>
      {breakdown.cacheHitRate !== undefined ? (
        <Typography.Text type="secondary">
          Average cache hit rate {formatBucketPercent(breakdown.cacheHitRate)}
        </Typography.Text>
      ) : null}
    </div>
  ) : loading ? (
    <Typography.Text>Loading…</Typography.Text>
  ) : (
    <Typography.Text>No context snapshot yet.</Typography.Text>
  )

  return (
    <Popover
      content={content}
      open={open}
      onOpenChange={next => {
        setOpen(next)
        if (next) void fetchContextBreakdown(agentRef, chatId)
      }}
      title="Context window breakdown"
      trigger="click"
    >
      <Button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={fillLabel ? `Context window — ${fillLabel}` : 'Context window — loading'}
        icon={
          fillLabel ? (
            <span className="context-window-chip-glyph" aria-hidden="true" />
          ) : (
            <Spin size="small" />
          )
        }
        size="small"
        type="text"
      >
        {fillLabel}
      </Button>
    </Popover>
  )
}
