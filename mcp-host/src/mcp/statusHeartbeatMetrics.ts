import { Counter, Gauge, type Registry, register } from 'prom-client'
import type { McpStatusRefreshSummary } from './manager'

type Outcome = 'completed' | 'failed' | 'skipped' | 'aborted'
type ProbeOutcome = 'succeeded' | 'failed'
type ServerOutcome = 'expected' | 'succeeded' | 'failed'

export interface McpStatusHeartbeatMetricsPort {
  runStarted(): void
  runSkipped(): void
  runFinished(summary: McpStatusRefreshSummary): void
}

function counter<Label extends string>(
  registry: Registry,
  options: { name: string; help: string; labelNames?: Label[] }
): Counter<Label> {
  const existing = registry.getSingleMetric(options.name)
  if (existing) return existing as Counter<Label>
  return new Counter<Label>({ ...options, registers: [registry] })
}

function gauge<Label extends string>(
  registry: Registry,
  options: { name: string; help: string; labelNames?: Label[] }
): Gauge<Label> {
  const existing = registry.getSingleMetric(options.name)
  if (existing) return existing as Gauge<Label>
  return new Gauge<Label>({ ...options, registers: [registry] })
}

export class McpStatusHeartbeatMetrics implements McpStatusHeartbeatMetricsPort {
  private readonly runs: Counter<'outcome'>
  private readonly inFlight: Gauge
  private readonly probes: Counter<'outcome'>
  private readonly servers: Gauge<'outcome'>
  private readonly tools: Gauge
  private readonly outputSchemas: Gauge

  constructor(registry: Registry = register) {
    this.runs = counter(registry, {
      name: 'clerum_mcp_status_heartbeat_runs_total',
      help: 'Completed MCP status-heartbeat rounds by outcome.',
      labelNames: ['outcome'],
    })
    this.inFlight = gauge(registry, {
      name: 'clerum_mcp_status_heartbeat_in_flight',
      help: 'Whether an MCP status-heartbeat round is currently in flight.',
    })
    this.probes = counter(registry, {
      name: 'clerum_mcp_status_heartbeat_probes_total',
      help: 'Individual MCP status probes by outcome.',
      labelNames: ['outcome'],
    })
    this.servers = gauge(registry, {
      name: 'clerum_mcp_status_heartbeat_servers',
      help: 'MCP status-heartbeat server counts by outcome.',
      labelNames: ['outcome'],
    })
    this.tools = gauge(registry, {
      name: 'clerum_mcp_status_heartbeat_tools',
      help: 'Tools observed during the most recent MCP status-heartbeat round.',
    })
    this.outputSchemas = gauge(registry, {
      name: 'clerum_mcp_status_heartbeat_output_schemas',
      help: 'Tool output schemas observed during the most recent MCP status-heartbeat round.',
    })
  }

  runStarted(): void {
    this.inFlight.inc()
  }

  runSkipped(): void {
    this.runs.inc({ outcome: 'skipped' satisfies Outcome })
  }

  runFinished(summary: McpStatusRefreshSummary): void {
    this.inFlight.dec()
    const outcome: Outcome = summary.aborted
      ? 'aborted'
      : summary.failed > 0
        ? 'failed'
        : 'completed'
    this.runs.inc({ outcome })
    this.probes.inc({ outcome: 'succeeded' satisfies ProbeOutcome }, summary.succeeded)
    this.probes.inc({ outcome: 'failed' satisfies ProbeOutcome }, summary.failed)
    this.servers.set({ outcome: 'expected' satisfies ServerOutcome }, summary.serverCount)
    this.servers.set({ outcome: 'succeeded' satisfies ServerOutcome }, summary.succeeded)
    this.servers.set({ outcome: 'failed' satisfies ServerOutcome }, summary.failed)
    this.tools.set(summary.toolCount)
    this.outputSchemas.set(summary.outputSchemaCount)
  }
}

export const mcpStatusHeartbeatMetrics = new McpStatusHeartbeatMetrics()
