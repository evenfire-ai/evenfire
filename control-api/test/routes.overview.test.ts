import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createAdminHostsOverviewRouter } from "../src/routes/admin/hostsOverview.js";
import { MockGateway } from "./mockGateway.js";

describe("routes/admin.hostsOverview", () => {
  it("returns hosts overview list and single host overview", async () => {
    const gateway = new MockGateway("mcp-server");
    await gateway.createResource(
      "hosts",
      { metadata: { name: "host-a", namespace: "mcp-host" }, spec: { contextRef: "ctx-a" } },
      "mcp-host"
    );
    await gateway.createResource(
      "contexts",
      { metadata: { name: "ctx-a", namespace: "mcp-server" }, spec: { contextId: "ctx-a", mcpServers: [] } },
      "mcp-server"
    );

    const app = express();
    app.use(createAdminHostsOverviewRouter(gateway as never));

    // Hardened: no ?namespace= on requests; route uses config.hostsNamespace internally.
    const listRes = await request(app).get("/admin/hosts-overview").expect(200);
    expect(listRes.body.items).toHaveLength(1);
    expect(listRes.body.items[0].host.spec.contextRef).toBe("ctx-a");

    const singleRes = await request(app).get("/admin/hosts/host-a/overview").expect(200);
    expect(singleRes.body.host.metadata.name).toBe("host-a");
  });

  it("returns 500 when host overview fails", async () => {
    const gateway = {
      listResource: vi.fn(async () => [{ metadata: { name: "host-a", namespace: "mcp-host" } }]),
      getHostOverview: vi.fn(async () => {
        throw new Error("overview-failed");
      })
    };

    const app = express();
    app.use(createAdminHostsOverviewRouter(gateway as never));
    app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err instanceof Error ? err.message : "unknown" });
    });

    const res = await request(app).get("/admin/hosts-overview").expect(500);
    expect(res.body.error).toBe("overview-failed");
  });

  // ── Namespace audit: caller namespace is silently ignored ────────────────

  it("silently ignores ?namespace= query parameter and uses config namespace", async () => {
    const gateway = {
      listResource: vi.fn(async () => []),
      getHostOverview: vi.fn(),
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const app = express();
    app.use(createAdminHostsOverviewRouter(gateway as never));

    // Namespace in query string is silently ignored — request succeeds (200, not 400)
    const listRes = await request(app)
      .get("/admin/hosts-overview?namespace=control-plane")
      .expect(200);
    expect(listRes.body.items).toEqual([]);

    const singleRes = await request(app)
      .get("/admin/hosts/host-a/overview?namespace=control-plane")
      .expect(200);

    // Gateway was called despite namespace in query (it's silently ignored)
    expect(gateway.listResource).toHaveBeenCalled();
    expect(gateway.getHostOverview).toHaveBeenCalled();

    // Security audit was logged
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('"alert":"SECURITY"'),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('"vector":"query-param"'),
    );

    warnSpy.mockRestore();
  });
});
