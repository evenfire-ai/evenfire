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
    buckets: [0.1, 0.5, 1, 2, 5, 15, 30, 60, 120, 300],
    registers: [register],
  })
  return {
    observeAttempt(outcome: string, operation: string) {
      outcomes.inc({ outcome, operation })
    },
    observeStream(durationMs: number) {
      streamSeconds.observe(durationMs / 1000)
    },
  }
}

export type ProxyMetrics = ReturnType<typeof createProxyMetrics>
