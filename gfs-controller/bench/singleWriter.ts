/**
 * Single-writer write-ceiling benchmark (spec community.md §Single-writer
 * scaling envelope; plan P5-S04). Measures sustained writes/sec + byte
 * throughput of ONE gfsc writer on standard-rwo, including the audit hash-chain
 * commit rate, to establish the write-scaling envelope (the documented trigger
 * for subtree-sharding / failover).
 *
 * The summary computation is pure + unit-tested; the actual load run against a
 * live gfsc writer is driven by scripts/e2e/gfs-single-writer-bench.sh on a
 * branch profile (cluster), which feeds samples in and records the envelope.
 */

export interface BenchSample {
  /** Writes completed in this sample. */
  writes: number
  /** Bytes written in this sample. */
  bytes: number
  /** Wall-clock duration of this sample, ms. */
  durationMs: number
  /** Audit-chain rows committed in this sample. */
  auditCommits: number
}

export interface BenchReport {
  writesPerSec: number
  mibPerSec: number
  auditCommitsPerSec: number
  totalWrites: number
  totalBytes: number
  samples: number
}

const MIB = 1024 * 1024

/** Aggregate samples into the measured write-ceiling envelope. */
export function summarizeBench(samples: BenchSample[]): BenchReport {
  const totalWrites = samples.reduce((a, s) => a + s.writes, 0)
  const totalBytes = samples.reduce((a, s) => a + s.bytes, 0)
  const totalAudit = samples.reduce((a, s) => a + s.auditCommits, 0)
  const totalMs = samples.reduce((a, s) => a + s.durationMs, 0)
  const seconds = totalMs / 1000
  return {
    writesPerSec: seconds > 0 ? totalWrites / seconds : 0,
    mibPerSec: seconds > 0 ? totalBytes / MIB / seconds : 0,
    auditCommitsPerSec: seconds > 0 ? totalAudit / seconds : 0,
    totalWrites,
    totalBytes,
    samples: samples.length,
  }
}

/** Render the envelope as the report the bench script writes out. */
export function renderReport(report: BenchReport): string {
  return [
    "gfs single-writer write-ceiling envelope",
    `  writes/sec:        ${report.writesPerSec.toFixed(1)}`,
    `  throughput MiB/s:  ${report.mibPerSec.toFixed(2)}`,
    `  audit commits/sec: ${report.auditCommitsPerSec.toFixed(1)}`,
    `  total writes:      ${report.totalWrites}`,
    `  samples:           ${report.samples}`,
  ].join("\n")
}
