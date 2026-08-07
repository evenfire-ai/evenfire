import { describe, it, expect, beforeEach } from "vitest";
import { Metrics } from "../src/metrics";

describe("Metrics", () => {
  let metrics: Metrics;

  beforeEach(() => {
    metrics = new Metrics();
  });

  it("should record request count", () => {
    metrics.recordRequest({ server: "s1", method: "POST", status: 200, durationMs: 50 });
    metrics.recordRequest({ server: "s1", method: "POST", status: 200, durationMs: 30 });
    expect(metrics.getRequestCount("s1", "POST", 200)).toBe(2);
  });

  it("should track per-server counts", () => {
    metrics.recordRequest({ server: "s1", method: "POST", status: 200, durationMs: 50 });
    metrics.recordRequest({ server: "s2", method: "POST", status: 200, durationMs: 30 });
    expect(metrics.getRequestCount("s1", "POST", 200)).toBe(1);
    expect(metrics.getRequestCount("s2", "POST", 200)).toBe(1);
  });

  it("should increment and decrement active connections", () => {
    metrics.incrementActive("s1");
    metrics.incrementActive("s1");
    expect(metrics.getActiveConnections("s1")).toBe(2);
    metrics.decrementActive("s1");
    expect(metrics.getActiveConnections("s1")).toBe(1);
  });

  it("should not go below zero on decrement", () => {
    metrics.decrementActive("s1");
    expect(metrics.getActiveConnections("s1")).toBe(0);
  });

  it("should track total active connections", () => {
    metrics.incrementActive("s1");
    metrics.incrementActive("s2");
    metrics.incrementActive("s2");
    expect(metrics.getTotalActiveConnections()).toBe(3);
  });

  it("should generate prometheus format", () => {
    metrics.recordRequest({ server: "s1", method: "POST", status: 200, durationMs: 50 });
    metrics.setServerHealth("s1", true);
    const output = metrics.toPrometheus();
    expect(output).toContain('mcp_proxy_requests_total{server="s1"');
    expect(output).toContain('mcp_proxy_server_health{server="s1"} 1');
  });

  it("should reset all metrics", () => {
    metrics.recordRequest({ server: "s1", method: "POST", status: 200, durationMs: 50 });
    metrics.incrementActive("s1");
    metrics.reset();
    expect(metrics.getRequestCount("s1", "POST", 200)).toBe(0);
    expect(metrics.getActiveConnections("s1")).toBe(0);
  });
});
