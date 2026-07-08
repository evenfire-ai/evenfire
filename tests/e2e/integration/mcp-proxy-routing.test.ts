/**
 * Integration: MCP Proxy routing
 *
 * Validates centralized HTTP routing through mcp-proxy to MCP servers.
 * Requires: minikube cluster with mcp-proxy exposed (via port-forward or ingress).
 *
 * Note: MCP_PROXY_ENABLED=true must be set on mcp-host for proxy routing.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { MCP_PROXY_URL, isServiceUp, fetchJson, postJson, bearer } from "./helpers.integration.js";

let proxyUp = false;

beforeAll(async () => {
  proxyUp = await isServiceUp(MCP_PROXY_URL);
  if (!proxyUp) {
    console.log("[mcp-proxy-routing] mcp-proxy not available — tests will be skipped");
  }
});

describe("MCP Proxy — health", () => {
  it("returns 200 on /health", async () => {
    if (!proxyUp) return;

    const { status } = await fetchJson(`${MCP_PROXY_URL}/health`);
    expect(status).toBe(200);
  });
});

describe("MCP Proxy — server list", () => {
  it("GET /servers returns 401 without auth token", async () => {
    if (!proxyUp) return;

    const { status } = await fetchJson(`${MCP_PROXY_URL}/servers`);
    expect([401, 403]).toContain(status);
  });

  it("GET /servers with valid token returns array (may be empty)", async () => {
    const testToken = process.env.TEST_MCP_PROXY_TOKEN;
    if (!proxyUp || !testToken) return;

    const { status, data } = await fetchJson<unknown[]>(
      `${MCP_PROXY_URL}/servers`,
      { headers: bearer(testToken) }
    );
    expect(status).toBe(200);
    expect(Array.isArray(data)).toBe(true);
  });
});

describe("MCP Proxy — server routing", () => {
  it("POST to non-existent server returns 404", async () => {
    if (!proxyUp) return;

    const testToken = process.env.TEST_MCP_PROXY_TOKEN;
    if (!testToken) return;

    const { status } = await postJson(
      `${MCP_PROXY_URL}/servers/non-existent-server/mcp`,
      { jsonrpc: "2.0", id: "1", method: "tools/list" },
      bearer(testToken)
    );
    expect([404, 503]).toContain(status);
  });
});
