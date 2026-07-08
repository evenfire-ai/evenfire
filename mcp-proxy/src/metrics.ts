export interface RequestMetric {
  server: string;
  method: string;
  status: number;
  durationMs: number;
}

export class Metrics {
  private requestCounts: Map<string, number> = new Map();
  private requestDurations: Map<string, number[]> = new Map();
  private activeConnections: Map<string, number> = new Map();
  private serverHealthStatus: Map<string, boolean> = new Map();

  recordRequest(metric: RequestMetric): void {
    const countKey = `${metric.server}:${metric.method}:${metric.status}`;
    this.requestCounts.set(countKey, (this.requestCounts.get(countKey) || 0) + 1);

    const durations = this.requestDurations.get(metric.server) || [];
    durations.push(metric.durationMs);
    this.requestDurations.set(metric.server, durations);
  }

  incrementActive(server: string): void {
    this.activeConnections.set(server, (this.activeConnections.get(server) || 0) + 1);
  }

  decrementActive(server: string): void {
    const current = this.activeConnections.get(server) || 0;
    this.activeConnections.set(server, Math.max(0, current - 1));
  }

  setServerHealth(server: string, healthy: boolean): void {
    this.serverHealthStatus.set(server, healthy);
  }

  getRequestCount(server: string, method: string, status: number): number {
    return this.requestCounts.get(`${server}:${method}:${status}`) || 0;
  }

  getActiveConnections(server: string): number {
    return this.activeConnections.get(server) || 0;
  }

  getTotalActiveConnections(): number {
    let total = 0;
    for (const count of this.activeConnections.values()) {
      total += count;
    }
    return total;
  }

  toPrometheus(): string {
    const lines: string[] = [];

    lines.push("# HELP mcp_proxy_requests_total Total requests by server, method, status");
    lines.push("# TYPE mcp_proxy_requests_total counter");
    for (const [key, count] of this.requestCounts) {
      const [server, method, status] = key.split(":");
      lines.push(`mcp_proxy_requests_total{server="${server}",method="${method}",status="${status}"} ${count}`);
    }

    lines.push("# HELP mcp_proxy_active_connections Active connections by server");
    lines.push("# TYPE mcp_proxy_active_connections gauge");
    for (const [server, count] of this.activeConnections) {
      lines.push(`mcp_proxy_active_connections{server="${server}"} ${count}`);
    }

    lines.push("# HELP mcp_proxy_server_health Server health status (1=healthy, 0=unhealthy)");
    lines.push("# TYPE mcp_proxy_server_health gauge");
    for (const [server, healthy] of this.serverHealthStatus) {
      lines.push(`mcp_proxy_server_health{server="${server}"} ${healthy ? 1 : 0}`);
    }

    return lines.join("\n") + "\n";
  }

  reset(): void {
    this.requestCounts.clear();
    this.requestDurations.clear();
    this.activeConnections.clear();
    this.serverHealthStatus.clear();
  }
}
