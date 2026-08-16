/**
 * E2E: Tool Discovery — verify mcp-host discovers MCP tools via context-mapper.
 *
 * Uses mcp-host's authenticated runtime status and startup logs to confirm MCP
 * tools are registered and used during message processing. It deliberately
 * does not call an HCC route with a caller-selected Context.
 */
import { describe, expect, it } from 'vitest'
import { getPodLogs, getStatus, sendMessage, waitForIdle } from '../helpers.js'

describe('Tool Discovery', () => {
  it('mcp-host publishes only its effective connected mock-server fleet', async () => {
    const status = await getStatus()
    const mock = status.mcpServers?.find((server: any) => server.name === 'mock-server')

    expect(mock).toBeDefined()
    expect(mock.state).toBe('connected')
    expect(mock.toolCount).toBe(2)
  })

  it('mcp-host connected to mock-server and found tools', async () => {
    // These log lines are emitted by MCP connection logic (shared by both pipelines)
    const logs = getPodLogs('mcp-host', 'mcp-host', 500)
    expect(logs).toContain('[MCP:mock-server] Connected successfully')
    expect(logs).toContain('[MCP:mock-server] Found 2 tool(s):')
    expect(logs).toContain('echo: Echoes back the provided text')
    expect(logs).toContain('add: Adds two numbers together')
  })

  it("mcp-host reports total tools available (at least mock-server's 2)", async () => {
    const logs = getPodLogs('mcp-host', 'mcp-host', 500)
    // Cluster may have additional MCP servers beyond mock-server;
    // verify the log line exists and reports >= 2 tools
    const match = logs.match(/\[Main\] Total tools available: (\d+)/)
    expect(match).not.toBeNull()
    expect(Number(match![1])).toBeGreaterThanOrEqual(2)
  })

  it('mcp-host processes messages via single pipeline', async () => {
    await sendMessage('tool discovery test')
    await waitForIdle(30_000)

    const logs = getPodLogs('mcp-host', 'mcp-host', 200)
    // Single pipeline — verify the task was processed
    expect(logs).toContain('[Agent] Processing task')
  })
})
