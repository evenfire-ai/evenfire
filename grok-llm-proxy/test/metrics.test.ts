import { describe, expect, it } from 'vitest'
import { Registry } from 'prom-client'
import { createProxyMetrics } from '../src/metrics.js'
import { STREAM_LIMITS } from '../src/requestLimits.js'

type Bucket = { le: number; count: number }

async function streamDurationBuckets(register: Registry): Promise<Bucket[]> {
  const metric = (await register.getMetricsAsJSON()).find(
    entry => entry.name === 'grok_llm_proxy_stream_duration_seconds'
  )
  expect(metric, 'stream duration histogram must be registered').toBeDefined()
  return (metric!.values as Array<{ metricName?: string; labels: { le?: number | string }; value: number }>)
    .filter(value => value.metricName === 'grok_llm_proxy_stream_duration_seconds_bucket')
    // prom-client labels the overflow bucket '+Inf', which Number() reads as NaN.
    .map(value => ({
      le: value.labels.le === '+Inf' ? Infinity : Number(value.labels.le),
      count: value.value,
    }))
}

describe('stream duration histogram', () => {
  it('resolves every duration up to the stream cap into a finite bucket', async () => {
    const register = new Registry()
    const metrics = createProxyMetrics(register)
    // A stream between the old 300 s cap and the current one.
    metrics.observeStream(1_500_000)
    const buckets = await streamDurationBuckets(register)
    const finite = buckets.filter(bucket => Number.isFinite(bucket.le))
    // Liveness witness: the observation reached the histogram.
    expect(buckets.find(bucket => bucket.le === Infinity)?.count).toBe(1)
    expect(Math.max(...finite.map(bucket => bucket.le))).toBeGreaterThanOrEqual(
      STREAM_LIMITS.maxStreamDurationMs / 1000
    )
    expect(buckets.find(bucket => bucket.le === 1200)?.count).toBe(0)
    expect(buckets.find(bucket => bucket.le === 1800)?.count).toBe(1)
  })
})
