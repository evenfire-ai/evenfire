import { describe, expect, it } from 'vitest'
import { Registry } from 'prom-client'
import { registerProcessMetrics } from '../observability/processMetrics'

describe('process metrics registration', () => {
  it('registers the default process metric set once per injected registry', async () => {
    const registry = new Registry()
    registerProcessMetrics(registry)
    registerProcessMetrics(registry)

    expect(registry.getSingleMetric('process_cpu_user_seconds_total')).toBeDefined()
    const scrape = await registry.metrics()
    expect(scrape.match(/# HELP process_cpu_user_seconds_total/g)).toHaveLength(1)
  })
})
