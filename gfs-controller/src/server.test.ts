import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import { GfsServer, ReadinessDeps, ServingPlane } from "./server";
import type { GfsConfig } from "./config";

const baseConfig: GfsConfig = {
  port: 0,
  storageMountPath: "/drive",
  storageRole: "writer",
  pgConnectionString: "",
  tokenAudience: "gfs-controller",
  publicKey: "",
  driveName: "main",
  decisionCacheTtlMs: 5000,
  devMode: true,
};

interface Response {
  status: number;
  body: Record<string, unknown> | null;
}

function get(port: number, path: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        resolve({
          status: res.statusCode || 0,
          body: data ? (JSON.parse(data) as Record<string, unknown>) : null,
        });
      });
    });
    req.on("error", reject);
  });
}

function getRaw(port: number, path: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode || 0, text: data }));
    });
    req.on("error", reject);
  });
}

const ready: ReadinessDeps = {
  isStorageMounted: async () => true,
  pingPermissionStore: async () => {},
};

let server: GfsServer | null = null;

afterEach(async () => {
  if (server) {
    await server.stop();
    server = null;
  }
});

async function startWith(readiness: ReadinessDeps): Promise<number> {
  server = new GfsServer(baseConfig, readiness);
  return server.start();
}

async function startWithServing(serving: ServingPlane): Promise<number> {
  server = new GfsServer(baseConfig, ready, serving);
  return server.start();
}

describe("gfsc server probes", () => {
  it("GET /healthz returns 200", async () => {
    const port = await startWith(ready);
    const res = await get(port, "/healthz");
    expect(res.status).toBe(200);
    expect(res.body?.status).toBe("ok");
  });

  it("GET /metrics returns 200 Prometheus SLI text", async () => {
    const port = await startWith(ready);
    const res = await getRaw(port, "/metrics");
    expect(res.status).toBe(200);
    expect(res.text).toContain("gfs_writer_available");
    expect(res.text).toContain("gfs_read_latency_p99_ms");
  });

  it("GET /readyz returns 200 when the volume is mounted AND the store is reachable", async () => {
    const port = await startWith(ready);
    const res = await get(port, "/readyz");
    expect(res.status).toBe(200);
    expect(res.body?.status).toBe("ready");
  });

  it("GET /readyz returns 503 (not_mounted) when the volume is NOT mounted — fail-closed", async () => {
    const port = await startWith({
      isStorageMounted: async () => false,
      pingPermissionStore: async () => {},
    });
    const res = await get(port, "/readyz");
    expect(res.status).toBe(503);
    expect(res.body?.code).toBe("not_mounted");
  });

  it("GET /readyz returns 503 when the permission store is unreachable — fail-closed", async () => {
    const port = await startWith({
      isStorageMounted: async () => true,
      pingPermissionStore: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const res = await get(port, "/readyz");
    expect(res.status).toBe(503);
    expect(String(res.body?.reason)).toContain("permission store unreachable");
  });

  it("GET /readyz surfaces a storage-check error as 503 — fail-closed (never a silent pass)", async () => {
    const port = await startWith({
      isStorageMounted: async () => {
        throw new Error("EACCES");
      },
      pingPermissionStore: async () => {},
    });
    const res = await get(port, "/readyz");
    expect(res.status).toBe(503);
    expect(res.body?.code).toBe("not_mounted");
  });

  it("unknown route returns the 404 error envelope", async () => {
    const port = await startWith(ready);
    const res = await get(port, "/nope");
    expect(res.status).toBe(404);
    expect(res.body?.ok).toBe(false);
  });
});

describe("gfsc server — read serving plane delegation", () => {
  it("delegates a route the serving plane OWNS (its response is used, not a 404)", async () => {
    const serving: ServingPlane = {
      async tryHandle(req, res) {
        if (!(req.url || "").startsWith("/v1/resources/")) return false;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, data: { served: true } }));
        return true;
      },
    };
    const port = await startWithServing(serving);
    const res = await get(port, "/v1/resources/abc");
    expect(res.status).toBe(200);
    expect((res.body?.data as { served: boolean }).served).toBe(true);
  });

  it("falls through to 404 for a path the serving plane does NOT own", async () => {
    const serving: ServingPlane = {
      async tryHandle() {
        return false; // owns nothing
      },
    };
    const port = await startWithServing(serving);
    const res = await get(port, "/v1/resources/abc");
    expect(res.status).toBe(404);
    expect(res.body?.ok).toBe(false);
  });

  it("never reaches the serving plane for a probe route (/healthz handled first)", async () => {
    let delegated = false;
    const serving: ServingPlane = {
      async tryHandle() {
        delegated = true;
        return true;
      },
    };
    const port = await startWithServing(serving);
    const res = await get(port, "/healthz");
    expect(res.status).toBe(200);
    expect(delegated).toBe(false); // probes short-circuit before delegation
  });
});
