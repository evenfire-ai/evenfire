/**
 * gfsc SRE metrics / SLIs (spec plan §Operations and SRE; plan P5-S02). Records
 * the service-level indicators and renders them in Prometheus text for the
 * /metrics endpoint: writer availability, p99 read/write latency, mount
 * failures, read-after-write lag, quota usage, and cache hit rate.
 */

export interface SliSnapshot {
  writerAvailable: number
  readLatencyP99Ms: number
  writeLatencyP99Ms: number
  mountFailures: number
  readAfterWriteLagMs: number
  quotaUsageRatio: number
  cacheHitRate: number
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, idx)] ?? 0
}

export class GfsMetrics {
  private writerAvailable = 1
  private readonly readLat: number[] = []
  private readonly writeLat: number[] = []
  private mountFailures = 0
  private readAfterWriteLagMs = 0
  private quotaUsageRatio = 0
  private cacheHits = 0
  private cacheMisses = 0

  /** Cap retained latency samples so a long-running writer cannot grow unbounded. */
  private static readonly MAX_LAT_SAMPLES = 10_000
  private capped(arr: number[], ms: number): void {
    arr.push(ms)
    if (arr.length > GfsMetrics.MAX_LAT_SAMPLES) arr.shift()
  }
  recordRead(ms: number): void {
    this.capped(this.readLat, ms)
  }
  recordWrite(ms: number): void {
    this.capped(this.writeLat, ms)
  }
  recordMountFailure(): void {
    this.mountFailures += 1
  }
  recordCache(hit: boolean): void {
    if (hit) this.cacheHits += 1
    else this.cacheMisses += 1
  }
  setWriterAvailable(available: boolean): void {
    this.writerAvailable = available ? 1 : 0
  }
  setQuotaUsageRatio(ratio: number): void {
    this.quotaUsageRatio = ratio
  }
  setReadAfterWriteLagMs(ms: number): void {
    this.readAfterWriteLagMs = ms
  }

  snapshot(): SliSnapshot {
    const totalCache = this.cacheHits + this.cacheMisses
    return {
      writerAvailable: this.writerAvailable,
      readLatencyP99Ms: percentile(this.readLat, 99),
      writeLatencyP99Ms: percentile(this.writeLat, 99),
      mountFailures: this.mountFailures,
      readAfterWriteLagMs: this.readAfterWriteLagMs,
      quotaUsageRatio: this.quotaUsageRatio,
      cacheHitRate: totalCache === 0 ? 0 : this.cacheHits / totalCache,
    }
  }

  /** Prometheus text exposition of every SLI. */
  render(): string {
    const s = this.snapshot()
    const lines = [
      '# gfsc service-level indicators',
      `gfs_writer_available ${s.writerAvailable}`,
      `gfs_read_latency_p99_ms ${s.readLatencyP99Ms}`,
      `gfs_write_latency_p99_ms ${s.writeLatencyP99Ms}`,
      `gfs_mount_failures_total ${s.mountFailures}`,
      `gfs_read_after_write_lag_ms ${s.readAfterWriteLagMs}`,
      `gfs_quota_usage_ratio ${s.quotaUsageRatio}`,
      `gfs_cache_hit_rate ${s.cacheHitRate}`,
    ]
    return lines.join('\n') + '\n'
  }
}
