import { describe, expect, it, vi } from 'vitest'

const tracingMetrics = [
  {
    name: 'governed_trace_accepted_total',
    labelNames: ['family', 'source', 'type'],
  },
  {
    name: 'governed_trace_replayed_total',
    labelNames: ['family', 'source', 'type'],
  },
  {
    name: 'governed_trace_rejected_total',
    labelNames: ['family', 'source', 'type'],
  },
  {
    name: 'governed_trace_conflicting_total',
    labelNames: ['family', 'source', 'type'],
  },
  {
    name: 'governed_trace_ingest_duration_seconds',
    labelNames: ['family', 'source'],
  },
  {
    name: 'governed_trace_batch_size',
    labelNames: ['family', 'source'],
  },
  {
    name: 'governed_trace_query_count',
    labelNames: ['family', 'source'],
  },
  {
    name: 'governed_trace_read_duration_seconds',
    labelNames: ['family'],
  },
  {
    name: 'governed_trace_pool_acquisition_duration_seconds',
    labelNames: ['pool'],
  },
  {
    name: 'governed_trace_pool_rejections_total',
    labelNames: ['pool'],
  },
  {
    name: 'governed_trace_pool_connections',
    labelNames: ['pool', 'state'],
  },
  {
    name: 'governed_trace_pool_statement_timeouts_total',
    labelNames: ['pool'],
  },
  {
    name: 'governed_trace_admission_requests_total',
    labelNames: ['family', 'result', 'reason'],
  },
  {
    name: 'governed_trace_request_body_bytes',
    labelNames: ['family'],
  },
  {
    name: 'governed_trace_in_flight_requests',
    labelNames: [],
  },
  {
    name: 'governed_trace_operational_errors_total',
    labelNames: ['scope', 'reason'],
  },
  {
    name: 'governed_trace_last_error_timestamp_seconds',
    labelNames: ['scope', 'reason'],
  },
] as const

describe('governed tracing metric registration', () => {
  it('reuses the default-registry metrics after a fresh module import', async () => {
    const first = await import('../src/observability/metrics.js')
    vi.resetModules()
    const second = await import('../src/observability/metrics.js')

    expect(second.registry).toBe(first.registry)
    expect(second.governedTraceAcceptedTotal).toBe(first.governedTraceAcceptedTotal)

    for (const expected of tracingMetrics) {
      const metric = second.registry.getSingleMetric(expected.name)
      expect(metric).toBeDefined()
      expect((metric as { labelNames: string[] }).labelNames).toEqual(expected.labelNames)
      expect((metric as { labelNames: string[] }).labelNames).not.toEqual(
        expect.arrayContaining([
          'request_id',
          'run_id',
          'event_id',
          'user',
          'agent',
          'host',
          'workload',
          'recipe',
          'correlation_id',
          'session_id',
          'host_ref',
          'user_id',
          'team_id',
          'approval_request_id',
          'prompt',
          'prompt_length',
          'prompt_hash',
        ])
      )
    }

    const operationalMetric = second.governedTraceOperationalErrorsTotal
    const before = (await operationalMetric.get()).values
      .filter(value => value.labels.reason === 'prompt_history_rejected')
      .reduce((sum, value) => sum + value.value, 0)
    second.recordGovernedTraceOperationalError(
      'agent_run',
      'prompt_history_rejected',
      1_789_000_000
    )
    const after = (await operationalMetric.get()).values
      .filter(value => value.labels.reason === 'prompt_history_rejected')
      .reduce((sum, value) => sum + value.value, 0)
    expect(after - before).toBe(1)
  })
})
