import { describe, expect, it, vi } from 'vitest'

const expected = [
  ['clerum_wrc_governed_trace_enqueued_total', ['family', 'type']],
  ['clerum_wrc_governed_trace_dropped_total', ['family', 'type', 'reason']],
  ['clerum_wrc_governed_trace_flushes_total', ['family', 'result']],
  ['clerum_wrc_governed_trace_retries_total', ['family', 'type']],
  ['clerum_wrc_governed_trace_gaps_total', ['family', 'type', 'reason']],
] as const

const forbiddenLabels = new Set([
  'run_id',
  'event_id',
  'request_id',
  'session_id',
  'human',
  'agent',
  'team_id',
])

describe('WRC governed tracing metrics', () => {
  it('survives repeated imports on the existing WRC registry with bounded labels', async () => {
    const first = await import('./metrics')
    vi.resetModules()
    const second = await import('./metrics')

    expect(second.registry).toBe(first.registry)
    expect(second.governedTraceEnqueuedTotal).toBe(first.governedTraceEnqueuedTotal)
    for (const [name, labels] of expected) {
      const metric = second.registry.getSingleMetric(name)
      expect(metric).toBeDefined()
      expect((metric as unknown as { labelNames: string[] }).labelNames).toEqual(labels)
      expect(labels.some(label => forbiddenLabels.has(label))).toBe(false)
    }
  })

  it('exposes governed tracing metrics through the WRC scrape registry', async () => {
    const { registry } = await import('./metrics')
    const scrape = await registry.metrics()
    for (const [name] of expected) expect(scrape).toContain(`# HELP ${name}`)
  })
})
