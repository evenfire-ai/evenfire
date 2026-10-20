import { describe, expect, it } from 'vitest'

const expected = [
  ['clerum_wrc_reconciliations_total', ['trigger', 'outcome']],
  ['clerum_wrc_reconcile_duration_seconds', ['trigger']],
  ['clerum_wrc_timer_checks_total', ['timer', 'result']],
] as const

describe('WRC reconcile cadence metrics (#1016)', () => {
  it('registers bounded-label cadence metrics on the WRC registry', async () => {
    const { registry } = await import('./metrics')
    for (const [name, labels] of expected) {
      const metric = registry.getSingleMetric(name)
      expect(metric, name).toBeDefined()
      expect((metric as unknown as { labelNames: string[] }).labelNames).toEqual(labels)
    }
  })

  it('exposes them through the scrape registry after an increment', async () => {
    const m = await import('./metrics')
    m.reconciliationsTotal.inc({ trigger: 'watch', outcome: 'noop' })
    m.reconcileDurationSeconds.observe({ trigger: 'watch' }, 0.01)
    m.timerChecksTotal.inc({ timer: 'egress', result: 'clean' })
    const scrape = await m.registry.metrics()
    expect(scrape).toContain('clerum_wrc_reconciliations_total{trigger="watch",outcome="noop"')
    expect(scrape).toContain('clerum_wrc_reconcile_duration_seconds_bucket{le=')
    expect(scrape).toContain('clerum_wrc_timer_checks_total{timer="egress",result="clean"')
  })
})
