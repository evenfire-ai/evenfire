import { describe, expect, it } from "vitest";
import { renderReport, summarizeBench } from "../bench/singleWriter.js";

/**
 * P5-S04 — single-writer benchmark summary. The cluster load run feeds samples;
 * here we verify the envelope math (writes/sec, MiB/s, audit commits/sec).
 */

describe("summarizeBench", () => {
  it("computes the write-ceiling envelope from samples", () => {
    const report = summarizeBench([
      { writes: 1000, bytes: 10 * 1024 * 1024, durationMs: 1000, auditCommits: 1000 },
      { writes: 1000, bytes: 10 * 1024 * 1024, durationMs: 1000, auditCommits: 1000 },
    ]);
    expect(report.writesPerSec).toBe(1000); // 2000 writes / 2 s
    expect(report.mibPerSec).toBe(10); // 20 MiB / 2 s
    expect(report.auditCommitsPerSec).toBe(1000);
    expect(report.totalWrites).toBe(2000);
    expect(report.samples).toBe(2);
  });

  it("is zero (no division by zero) with no samples", () => {
    const report = summarizeBench([]);
    expect(report.writesPerSec).toBe(0);
    expect(report.mibPerSec).toBe(0);
  });

  it("renders a human report with the envelope numbers", () => {
    const text = renderReport(summarizeBench([{ writes: 500, bytes: 1024 * 1024, durationMs: 1000, auditCommits: 500 }]));
    expect(text).toContain("writes/sec:");
    expect(text).toContain("throughput MiB/s:");
    expect(text).toContain("audit commits/sec:");
  });
});
