import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import { HccClient } from "../src/hccClient";
import { ProxyConfig } from "../src/types";

function makeConfig(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    port: 8083,
    hccApiUrl: "",
    hccPollInterval: 30000,
    hccCacheTTL: 120000,
    hccCacheExpiry: 300000,
    requestTimeout: 30000,
    maxResponseSize: 10485760,
    devMode: false,
    devServers: [],
    logLevel: "info",
    ...overrides,
  };
}

describe("HccClient", () => {
  let mockServer: http.Server;
  let baseUrl: string;
  let responseBody: unknown;
  let responseStatus: number;

  beforeEach(async () => {
    responseBody = { servers: [], contextRef: "*", timestamp: new Date().toISOString() };
    responseStatus = 200;

    await new Promise<void>((resolve) => {
      mockServer = http.createServer((_, res) => {
        res.writeHead(responseStatus, { "Content-Type": "application/json" });
        res.end(JSON.stringify(responseBody));
      });
      mockServer.listen(0, () => {
        const addr = mockServer.address();
        if (addr && typeof addr !== "string") {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
  });

  it("should fetch servers from HCC API", async () => {
    responseBody = { servers: [
      {
        name: "mongo-mcp",
        contextRef: "ctx1",
        transport: { type: "streamableHttp", url: "http://mongo.mcp-server:3000/mcp" },
        enabled: true,
        status: { deployed: true, ready: true },
      },
    ], contextRef: "*", timestamp: new Date().toISOString() };

    const client = new HccClient(makeConfig({ hccApiUrl: baseUrl }));
    const servers = await client.fetchServers();

    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe("mongo-mcp");
    expect(servers[0].port).toBe(3000);
    expect(servers[0].managed).toBe(true);
  });

  it("should use cache when HCC fails", async () => {
    responseBody = { servers: [
      {
        name: "server-a",
        contextRef: "ctx1",
        transport: { type: "streamableHttp", url: "http://a:3000/mcp" },
        enabled: true,
        status: { deployed: true, ready: true },
      },
    ], contextRef: "*", timestamp: new Date().toISOString() };

    const client = new HccClient(makeConfig({ hccApiUrl: baseUrl }));
    await client.fetchServers();

    // Now make HCC fail
    responseStatus = 500;
    const servers = await client.fetchServers();
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe("server-a");
  });

  it("should detect server addition", async () => {
    responseBody = { servers: [
      { name: "a", contextRef: "c", transport: { type: "streamableHttp", url: "http://a:3000/mcp" }, enabled: true, status: { deployed: true, ready: true } },
    ], contextRef: "*", timestamp: new Date().toISOString() };

    const client = new HccClient(makeConfig({ hccApiUrl: baseUrl }));
    let servers = await client.fetchServers();
    expect(servers).toHaveLength(1);

    responseBody = { servers: [
      { name: "a", contextRef: "c", transport: { type: "streamableHttp", url: "http://a:3000/mcp" }, enabled: true, status: { deployed: true, ready: true } },
      { name: "b", contextRef: "c", transport: { type: "streamableHttp", url: "http://b:3000/mcp" }, enabled: false, status: { deployed: true, ready: true } },
    ], contextRef: "*", timestamp: new Date().toISOString() };

    servers = await client.fetchServers();
    expect(servers).toHaveLength(2);
  });

  it("should report cache stale when TTL exceeded", async () => {
    const client = new HccClient(makeConfig({ hccApiUrl: baseUrl, hccCacheTTL: 1 }));

    responseBody = { servers: [
      { name: "a", contextRef: "c", transport: { type: "streamableHttp", url: "http://a:3000/mcp" }, enabled: true, status: { deployed: true, ready: true } },
    ], contextRef: "*", timestamp: new Date().toISOString() };

    await client.fetchServers();

    // Wait for TTL to expire
    await new Promise((r) => setTimeout(r, 10));
    expect(client.isCacheStale()).toBe(true);
  });

  it("should report cache expired when expiry exceeded", async () => {
    const client = new HccClient(makeConfig({ hccApiUrl: baseUrl, hccCacheExpiry: 1 }));

    responseBody = { servers: [
      { name: "a", contextRef: "c", transport: { type: "streamableHttp", url: "http://a:3000/mcp" }, enabled: true, status: { deployed: true, ready: true } },
    ], contextRef: "*", timestamp: new Date().toISOString() };

    await client.fetchServers();

    await new Promise((r) => setTimeout(r, 10));
    expect(client.isCacheExpired()).toBe(true);
  });

  it("should report stale=true when no poll has occurred", () => {
    const client = new HccClient(makeConfig({ hccApiUrl: baseUrl }));
    expect(client.isCacheStale()).toBe(true);
    expect(client.isCacheExpired()).toBe(true);
  });

  it("should extract port from URL", async () => {
    responseBody = { servers: [
      { name: "custom-port", contextRef: "c", transport: { type: "streamableHttp", url: "http://x:8080/mcp" }, enabled: true, status: { deployed: true, ready: true } },
    ], contextRef: "*", timestamp: new Date().toISOString() };

    const client = new HccClient(makeConfig({ hccApiUrl: baseUrl }));
    const servers = await client.fetchServers();
    expect(servers[0].port).toBe(8080);
  });

  it("should handle connection refused gracefully", async () => {
    const client = new HccClient(makeConfig({ hccApiUrl: "http://127.0.0.1:1" }));
    const servers = await client.fetchServers();
    expect(servers).toEqual([]);
  });
});
