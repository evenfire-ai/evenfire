import { describe, expect, it, vi } from 'vitest'
import type * as k8s from '@kubernetes/client-node'
import { ManagedDeploymentInformer } from './informers/deploymentInformer'
import { SecretInformer } from './informers/secretInformer'
import {
  MCPSERVER_ROLLOUT_REREAD_OUTCOMES,
  MCPSERVER_VERDICT_CALL_OUTCOMES,
  MCPSERVER_VERDICT_CALL_SITES,
  NETWORKPOLICY_PASS_OVERRUN_PHASES,
  NETWORKPOLICY_PASS_OVERRUN_SEVERITIES,
  SECRET_ACCESS_PROBE_OUTCOMES,
  SECRET_INFORMER_EVENT_TYPES,
  SECRET_INFORMER_LIST_OUTCOMES,
  countMcpServerRolloutReread,
  countMcpServerVerdictCallFailure,
  countNetworkPolicyPassOverrun,
  countSecretAccessProbe,
  countSecretInformerList,
  countSecretInformerResume,
  registry,
} from './metrics'

const OVERRUNS = 'clerum_hcc_networkpolicy_pass_overruns_total'
const CALL_FAILURES = 'clerum_hcc_mcpserver_reconcile_call_failures_total'
const SWALLOWED = 'clerum_hcc_initial_convergence_swallowed_total'

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

  it('exposes only the inventory-changed swallowed sink at 0 from import (BR-11)', async () => {
    const swallowed = await series(SWALLOWED)
    expect(swallowed.get('lane=NetworkPolicy,sink=inventory-changed')).toBe(0)
    // The sinks that were not exposed at 0 before this release stay absent.
    expect([...swallowed.keys()]).toEqual(['lane=NetworkPolicy,sink=inventory-changed'])
  })
})

const PROBES = 'clerum_hcc_secret_access_probes_total'
const REREADS = 'clerum_hcc_mcpserver_rollout_rereads_total'
const LISTS = 'clerum_hcc_secret_informer_lists_total'
const RESUMES = 'clerum_hcc_secret_informer_resumes_total'
const RUNNING = 'clerum_hcc_secret_informer_running'

function informer(namespace: string, mode: 'resume' | 'replay'): SecretInformer {
  const watch = { watch: vi.fn() }
  return new SecretInformer(
    {} as k8s.KubeConfig,
    namespace,
    () => undefined,
    mode === 'resume' ? { mode, list: vi.fn() } : { mode },
    { watch }
  )
}

function seriesFor(all: Map<string, number>, namespace: string): string[] {
  return [...all.keys()].filter(key => key.split(',').includes(`namespace=${namespace}`))
}

describe('PR-2 labelled counters exposed at zero (zach88 R1-L12 class)', () => {
  it('T1.1 exposes the 4 access-probe and the 4 rollout re-read series at 0 from import', async () => {
    const probes = await series(PROBES)
    const rereads = await series(REREADS)
    for (const outcome of SECRET_ACCESS_PROBE_OUTCOMES) {
      expect(probes.get(`outcome=${outcome}`)).toBe(0)
    }
    for (const outcome of MCPSERVER_ROLLOUT_REREAD_OUTCOMES) {
      expect(rereads.get(`outcome=${outcome}`)).toBe(0)
    }
    expect(probes.size).toBe(4)
    expect(rereads.size).toBe(4)
  })

  it('T1.2 a resume-mode SecretInformer exposes its three list series and its resume series at 0', async () => {
    expect(seriesFor(await series(LISTS), 't12-resume')).toEqual([])
    informer('t12-resume', 'resume')
    const lists = await series(LISTS)
    for (const outcome of SECRET_INFORMER_LIST_OUTCOMES) {
      expect(lists.get(`namespace=t12-resume,outcome=${outcome}`)).toBe(0)
    }
    expect(seriesFor(lists, 't12-resume')).toHaveLength(3)
    expect((await series(RESUMES)).get('namespace=t12-resume')).toBe(0)
  })

  it('T1.3 a replay-mode SecretInformer exposes none of them', async () => {
    const replay = informer('t13-replay', 'replay')
    // Witness: the same construction in resume mode exposes the series, so the
    // absence below comes from the mode check, not from an exposure that never runs.
    informer('t13-resume', 'resume')
    // Witness that the replay informer itself ran and emits namespaced series.
    replay.stop()
    expect((await series(RUNNING)).get('namespace=t13-replay')).toBe(0)
    expect(seriesFor(await series(LISTS), 't13-resume')).toHaveLength(3)
    expect(seriesFor(await series(LISTS), 't13-replay')).toEqual([])
    expect(seriesFor(await series(RESUMES), 't13-replay')).toEqual([])
  })

  it('T1.5 an informer that is built and never started exposes its running gauge and event series at 0', async () => {
    const EVENTS = 'clerum_hcc_secret_informer_events_total'
    const DEPLOYMENT_RUNNING = 'clerum_hcc_deployment_informer_running'
    expect(seriesFor(await series(RUNNING), 't15')).toEqual([])
    expect(seriesFor(await series(EVENTS), 't15')).toEqual([])
    expect(seriesFor(await series(DEPLOYMENT_RUNNING), 't15')).toEqual([])

    informer('t15', 'replay')
    new ManagedDeploymentInformer({} as k8s.KubeConfig, 't15', () => undefined, vi.fn(), {
      watch: { watch: vi.fn() },
    })

    expect((await series(RUNNING)).get('namespace=t15')).toBe(0)
    const events = await series(EVENTS)
    for (const type of SECRET_INFORMER_EVENT_TYPES) {
      expect(events.get(`namespace=t15,type=${type}`)).toBe(0)
    }
    expect(seriesFor(events, 't15')).toHaveLength(3)
    expect((await series(DEPLOYMENT_RUNNING)).get('namespace=t15')).toBe(0)
  })

  it('T1.4 one increment through each helper moves exactly its own series by 1', async () => {
    informer('t14', 'resume')
    const names = [PROBES, REREADS, LISTS, RESUMES]
    const before = new Map<string, Map<string, number>>()
    for (const name of names) before.set(name, await series(name))

    countSecretAccessProbe('denied')
    countMcpServerRolloutReread('moved')
    countSecretInformerList('t14', 'relist')
    countSecretInformerResume('t14')

    const moved: Record<string, string> = {
      [PROBES]: 'outcome=denied',
      [REREADS]: 'outcome=moved',
      [LISTS]: 'namespace=t14,outcome=relist',
      [RESUMES]: 'namespace=t14',
    }
    let checked = 0
    for (const name of names) {
      const after = await series(name)
      const old = before.get(name)
      if (!old) throw new Error(`no snapshot of ${name}`)
      expect([...after.keys()].sort()).toEqual([...old.keys()].sort())
      for (const [key, value] of after) {
        expect(value - (old.get(key) ?? 0)).toBe(key === moved[name] ? 1 : 0)
        checked += 1
      }
    }
    expect(checked).toBeGreaterThanOrEqual(12)
  })
})
