import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { Router } from "../src/router";
import { HttpForwarder } from "../src/httpForwarder";
import { Metrics } from "../src/metrics";
import { Health } from "../src/health";
import { HccClient } from "../src/hccClient";
import { ProxyServer } from "../src/server";
import { ProxyConfig, ServerRoute } from "../src/types";

function makeConfig(port: number): ProxyConfig {
  return {
    port,
    hccApiUrl: "http://localhost:9999",
    hccPollInterval: 30000,
    hccCacheTTL: 120000,
    hccCacheExpiry: 300000,
    requestTimeout: 5000,
    maxResponseSize: 10485760,
    devMode: true,
    devServers: [],
    logLevel: "info",
    forwardingEnabled: false,
    systemTokenFile: "/tmp/fixture-system-token",
    requestBodyLimit: 1048576,
    allowLoopbackTargets: true,
  };
}

function makeRoute(name: string, ready = true): ServerRoute {
  return { name, url: "", contextRef: "ctx1", managed: true, ready, port: 3000 };
}

function httpRequest(port: number, path: string, method = "GET"): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path, method }, (res) => {
      let body = "";
      res.on("data", (c: Buffer) => (body += c.toString()));
      res.on("end", () => resolve({ status: res.statusCode || 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("ProxyServer", () => {
  let server: ProxyServer;
  let router: Router;
  let hccClient: HccClient;
  let actualPort: number;

  beforeEach(async () => {
    // Use port 0 for OS-assigned port to avoid conflicts
    const config = makeConfig(0);
    router = new Router();
    hccClient = new HccClient(config);
    const forwarder = new HttpForwarder({
      requestTimeout: 5000,
      maxResponseSize: 10485760,
      maxBufferSize: 65536,
      allowLoopbackTargets: true,
    });
    const metrics = new Metrics();
    const health = new Health(router, hccClient);
    server = new ProxyServer(router, forwarder, metrics, health, config);
    await server.start();
    actualPort = server.getPort();
  });

  afterEach(async () => {
    await server.stop();
  });

  it("should respond 200 on /health", async () => {
    const res = await httpRequest(actualPort, "/health");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).status).toBe("ok");
  });

  it("should respond 503 on /ready when cache expired", async () => {
    const res = await httpRequest(actualPort, "/ready");
    expect(res.status).toBe(503);
  });

  it("should respond 200 on /ready when servers available and cache fresh", async () => {
    // Simulate a successful poll
    (hccClient as any).lastSuccessfulPoll = Date.now();
    router.update([makeRoute("server-a")]);
    const res = await httpRequest(actualPort, "/ready");
    expect(res.status).toBe(200);
  });

  it("should respond 200 on /metrics", async () => {
    const res = await httpRequest(actualPort, "/metrics");
    expect(res.status).toBe(200);
    expect(res.body).toContain("mcp_proxy");
  });

  it("should respond 404 for unknown paths", async () => {
    const res = await httpRequest(actualPort, "/unknown");
    expect(res.status).toBe(404);
  });

  it("should not enumerate a server when forwarding is disabled", async () => {
    const res = await httpRequest(actualPort, "/servers/nonexistent/mcp", "POST");
    expect(res.status).toBe(503);
    expect(res.body).not.toContain("nonexistent");
  });

  it("should respond 503 for unready server", async () => {
    router.update([makeRoute("server-a", false)]);
    const res = await httpRequest(actualPort, "/servers/server-a/mcp", "POST");
    expect(res.status).toBe(503);
  });
});
