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
    forwardingEnabled: false,
    systemTokenFile: "/tmp/fixture-system-token",
    requestBodyLimit: 1048576,
    allowLoopbackTargets: true,
    ...overrides,
  };
}

describe("HccClient", () => {
  let mockServer: http.Server;
  let baseUrl: string;
  let responseBody: unknown;
  let responseStatus: number;
  let responseHeaders: Record<string, string>;
  let compatibilityBody: unknown;
  let compatibilityStatus: number | undefined;
  let requests: Array<{ method: string; path: string; headers: http.IncomingHttpHeaders }>;
  const systemIdentity = ["fixture", "system", "identity"].join("-");

  beforeEach(async () => {
    responseBody = { schemaVersion: 1, servers: [], timestamp: new Date().toISOString() };
    responseStatus = 200;
    responseHeaders = {};
    compatibilityBody = undefined;
    compatibilityStatus = undefined;
    requests = [];

    await new Promise<void>((resolve) => {
      mockServer = http.createServer((req, res) => {
        requests.push({
          method: req.method || "",
          path: req.url || "",
          headers: req.headers,
        });
        const isCompatibilityRequest = req.url === "/api/v1/mcpservers";
        res.writeHead(
          isCompatibilityRequest && compatibilityStatus !== undefined
            ? compatibilityStatus
            : responseStatus,
          { "Content-Type": "application/json", ...responseHeaders }
        );
        const body =
          isCompatibilityRequest && compatibilityBody !== undefined
            ? compatibilityBody
            : req.method === "POST"
            ? {
                schemaVersion: 1,
                serverName: "mongo-mcp",
                targetUrl: "http://mongo.mcp-server.svc.cluster.local:3000/mcp",
                destinationRevision: "revision-1",
              }
            : responseBody;
        res.end(JSON.stringify(body));
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
    responseBody = { schemaVersion: 1, servers: [
      {
        name: "mongo-mcp",
        contextRef: "ctx1",
        transport: { type: "streamableHttp", url: "http://mongo.mcp-server:3000/mcp" },
        enabled: true,
        status: { deployed: true, ready: true },
        destinationRevision: "revision-1",
      },
    ], timestamp: new Date().toISOString() };

    const client = new HccClient(makeConfig({ hccApiUrl: baseUrl }), async () => systemIdentity);
    const servers = await client.fetchServers();

    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe("mongo-mcp");
    expect(servers[0].port).toBe(3000);
    expect(servers[0].managed).toBe(true);
  });

  it.each(["", "A", "a".repeat(254)])(
    "should reject an inventory entry with an invalid Context reference %j",
    async (contextRef) => {
      responseBody = {
        schemaVersion: 1,
        servers: [
          {
            name: "bounded-context-server",
            contextRef,
            transport: { type: "streamableHttp", url: "http://bounded.mcp-server:3000/mcp" },
            enabled: true,
            status: { deployed: true, ready: true },
            destinationRevision: "revision-1",
          },
        ],
        timestamp: new Date().toISOString(),
      };

      const client = new HccClient(makeConfig({ hccApiUrl: baseUrl }), async () => systemIdentity);

      await expect(client.fetchServers()).resolves.toEqual([]);
    }
  );

  it("should reject a system inventory entry with an unapproved description field", async () => {
    responseBody = { schemaVersion: 1, servers: [
      {
        name: "described-mcp",
        contextRef: "ctx1",
        description: ["fixture", "description"].join(" "),
        transport: { type: "streamableHttp", url: "http://described.mcp-server:3000/mcp" },
        enabled: true,
        status: { deployed: true, ready: true },
        destinationRevision: "revision-1",
      },
    ], timestamp: new Date().toISOString() };

    const client = new HccClient(makeConfig({ hccApiUrl: baseUrl }), async () => systemIdentity);

    await expect(client.fetchServers()).resolves.toEqual([]);
  });

  it("should reject an inventory response without schemaVersion", async () => {
    responseBody = {
      servers: [
        {
          name: "schema-missing",
          contextRef: "ctx1",
          transport: { type: "streamableHttp", url: "http://schema-missing.mcp-server:3000/mcp" },
          enabled: true,
          status: { deployed: true, ready: true, authoritative: true },
          destinationRevision: "revision-1",
        },
      ],
      timestamp: new Date().toISOString(),
    };
    const client = new HccClient(makeConfig({ hccApiUrl: baseUrl }), async () => systemIdentity);

    await expect(client.fetchServers()).resolves.toEqual([]);
  });

  it("should reject an inventory response with repeated server names", async () => {
    const server = {
      name: "repeated-server",
      contextRef: "ctx1",
      transport: { type: "streamableHttp", url: "http://repeated.mcp-server:3000/mcp" },
      enabled: true,
      status: { deployed: true, ready: true },
      destinationRevision: "revision-1",
    };
    responseBody = {
      schemaVersion: 1,
      servers: [server, { ...server, contextRef: "ctx2", destinationRevision: "revision-2" }],
      timestamp: new Date().toISOString(),
    };
    const client = new HccClient(makeConfig({ hccApiUrl: baseUrl }), async () => systemIdentity);

    await expect(client.fetchServers()).resolves.toEqual([]);
  });

  it("should use cache when HCC fails", async () => {
    responseBody = { schemaVersion: 1, servers: [
      {
        name: "server-a",
        contextRef: "ctx1",
        transport: { type: "streamableHttp", url: "http://a:3000/mcp" },
        enabled: true,
        status: { deployed: true, ready: true },
        destinationRevision: "revision-1",
      },
    ], timestamp: new Date().toISOString() };

    const client = new HccClient(makeConfig({ hccApiUrl: baseUrl }), async () => systemIdentity);
    await client.fetchServers();

    // Now make HCC fail
    responseStatus = 500;
    const servers = await client.fetchServers();
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe("server-a");
  });

  it("should not use a successful v1 compatibility response when v2 inventory fails", async () => {
    responseStatus = 503;
    compatibilityStatus = 200;
    compatibilityBody = {
      servers: [{ name: "legacy-server", contextRef: "legacy-context", auth: "legacy" }],
      timestamp: new Date().toISOString(),
    };
    const client = new HccClient(makeConfig({ hccApiUrl: baseUrl }), async () => systemIdentity);

    await expect(client.fetchServers()).resolves.toEqual([]);
    expect(requests.map(request => request.path)).toEqual(["/api/v2/system/mcpservers"]);
  });

  it("should not authorize from a successful v1 compatibility response", async () => {
    responseStatus = 503;
    compatibilityStatus = 200;
    compatibilityBody = {
      servers: [{ name: "legacy-server", contextRef: "legacy-context", auth: "legacy" }],
      timestamp: new Date().toISOString(),
    };
    const client = new HccClient(makeConfig({ hccApiUrl: baseUrl }), async () => systemIdentity);

    await expect(client.authorizeForward("legacy-server", "fixture-host-bearer")).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(requests.map(request => request.path)).toEqual([
      "/api/v2/system/mcpservers/authorize",
    ]);
  });

  it("should detect server addition", async () => {
    responseBody = { schemaVersion: 1, servers: [
      { name: "a", contextRef: "c", transport: { type: "streamableHttp", url: "http://a:3000/mcp" }, enabled: true, status: { deployed: true, ready: true }, destinationRevision: "revision-1" },
    ], timestamp: new Date().toISOString() };

    const client = new HccClient(makeConfig({ hccApiUrl: baseUrl }), async () => systemIdentity);
    let servers = await client.fetchServers();
    expect(servers).toHaveLength(1);

    responseBody = { schemaVersion: 1, servers: [
      { name: "a", contextRef: "c", transport: { type: "streamableHttp", url: "http://a:3000/mcp" }, enabled: true, status: { deployed: true, ready: true }, destinationRevision: "revision-1" },
      { name: "b", contextRef: "c", transport: { type: "streamableHttp", url: "http://b:3000/mcp" }, enabled: false, status: { deployed: true, ready: true }, destinationRevision: "revision-2" },
    ], timestamp: new Date().toISOString() };

    servers = await client.fetchServers();
    expect(servers).toHaveLength(2);
  });

  it("should report cache stale when TTL exceeded", async () => {
    const client = new HccClient(
      makeConfig({ hccApiUrl: baseUrl, hccCacheTTL: 1 }),
      async () => systemIdentity
    );

    responseBody = { schemaVersion: 1, servers: [
      { name: "a", contextRef: "c", transport: { type: "streamableHttp", url: "http://a:3000/mcp" }, enabled: true, status: { deployed: true, ready: true }, destinationRevision: "revision-1" },
    ], timestamp: new Date().toISOString() };

    await client.fetchServers();

    // Wait for TTL to expire
    await new Promise((r) => setTimeout(r, 10));
    expect(client.isCacheStale()).toBe(true);
  });

  it("should report cache expired when expiry exceeded", async () => {
    const client = new HccClient(
      makeConfig({ hccApiUrl: baseUrl, hccCacheExpiry: 1 }),
      async () => systemIdentity
    );

    responseBody = { schemaVersion: 1, servers: [
      { name: "a", contextRef: "c", transport: { type: "streamableHttp", url: "http://a:3000/mcp" }, enabled: true, status: { deployed: true, ready: true }, destinationRevision: "revision-1" },
    ], timestamp: new Date().toISOString() };

    await client.fetchServers();

    await new Promise((r) => setTimeout(r, 10));
    expect(client.isCacheExpired()).toBe(true);
  });

  it("should report stale=true when no poll has occurred", () => {
    const client = new HccClient(makeConfig({ hccApiUrl: baseUrl }), async () => systemIdentity);
    expect(client.isCacheStale()).toBe(true);
    expect(client.isCacheExpired()).toBe(true);
  });

  it("should extract port from URL", async () => {
    responseBody = { schemaVersion: 1, servers: [
      { name: "custom-port", contextRef: "c", transport: { type: "streamableHttp", url: "http://x:8080/mcp" }, enabled: true, status: { deployed: true, ready: true }, destinationRevision: "revision-1" },
    ], timestamp: new Date().toISOString() };

    const client = new HccClient(makeConfig({ hccApiUrl: baseUrl }), async () => systemIdentity);
    const servers = await client.fetchServers();
    expect(servers[0].port).toBe(8080);
  });

  it("should handle connection refused gracefully", async () => {
    const client = new HccClient(
      makeConfig({ hccApiUrl: "http://127.0.0.1:1" }),
      async () => systemIdentity
    );
    const servers = await client.fetchServers();
    expect(servers).toEqual([]);
  });

  it("should use v2 authorization and read the system identity for every request", async () => {
    let currentSystemIdentity = ["fixture", "system", "one"].join("-");
    const client = new HccClient(
      makeConfig({ hccApiUrl: baseUrl }),
      async () => currentSystemIdentity
    );

    await client.fetchServers();
    currentSystemIdentity = ["fixture", "system", "two"].join("-");
    const hostBearer = ["fixture", "host", "bearer"].join("-");
    const authorization = await client.authorizeForward("mongo-mcp", hostBearer);

    expect(authorization.serverName).toBe("mongo-mcp");
    expect(requests.map((request) => request.path)).toEqual([
      "/api/v2/system/mcpservers",
      "/api/v2/system/mcpservers/authorize",
    ]);
    expect(requests[0].headers.authorization).toBe("Bearer fixture-system-one");
    expect(requests[1].headers.authorization).toBe("Bearer fixture-system-two");
    expect(requests[1].headers["x-clerum-host-authorization"]).toBe(
      "Bearer fixture-host-bearer"
    );
  });

  it("should never use the cached inventory as authorization fallback", async () => {
    responseBody = {
      schemaVersion: 1,
      servers: [
        {
          name: "mongo-mcp",
          contextRef: "ctx1",
          transport: { type: "streamableHttp", url: "http://mongo.mcp-server:3000/mcp" },
          enabled: true,
          status: { deployed: true, ready: true },
          destinationRevision: "revision-1",
        },
      ],
      timestamp: new Date().toISOString(),
    };
    const client = new HccClient(makeConfig({ hccApiUrl: baseUrl }), async () => systemIdentity);
    await client.fetchServers();

    responseStatus = 503;
    const hostBearer = ["fixture", "host", "bearer"].join("-");
    await expect(client.authorizeForward("mongo-mcp", hostBearer)).rejects.toMatchObject({
      code: "unavailable",
    });
  });

  it.each([
    [400, "bad_request"],
    [401, "unauthorized"],
    [403, "forbidden"],
    [503, "unavailable"],
  ] as const)("maps HCC status %s to an opaque authorization error", async (status, code) => {
    responseStatus = status;
    const client = new HccClient(makeConfig({ hccApiUrl: baseUrl }), async () => systemIdentity);
    const hostBearer = ["fixture", "host", "bearer"].join("-");

    await expect(client.authorizeForward("mongo-mcp", hostBearer)).rejects.toEqual(
      expect.objectContaining({ code })
    );
    expect(requests[0].path).toBe("/api/v2/system/mcpservers/authorize");
  });

  it("maps an HCC system-bearer rejection to unavailable instead of a Host rejection", async () => {
    responseStatus = 401;
    responseHeaders = { "X-Clerum-Mcp-Proxy-Auth-Failure": "system" };
    const client = new HccClient(makeConfig({ hccApiUrl: baseUrl }), async () => systemIdentity);

    await expect(client.authorizeForward("mongo-mcp", "fixture-host-bearer")).rejects.toMatchObject({
      code: "unavailable",
    });
  });
});
