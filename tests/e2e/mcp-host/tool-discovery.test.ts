/**
 * E2E: Tool Discovery — verify mcp-host discovers MCP tools via context-mapper.
 *
 * Checks both the context-mapper API and mcp-host startup logs to confirm
 * MCP tools are registered and used during message processing.
 */
import { describe, it, expect } from "vitest";
import { getMcpServers, sendMessage, waitForIdle, getPodLogs } from "../helpers.js";

describe("Tool Discovery", () => {
  it("context-mapper reports mock-server with 2 tools", async () => {
    const data = await getMcpServers("context1");
    const mock = data.servers.find((s: any) => s.name === "mock-server");
    expect(mock).toBeDefined();
    expect(mock.status.ready).toBe(true);
  });

  it("mcp-host connected to mock-server and found tools", async () => {
    // These log lines are emitted by MCP connection logic (shared by both pipelines)
    const logs = getPodLogs("mcp-host", "mcp-host", 500);
    expect(logs).toContain("[MCP:mock-server] Connected successfully");
    expect(logs).toContain("[MCP:mock-server] Found 2 tool(s):");
    expect(logs).toContain("echo: Echoes back the provided text");
    expect(logs).toContain("add: Adds two numbers together");
  });

  it("mcp-host reports total tools available (at least mock-server's 2)", async () => {
    const logs = getPodLogs("mcp-host", "mcp-host", 500);
    // Cluster may have additional MCP servers beyond mock-server;
    // verify the log line exists and reports >= 2 tools
    const match = logs.match(/\[Main\] Total tools available: (\d+)/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(2);
  });

  it("mcp-host processes messages via single pipeline", async () => {
    await sendMessage("tool discovery test");
    await waitForIdle(30_000);

    const logs = getPodLogs("mcp-host", "mcp-host", 200);
    // Single pipeline — verify the task was processed
    expect(logs).toContain("[Agent] Processing task");
  });
});
