import { describe, expect, it } from "vitest";
import { GfsMetrics } from "./metrics.js";

/**
 * P5-S02 — gfsc SLIs. /metrics exposes writer availability, p99 read/write
 * latency, mount failures, read-after-write lag, quota usage, cache hit rate.
 */

describe("GfsMetrics", () => {
  it("computes p99 latency from observations", () => {
    const m = new GfsMetrics();
    for (let i = 1; i <= 100; i++) m.recordRead(i);
    expect(m.snapshot().readLatencyP99Ms).toBe(99);
  });

  it("tracks mount failures, cache hit rate, and writer availability", () => {
    const m = new GfsMetrics();
    m.recordMountFailure();
    m.recordMountFailure();
    m.recordCache(true);
    m.recordCache(true);
    m.recordCache(false); // 2/3 hit rate
    m.setWriterAvailable(false);
    const s = m.snapshot();
    expect(s.mountFailures).toBe(2);
    expect(s.cacheHitRate).toBeCloseTo(2 / 3, 5);
    expect(s.writerAvailable).toBe(0);
  });

  it("renders every SLI in Prometheus text", () => {
    const m = new GfsMetrics();
    m.recordWrite(10);
    m.setQuotaUsageRatio(0.5);
    m.setReadAfterWriteLagMs(7);
    const text = m.render();
    for (const metric of [
      "gfs_writer_available",
      "gfs_read_latency_p99_ms",
      "gfs_write_latency_p99_ms",
      "gfs_mount_failures_total",
      "gfs_read_after_write_lag_ms",
      "gfs_quota_usage_ratio",
      "gfs_cache_hit_rate",
      "gfs_blob_orphan_candidates",
      "gfs_blob_orphan_bytes",
      "gfs_blob_cleanup_failures_total",
    ]) {
      expect(text).toContain(metric);
    }
    expect(text).toContain("gfs_quota_usage_ratio 0.5");
    expect(text).toContain("gfs_read_after_write_lag_ms 7");
  });

  it("tracks conservative blob reconciliation candidates and failures", () => {
    const m = new GfsMetrics();
    m.setOrphanCandidates(3, 4096);
    m.recordBlobCleanupFailure();
    expect(m.snapshot()).toMatchObject({
      orphanCandidates: 3,
      orphanBytes: 4096,
      blobCleanupFailures: 1,
    });
  });

  it("is zero-valued before any observation (empty p99 = 0, no division by zero)", () => {
    const s = new GfsMetrics().snapshot();
    expect(s.readLatencyP99Ms).toBe(0);
    expect(s.cacheHitRate).toBe(0);
    expect(s.writerAvailable).toBe(1); // available by default until marked down
  });
});
