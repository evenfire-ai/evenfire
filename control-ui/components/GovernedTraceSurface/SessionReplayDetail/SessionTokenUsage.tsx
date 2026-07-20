'use client'

import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { GovernedTraceTokenUsage } from '@lib/governedTrace'

function formatTokens(value: number): string {
  return value.toLocaleString()
}

function coverageMessage(usage: GovernedTraceTokenUsage): string | null {
  if (usage.coverage === 'unavailable') {
    return `${usage.observedLlmCalls} LLM calls were observed, but no token usage events reached the central trace ledger.`
  }
  if (usage.coverage === 'partial') {
    return `The central trace ledger contains ${usage.meteredCalls} token usage events for ${usage.observedLlmCalls} observed LLM calls.`
  }
  return null
}

function cacheMessage(usage: GovernedTraceTokenUsage): string | null {
  if (usage.cacheReporting === 'unavailable' && usage.meteredCalls > 0) {
    return 'The provider did not report cache usage for the metered calls; zero cache tokens are not treated as a measured zero.'
  }
  if (usage.cacheReporting === 'partial') {
    return 'Only some metered calls include provider-reported cache usage.'
  }
  return null
}

function coverageLabel(usage: GovernedTraceTokenUsage): string {
  if (usage.coverage === 'unavailable') return 'No central usage events'
  return usage.coverage.replaceAll('_', ' ')
}

function cacheReportingLabel(usage: GovernedTraceTokenUsage): string {
  if (usage.cacheReporting === 'unavailable') return 'Not reported by provider'
  if (usage.cacheReporting === 'partial') return 'Partially reported by provider'
  if (usage.cacheReporting === 'complete') return 'Reported by provider'
  return 'Not applicable'
}

export function SessionTokenUsage({ usage }: { usage: GovernedTraceTokenUsage }) {
  let cumulativeTokens = 0
  const data = usage.points.map(point => {
    const callTokens = point.inputTokens + point.outputTokens
    cumulativeTokens += callTokens
    return {
      label: new Date(point.occurredAt).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }),
      cumulativeTokens,
      callTokens,
      model: `${point.provider} / ${point.model}`,
    }
  })
  const warning = coverageMessage(usage)
  const cacheWarning = cacheMessage(usage)

  return (
    <section className="cu-trace-detail-section" aria-labelledby="trace-session-token-usage">
      <div className="cu-trace-detail-section__head">
        <div>
          <h2 id="trace-session-token-usage">Token usage</h2>
          <p>Persisted central usage by LLM call for this MCP host session.</p>
        </div>
        <span>{usage.meteredCalls} metered calls</span>
      </div>
      {warning ? (
        <div className="cu-banner cu-banner--warning" role="status">
          {warning}
        </div>
      ) : null}
      {cacheWarning ? (
        <div className="cu-trace-token-warning" role="status">
          {cacheWarning}
        </div>
      ) : null}
      <dl className="cu-trace-token-metrics">
        <div>
          <dt>Input</dt>
          <dd>{formatTokens(usage.inputTokens)}</dd>
        </div>
        <div>
          <dt>Output</dt>
          <dd>{formatTokens(usage.outputTokens)}</dd>
        </div>
        <div>
          <dt>Cache read</dt>
          <dd>{formatTokens(usage.cacheReadTokens)}</dd>
        </div>
        <div>
          <dt>Cache write</dt>
          <dd>{formatTokens(usage.cacheWriteTokens)}</dd>
        </div>
        <div>
          <dt>Central coverage</dt>
          <dd>{coverageLabel(usage)}</dd>
        </div>
        <div>
          <dt>Cache reporting</dt>
          <dd>{cacheReportingLabel(usage)}</dd>
        </div>
      </dl>
      {data.length ? (
        <div
          aria-label={`Cumulative input and output token usage across ${data.length} metered calls, ending at ${formatTokens(cumulativeTokens)} tokens`}
          className="cu-trace-token-chart"
          role="img"
        >
          <ResponsiveContainer height="100%" width="100%">
            <AreaChart data={data} margin={{ bottom: 4, left: 4, right: 12, top: 8 }}>
              <CartesianGrid stroke="var(--cu-border-subtle)" vertical={false} />
              <XAxis dataKey="label" fontSize={11} minTickGap={24} stroke="var(--cu-text-muted)" />
              <YAxis allowDecimals={false} fontSize={11} stroke="var(--cu-text-muted)" width={52} />
              <Tooltip
                contentStyle={{
                  background: 'var(--cu-bg-elevated)',
                  border: '1px solid var(--cu-border-subtle)',
                  fontSize: 12,
                }}
                formatter={(value, name) => [
                  formatTokens(Number(value)),
                  name === 'cumulativeTokens' ? 'Cumulative input + output' : 'Call tokens',
                ]}
              />
              <Area
                dataKey="cumulativeTokens"
                fill="var(--cu-link)"
                fillOpacity={0.45}
                name="cumulativeTokens"
                stroke="var(--cu-link)"
                strokeWidth={2}
                type="monotone"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="cu-empty">No centrally persisted token usage is available.</div>
      )}
      {usage.pointsTruncated ? (
        <div className="cu-trace-token-warning" role="status">
          The chart is limited to the first 200 persisted calls in this replay window.
        </div>
      ) : null}
    </section>
  )
}
