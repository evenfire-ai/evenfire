/**
 * E2E: Tool Discovery — verify mcp-host discovers MCP tools via context-mapper.
 *
 * Uses mcp-host's authenticated runtime status and startup logs to confirm MCP
 * tools are registered and used during message processing. It deliberately
 * does not call an HCC route with a caller-selected Context.
 */
import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  getPodLogs,
  getStatus,
  getTaskResult,
  sendMessage,
  waitForIdle,
  waitForTasksProcessed,
} from '../helpers.js'

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
    const correlationId = `tool-discovery-${randomUUID()}`
    const before = await getStatus()
    const tasksProcessedBefore = before.agent?.tasksProcessed
    expect(tasksProcessedBefore).toEqual(expect.any(Number))

    const accepted = await sendMessage(`tool discovery test ${correlationId}`, {
      async: true,
      messageId: correlationId,
      requestId: correlationId,
    })
    expect(accepted.status).toBe(200)
    expect(accepted.data).toMatchObject({ success: true, status: 'pending' })
    expect(accepted.data.taskId).toEqual(expect.any(String))

    const completedCount = await waitForTasksProcessed(tasksProcessedBefore + 1, 60_000)
    expect(completedCount.agent.tasksProcessed).toBeGreaterThanOrEqual(tasksProcessedBefore + 1)

    const idle = await waitForIdle(30_000)
    expect(idle.agent.state).toBe('idle')

    const taskId = accepted.data.taskId as string
    const result = await getTaskResult(taskId, 10_000)
    expect(result.status).toBe(200)
    expect(result.data.success).toBe(true)
    expect(result.data.status).toBe('completed')

    const logs = getPodLogs('mcp-host', 'mcp-host', 500)
    expect(logs).toContain(`[Main]   Message ID: ${correlationId}`)
    expect(logs).toContain(`[Main] Message queued as async task ${taskId}`)
    expect(logs).toContain(`[Queue] Task ${taskId} dequeued for processing`)
  })
})
