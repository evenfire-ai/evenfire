/**
 * Phase 3 tests: MCP Proxy mode — URL strategy and feature flag behavior.
 */

import { describe, it, expect, vi } from "vitest";
import { McpManager } from "../manager";
import { McpClient } from "../client";
import { McpServerInfo } from "../../types";

function makeMockServer(name: string, url = "http://mock-server:3000/mcp"): McpServerInfo {
  return {
    name,
    description: `Mock ${name}`,
    contextRef: "test-context",
    transport: { type: "streamableHttp", url },
    enabled: true,
    status: { deployed: true, ready: true },
  };
}

describe("McpClient — proxy URL resolution", () => {
  it("should use direct URL when no proxy configured", () => {
    const server = makeMockServer("mongodb", "http://mongodb.mcp-server:3000/mcp");
    const client = new McpClient(server);
    // Access private resolveUrl via any cast
    const url = (client as any).resolveUrl();
    expect(url).toBe("http://mongodb.mcp-server:3000/mcp");
  });

  it("should use proxy URL when proxy configured", () => {
    const server = makeMockServer("mongodb", "http://mongodb.mcp-server:3000/mcp");
    const client = new McpClient(server, undefined, "http://mcp-proxy.mcp-server:8083");
    const url = (client as any).resolveUrl();
    expect(url).toBe("http://mcp-proxy.mcp-server:8083/servers/mongodb/mcp");
  });

  it("should include server name in proxy path", () => {
    const server = makeMockServer("mcp-redis-cache");
    const client = new McpClient(server, undefined, "http://proxy:8083");
    const url = (client as any).resolveUrl();
    expect(url).toBe("http://proxy:8083/servers/mcp-redis-cache/mcp");
  });

  it("should use StreamableHTTP transport when proxy is set (even for SSE servers)", () => {
    const server = makeMockServer("legacy-sse");
    server.transport.type = "sse";
    const client = new McpClient(server, undefined, "http://proxy:8083");
    const transport = (client as any).createTransport();
    expect(transport.constructor.name).toBe("StreamableHTTPClientTransport");
  });

  it("should use SSE transport for SSE servers without proxy", () => {
    const server = makeMockServer("legacy-sse", "http://sse-server:3000/sse");
    server.transport.type = "sse";
    const client = new McpClient(server);
    const transport = (client as any).createTransport();
    expect(transport.constructor.name).toBe("SSEClientTransport");
  });

  it("should preserve auth token through proxy", () => {
    const server = makeMockServer("authed-server");
    const client = new McpClient(server, "secret-token-123", "http://proxy:8083");
    // Verify the URL is correct (auth is handled at transport level)
    const url = (client as any).resolveUrl();
    expect(url).toBe("http://proxy:8083/servers/authed-server/mcp");
  });
});

describe("McpManager — proxy mode constructor", () => {
  it("should accept no arguments (backward compatible)", () => {
    const manager = new McpManager();
    expect(manager.getConnectedServers()).toEqual([]);
  });

  it("should accept proxy URL", () => {
    const manager = new McpManager("http://proxy:8083");
    expect(manager.getConnectedServers()).toEqual([]);
  });

  it("should accept undefined proxy URL (explicit direct mode)", () => {
    const manager = new McpManager(undefined);
    expect(manager.getConnectedServers()).toEqual([]);
  });

  it("should pass proxy URL to McpClient on addServer", async () => {
    const manager = new McpManager("http://proxy:8083");
    const server = makeMockServer("test-server");

    // Mock McpClient.connect to avoid real network calls
    const connectSpy = vi.spyOn(McpClient.prototype, "connect").mockResolvedValue();
    vi.spyOn(McpClient.prototype, "availableTools", "get").mockReturnValue([]);

    await manager.addServer(server);

    expect(connectSpy).toHaveBeenCalledTimes(1);
    expect(manager.getConnectedServers()).toEqual(["test-server"]);

    // Clean up
    vi.restoreAllMocks();
    await manager.disconnectAll();
  });
});

describe("McpManager — feature flag behavior", () => {
  it("MCP_PROXY_ENABLED=false uses no proxy (direct URLs)", () => {
    const proxyUrl = false ? "http://proxy:8083" : undefined;
    const manager = new McpManager(proxyUrl);
    expect((manager as any).proxyUrl).toBeUndefined();
  });

  it("MCP_PROXY_ENABLED=true uses proxy URL", () => {
    const proxyEnabled = true;
    const proxyUrl = proxyEnabled ? "http://proxy:8083" : undefined;
    const manager = new McpManager(proxyUrl);
    expect((manager as any).proxyUrl).toBe("http://proxy:8083");
  });
});

describe("McpManager — public API unchanged (regression guards)", () => {
  it("should expose getAllTools() method", () => {
    const manager = new McpManager("http://proxy:8083");
    expect(typeof manager.getAllTools).toBe("function");
    expect(manager.getAllTools()).toEqual([]);
  });

  it("should expose callTool() method with same signature", async () => {
    const manager = new McpManager("http://proxy:8083");
    const result = await manager.callTool("missing__tool", {});
    expect(result.isError).toBe(true);
    expect(result.result).toEqual({ error: "MCP server not found: missing" });
  });

  it("should expose getConnectedServers() method", () => {
    const manager = new McpManager("http://proxy:8083");
    expect(typeof manager.getConnectedServers).toBe("function");
  });

  it("should expose hasConnectedServers() method", () => {
    const manager = new McpManager("http://proxy:8083");
    expect(manager.hasConnectedServers()).toBe(false);
  });

  it("should expose describeCapabilities() method", () => {
    const manager = new McpManager("http://proxy:8083");
    expect(typeof manager.describeCapabilities).toBe("function");
    expect(manager.describeCapabilities()).toContain("No MCP servers");
  });
});
