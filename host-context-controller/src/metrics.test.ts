import { describe, expect, it } from 'vitest'
import {
  NETWORKPOLICY_PASS_DURATION_BUCKETS,
  initialConvergencePassDurationSeconds,
  networkPolicySafetyPassDurationSeconds,
  registry,
} from './metrics'

async function readHistogramBucket(name: string, labels: Record<string, string>): Promise<number> {
  const metric = registry.getSingleMetric(name)
  if (!metric) throw new Error(`${name} is not registered`)
  const snapshot = await metric.get()
  return (
    snapshot.values.find(entry =>
      Object.entries(labels).every(([key, value]) => String(entry.labels[key]) === value)
    )?.value ?? 0
  )
}

describe('NetworkPolicy pass-duration histogram buckets', () => {
  it('includes the 300s GKE recycle cut and longer diagnostic tails', () => {
    expect([...NETWORKPOLICY_PASS_DURATION_BUCKETS]).toEqual([
      1, 5, 15, 60, 120, 300, 600, 1200, 1800, 3600,
    ])
  })

  it('records a 250s initial-convergence pass in the 300s bucket, not +Inf-only', async () => {
    const name = 'clerum_hcc_initial_convergence_pass_duration_seconds'
    const labels = { lane: 'NetworkPolicy', result: 'certified' }
    const before120 = await readHistogramBucket(name, { ...labels, le: '120' })
    const before300 = await readHistogramBucket(name, { ...labels, le: '300' })
    const beforeInf = await readHistogramBucket(name, { ...labels, le: '+Inf' })

    initialConvergencePassDurationSeconds.observe(labels, 250)

    expect(await readHistogramBucket(name, { ...labels, le: '120' })).toBe(before120)
    expect(await readHistogramBucket(name, { ...labels, le: '300' })).toBe(before300 + 1)
    expect(await readHistogramBucket(name, { ...labels, le: '+Inf' })).toBe(beforeInf + 1)
  })

  it('records a 250s safety pass in the 300s bucket, not +Inf-only', async () => {
    const name = 'clerum_hcc_networkpolicy_safety_pass_duration_seconds'
    const labels = { outcome: 'completed' }
    const before120 = await readHistogramBucket(name, { ...labels, le: '120' })
    const before300 = await readHistogramBucket(name, { ...labels, le: '300' })
    const beforeInf = await readHistogramBucket(name, { ...labels, le: '+Inf' })

    networkPolicySafetyPassDurationSeconds.observe(labels, 250)

    expect(await readHistogramBucket(name, { ...labels, le: '120' })).toBe(before120)
    expect(await readHistogramBucket(name, { ...labels, le: '300' })).toBe(before300 + 1)
    expect(await readHistogramBucket(name, { ...labels, le: '+Inf' })).toBe(beforeInf + 1)
  })
})
