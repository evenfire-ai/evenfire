import { describe, expect, it, vi } from 'vitest'
import { register } from 'prom-client'

const expected = [
  ['clerum_mcp_host_governed_trace_enqueued_total', ['type', 'priority']],
  ['clerum_mcp_host_governed_trace_dropped_total', ['type', 'priority', 'reason']],
  ['clerum_mcp_host_governed_trace_gaps_total', ['type', 'reason']],
  ['clerum_mcp_host_governed_trace_flushes_total', ['result']],
  ['clerum_mcp_host_governed_trace_batch_size', []],
] as const

describe('mcp-host governed run metrics', () => {
  it('reuses the existing Prometheus registry with bounded labels', async () => {
    const first = await import('./governedRunMetrics.js')
    vi.resetModules()
    const second = await import('./governedRunMetrics.js')

    expect(second.governedRunEnqueuedTotal).toBe(first.governedRunEnqueuedTotal)
    for (const [name, labels] of expected) {
      const metric = register.getSingleMetric(name)
      expect(metric).toBeDefined()
      expect((metric as unknown as { labelNames: string[] }).labelNames).toEqual(labels)
    }
  })

  it('exposes the instruments through the existing mcp-host scrape registry', async () => {
    const metrics = await register.metrics()
    for (const [name] of expected) expect(metrics).toContain(`# HELP ${name}`)
  })
})
