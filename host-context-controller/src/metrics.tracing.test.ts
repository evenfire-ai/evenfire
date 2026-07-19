import { describe, expect, it, vi } from 'vitest'

const expected = [
  ['clerum_hcc_infrastructure_telemetry_enqueued_total', ['telemetry_type']],
  ['clerum_hcc_infrastructure_telemetry_dropped_total', ['telemetry_type', 'reason']],
  ['clerum_hcc_infrastructure_telemetry_flushes_total', ['result']],
  ['clerum_hcc_infrastructure_telemetry_retries_total', ['telemetry_type']],
  ['clerum_hcc_infrastructure_telemetry_gaps_total', ['telemetry_type', 'reason']],
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

describe('HCC governed tracing metrics', () => {
  it('survives repeated imports on the existing HCC registry with bounded labels', async () => {
    const first = await import('./metrics')
    vi.resetModules()
    const second = await import('./metrics')

    expect(second.registry).toBe(first.registry)
    expect(second.infrastructureTelemetryEnqueuedTotal).toBe(
      first.infrastructureTelemetryEnqueuedTotal
    )
    for (const [name, labels] of expected) {
      const metric = second.registry.getSingleMetric(name)
      expect(metric).toBeDefined()
      expect((metric as unknown as { labelNames: string[] }).labelNames).toEqual(labels)
      expect(labels.some(label => forbiddenLabels.has(label))).toBe(false)
    }
  })

  it('exposes governed tracing metrics through the HCC scrape registry', async () => {
    const { registry } = await import('./metrics')
    const scrape = await registry.metrics()
    for (const [name] of expected) expect(scrape).toContain(`# HELP ${name}`)
  })
})
