import { describe, expect, it } from 'vitest'
import { Registry } from 'prom-client'
import { McpStatusHeartbeatMetrics } from '../../mcp/statusHeartbeatMetrics'

describe('MCP status heartbeat metrics', () => {
  it('preinitializes every outcome series and records a completed aggregate round', async () => {
    const registry = new Registry()
    const metrics = new McpStatusHeartbeatMetrics(registry)

    const initialScrape = await registry.metrics()
    expect(initialScrape).toContain('clerum_mcp_status_heartbeat_runs_total{outcome="completed"} 0')
    expect(initialScrape).toContain('clerum_mcp_status_heartbeat_runs_total{outcome="failed"} 0')
    expect(initialScrape).toContain('clerum_mcp_status_heartbeat_runs_total{outcome="skipped"} 0')
    expect(initialScrape).toContain('clerum_mcp_status_heartbeat_runs_total{outcome="aborted"} 0')
    expect(initialScrape).toContain('clerum_mcp_status_heartbeat_probes_total{outcome="failed"} 0')

    metrics.runStarted()
    metrics.runFinished({
      serverCount: 2,
      succeeded: 2,
      failed: 0,
      toolCount: 3,
      outputSchemaCount: 2,
      aborted: false,
    })

    const scrape = await registry.metrics()
    expect(scrape).toContain('clerum_mcp_status_heartbeat_runs_total{outcome="completed"} 1')
    expect(scrape).toContain('clerum_mcp_status_heartbeat_probes_total{outcome="failed"} 0')
    expect(scrape).toContain('clerum_mcp_status_heartbeat_in_flight 0')
    expect(scrape).toContain('clerum_mcp_status_heartbeat_probes_total{outcome="succeeded"} 2')
    expect(scrape).toContain('clerum_mcp_status_heartbeat_servers{outcome="expected"} 2')
    expect(scrape).toContain('clerum_mcp_status_heartbeat_tools 3')
    expect(scrape).toContain('clerum_mcp_status_heartbeat_output_schemas 2')
  })

  it('does not reset the latest gauges when a registry-backed port is recreated', async () => {
    const registry = new Registry()
    const first = new McpStatusHeartbeatMetrics(registry)
    first.runStarted()
    first.runFinished({
      serverCount: 3,
      succeeded: 3,
      failed: 0,
      toolCount: 66,
      outputSchemaCount: 60,
      aborted: false,
    })

    new McpStatusHeartbeatMetrics(registry)

    const scrape = await registry.metrics()
    expect(scrape).toContain('clerum_mcp_status_heartbeat_servers{outcome="expected"} 3')
    expect(scrape).toContain('clerum_mcp_status_heartbeat_tools 66')
    expect(scrape).toContain('clerum_mcp_status_heartbeat_output_schemas 60')
  })

  it('records a thrown round as failed and an aborted throw as aborted', async () => {
    const registry = new Registry()
    const metrics = new McpStatusHeartbeatMetrics(registry)

    metrics.runStarted()
    metrics.runErrored(false)
    metrics.runStarted()
    metrics.runErrored(true)

    const scrape = await registry.metrics()
    expect(scrape).toContain('clerum_mcp_status_heartbeat_runs_total{outcome="failed"} 1')
    expect(scrape).toContain('clerum_mcp_status_heartbeat_runs_total{outcome="aborted"} 1')
    // A thrown round must never be counted as a clean completion.
    expect(scrape).toContain('clerum_mcp_status_heartbeat_runs_total{outcome="completed"} 0')
    expect(scrape).toContain('clerum_mcp_status_heartbeat_in_flight 0')
  })
})
