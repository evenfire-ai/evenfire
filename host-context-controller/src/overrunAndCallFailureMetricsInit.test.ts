import { describe, expect, it } from 'vitest'
import {
  MCPSERVER_VERDICT_CALL_OUTCOMES,
  MCPSERVER_VERDICT_CALL_SITES,
  NETWORKPOLICY_PASS_OVERRUN_PHASES,
  NETWORKPOLICY_PASS_OVERRUN_SEVERITIES,
  countMcpServerVerdictCallFailure,
  countNetworkPolicyPassOverrun,
  registry,
} from './metrics'

const OVERRUNS = 'clerum_hcc_networkpolicy_pass_overruns_total'
const CALL_FAILURES = 'clerum_hcc_mcpserver_reconcile_call_failures_total'

/** Every exposed series of one counter, as "label=value,…" → value. */
async function series(name: string): Promise<Map<string, number>> {
  const metric = registry.getSingleMetric(name)
  if (!metric) throw new Error(`${name} is not registered`)
  const snapshot = await metric.get()
  return new Map(
    snapshot.values.map(entry => {
      const { service: _service, ...labels } = entry.labels
      const key = Object.entries(labels)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([label, value]) => `${label}=${value}`)
        .join(',')
      return [key, entry.value]
    })
  )
}

function overrunKey(severity: string, phase: string): string {
  return `phase=${phase},severity=${severity}`
}

function callFailureKey(site: string, outcome: string): string {
  return `outcome=${outcome},site=${site}`
}

// Runs in its own test file, so its module instance never saw the
// registry.resetMetrics() that networkPolicyPassBound.integration.test.ts calls.
describe('labelled counters exposed at zero from start (#1338)', () => {
  it('exposes all 16 overrun and 8 call-failure label sets at 0, and an event moves only its own series', async () => {
    const overruns = await series(OVERRUNS)
    const callFailures = await series(CALL_FAILURES)
    let checked = 0
    for (const severity of NETWORKPOLICY_PASS_OVERRUN_SEVERITIES) {
      for (const phase of NETWORKPOLICY_PASS_OVERRUN_PHASES) {
        expect(overruns.get(overrunKey(severity, phase))).toBe(0)
        checked += 1
      }
    }
    for (const site of MCPSERVER_VERDICT_CALL_SITES) {
      for (const outcome of MCPSERVER_VERDICT_CALL_OUTCOMES) {
        expect(callFailures.get(callFailureKey(site, outcome))).toBe(0)
        checked += 1
      }
    }
    expect(checked).toBe(24)
    expect(overruns.size).toBe(16)
    expect(callFailures.size).toBe(8)

    countNetworkPolicyPassOverrun('warn', 'additive')
    countMcpServerVerdictCallFailure('rollout_read', 'verdict_kept')

    const overrunsAfter = await series(OVERRUNS)
    const callFailuresAfter = await series(CALL_FAILURES)
    expect(overrunsAfter.get(overrunKey('warn', 'additive'))).toBe(1)
    expect(callFailuresAfter.get(callFailureKey('rollout_read', 'verdict_kept'))).toBe(1)
    const stillZero = [...overrunsAfter.values(), ...callFailuresAfter.values()].filter(
      value => value === 0
    ).length
    expect(stillZero).toBe(22)
  })
})
