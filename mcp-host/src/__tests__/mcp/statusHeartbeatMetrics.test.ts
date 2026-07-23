import { describe, expect, it } from 'vitest'
import { Registry } from 'prom-client'
import { McpStatusHeartbeatMetrics } from '../../mcp/statusHeartbeatMetrics'

describe('MCP status heartbeat metrics', () => {
  it('registers all heartbeat metrics and records a completed aggregate round', async () => {
    const registry = new Registry()
    const metrics = new McpStatusHeartbeatMetrics(registry)
    metrics.runStarted()
    metrics.runFinished({
      serverCount: 2,
      succeeded: 1,
      failed: 1,
      toolCount: 3,
      outputSchemaCount: 2,
      aborted: false,
    })

    const scrape = await registry.metrics()
    expect(scrape).toContain('clerum_mcp_status_heartbeat_runs_total{outcome="failed"} 1')
    expect(scrape).toContain('clerum_mcp_status_heartbeat_in_flight 0')
    expect(scrape).toContain('clerum_mcp_status_heartbeat_probes_total{outcome="succeeded"} 1')
    expect(scrape).toContain('clerum_mcp_status_heartbeat_servers{outcome="expected"} 2')
    expect(scrape).toContain('clerum_mcp_status_heartbeat_tools 3')
    expect(scrape).toContain('clerum_mcp_status_heartbeat_output_schemas 2')
  })
})
