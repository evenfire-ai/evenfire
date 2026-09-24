import { Counter, Histogram, Registry } from 'prom-client'

export function createProxyMetrics(register: Registry) {
  const outcomes = new Counter({
    name: 'grok_llm_proxy_attempts_total',
    help: 'Grok proxy attempt outcomes',
    labelNames: ['outcome', 'operation'],
    registers: [register],
  })
  const streamSeconds = new Histogram({
    name: 'grok_llm_proxy_stream_duration_seconds',
    help: 'Grok proxy stream duration',
    // Up to the 1800 s stream cap, so no in-range stream lands only in +Inf.
    buckets: [0.1, 0.5, 1, 2, 5, 15, 30, 60, 120, 300, 600, 1200, 1800],
    registers: [register],
  })
  const attemptFailures = new Counter({
    name: 'grok_proxy_attempt_failures_total',
    help: 'Grok completion attempts that failed, by provider error code',
    labelNames: ['code'],
    registers: [register],
  })
  const upstreamTimeouts = new Counter({
    name: 'grok_proxy_upstream_timeouts_total',
    help: 'Grok upstream streams cut by the proxy, by bound (idle silence or total duration)',
    labelNames: ['kind'],
    registers: [register],
  })
  return {
    observeAttempt(outcome: string, operation: string) {
      outcomes.inc({ outcome, operation })
    },
    observeAttemptFailure(code: string) {
      attemptFailures.inc({ code })
    },
    observeUpstreamTimeout(kind: 'idle' | 'total') {
      upstreamTimeouts.inc({ kind })
    },
    observeStream(durationMs: number) {
      streamSeconds.observe(durationMs / 1000)
    },
  }
}

export type ProxyMetrics = ReturnType<typeof createProxyMetrics>
