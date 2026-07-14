import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { K8sGateway } from "../src/k8s.js";

/**
 * HTTP-level tests for the authorization gate that was the subject of the
 * 2026-04-09 production incident:
 *
 *   GET /rpc/access/users/:userId/mcp-hosts/:hostRef
 *
 * See .local-notes/incident-403-user-agents-authorization-gap.md for the
 * full forensic reconstruction. This file locks down the HANDLER contract
 * so a future refactor cannot silently re-introduce the 403 without us
 * noticing.
 *
 * Scope of these tests: the HANDLER logic (control-api/src/routes/rpc-access/users.ts:95-120).
 * The handler implements THREE independent authorization checks after the
 * auth middleware has passed:
 *
 *   1. user_agents row exists  (checked via getUserAgents service)
 *   2. Host CRD exists         (checked via gateway.listResource)
 *   3. Host is enabled         (checked via host.spec.enabled !== false)
 *
 * Middleware-level tests (token validity, user match, host match) already
 * live in middleware.rpcAccessAuth.test.ts — we bypass the middleware here
 * via vi.mock so the tests stay focused and fast. Any breakage in the
 * middleware itself is caught by its own suite.
 */

const svc = vi.hoisted(() => ({
  getUserAgents: vi.fn(),
  getUserContexts: vi.fn(),
  getTeamAgents: vi.fn()
}));

vi.mock("../src/services/directory/index.js", () => svc);

// Bypass the middleware chain — we are testing the handler logic specifically.
// The middleware's own tests live in middleware.rpcAccessAuth.test.ts.
vi.mock("../src/middleware/rpcAccessAuth.js", () => ({
  requireValidRpcAccessToken: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireValidRpcAccessTokenAny: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireRpcTokenUserMatch: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireRpcTokenTeamMatch: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireRpcTokenHostMatch: () => (_req: unknown, _res: unknown, next: () => void) => next()
}));

import { createRpcAccessUsersRouter } from "../src/routes/rpc-access/users.js";

type HostCRD = { metadata: { name: string }; spec?: { enabled?: boolean } };

function buildApp(hosts: HostCRD[], rpcAuth?: { teamId?: string }) {
  const gatewayStub = {
    listResource: vi.fn(async () => hosts),
    getResource: vi.fn(async () => ({} as never)),
    createResource: vi.fn(async () => ({})),
    updateResource: vi.fn(async () => ({})),
    deleteResource: vi.fn(async () => ({ ok: true }))
  };
  const app = express();
  app.use(express.json());
  if (rpcAuth) {
    // Simulate what the auth middleware does: attach rpcAuth to req
    app.use((req: express.Request & { rpcAuth?: unknown }, _res, next) => {
      req.rpcAuth = rpcAuth;
      next();
    });
  }
  app.use(createRpcAccessUsersRouter(gatewayStub as unknown as K8sGateway));
  return { app, gatewayStub };
}

describe("GET /rpc/access/users/:userId/mcp-hosts/:hostRef — happy path", () => {
  beforeEach(() => {
    svc.getUserAgents.mockReset();
    svc.getTeamAgents.mockReset();
  });

  it("returns 200 with connection URL when user has row AND host exists AND host is not disabled", async () => {
    const userId = "user-golden-1";
    const hostRef = "product";

    svc.getUserAgents.mockResolvedValue({
      userId,
      agentNames: ["product", "chatllm"]
    });

    const { app, gatewayStub } = buildApp([
      { metadata: { name: "product" }, spec: {} },
      { metadata: { name: "chatllm" }, spec: {} }
    ]);

    const res = await request(app)
      .get(`/rpc/access/users/${userId}/mcp-hosts/${hostRef}`)
      .expect(200);

    expect(res.body).toMatchObject({
      userId,
      hostRef,
      url: expect.stringContaining(hostRef)
    });
    expect(svc.getUserAgents).toHaveBeenCalledWith(userId);
    expect(gatewayStub.listResource).toHaveBeenCalledWith("hosts", expect.any(String));
  });

  it("returns 200 when host has spec.enabled=true explicitly", async () => {
    svc.getUserAgents.mockResolvedValue({ userId: "user-a", agentNames: ["chatllm"] });
    const { app } = buildApp([
      { metadata: { name: "chatllm" }, spec: { enabled: true } }
    ]);
    await request(app).get(`/rpc/access/users/user-a/mcp-hosts/chatllm`).expect(200);
  });

  it("returns 200 when user has MULTIPLE agents and the target is one of them", async () => {
    svc.getUserAgents.mockResolvedValue({
      userId: "user-multi",
      agentNames: ["allinone", "chatllm", "product", "researcher"]
    });
    const { app } = buildApp([
      { metadata: { name: "allinone" }, spec: {} },
      { metadata: { name: "chatllm" }, spec: {} },
      { metadata: { name: "product" }, spec: {} }
    ]);
    await request(app).get(`/rpc/access/users/user-multi/mcp-hosts/allinone`).expect(200);
  });

  it("returns 200 for hostRef with hyphens (kebab-case agent names)", async () => {
    svc.getUserAgents.mockResolvedValue({
      userId: "user-a",
      agentNames: ["multi-word-agent"]
    });
    const { app } = buildApp([
      { metadata: { name: "multi-word-agent" }, spec: {} }
    ]);
    await request(app).get(`/rpc/access/users/user-a/mcp-hosts/multi-word-agent`).expect(200);
  });
});

describe("GET /rpc/access/users/:userId/mcp-hosts/:hostRef — CHECK #1 (user_agents row, the incident bug)", () => {
  beforeEach(() => {
    svc.getUserAgents.mockReset();
    svc.getTeamAgents.mockReset();
  });

  it("returns 403 'Forbidden' when user has ZERO rows in user_agents (the exact state of golden@kingdom.com pre-mitigation)", async () => {
    const userId = "f8b160d5-dcfc-43cf-a8c8-f18c37f4b39d"; // real UUID from the incident
    const hostRef = "product";

    svc.getUserAgents.mockResolvedValue({ userId, agentNames: [] });

    // Even though the host exists, the user_agents check fires first and blocks
    const { app } = buildApp([{ metadata: { name: "product" }, spec: {} }]);

    const res = await request(app)
      .get(`/rpc/access/users/${userId}/mcp-hosts/${hostRef}`)
      .expect(403);

    // CRITICAL contract: the response body MUST be exactly {"error":"Forbidden"}.
    // The Desktop App error "No permitted scopes/hostRefs for requested RPC token"
    // is a CLIENT-SIDE translation of this 21-byte backend response. If you
    // change this shape, update the client translation too, or users will see
    // misleading errors like in this incident.
    expect(res.body).toEqual({ error: "Forbidden" });
    // 21 bytes is the nginx gateway log signature of this specific error path.
    // The body is {"error":"Forbidden"} = 21 bytes exactly. This is the literal
    // "21" column we saw in the production nginx logs during incident triage.
    expect(Buffer.byteLength(JSON.stringify(res.body), "utf-8")).toBe(21);
  });

  it("returns 403 when user has OTHER agents but not the requested one", async () => {
    svc.getUserAgents.mockResolvedValue({
      userId: "user-has-chatllm-only",
      agentNames: ["chatllm"]
    });
    const { app } = buildApp([{ metadata: { name: "product" }, spec: {} }]);
    const res = await request(app)
      .get(`/rpc/access/users/user-has-chatllm-only/mcp-hosts/product`)
      .expect(403);
    expect(res.body).toEqual({ error: "Forbidden" });
  });

  it("is an exact-string match (no substring bypass) — user with 'allinone' cannot access 'allinone2'", async () => {
    svc.getUserAgents.mockResolvedValue({ userId: "u", agentNames: ["allinone"] });
    const { app } = buildApp([{ metadata: { name: "allinone2" }, spec: {} }]);
    await request(app).get(`/rpc/access/users/u/mcp-hosts/allinone2`).expect(403);
  });

  it("fires the user_agents check BEFORE the host CRD check (short-circuit order)", async () => {
    // Empty user_agents list + existing host → should fail at check #1, not #2
    svc.getUserAgents.mockResolvedValue({ userId: "u", agentNames: [] });
    const gatewayListResource = vi.fn(async () => [{ metadata: { name: "product" }, spec: {} }]);
    const gatewayStub = {
      listResource: gatewayListResource,
      getResource: vi.fn(),
      createResource: vi.fn(),
      updateResource: vi.fn(),
      deleteResource: vi.fn()
    };
    const app = express();
    app.use(express.json());
    app.use(createRpcAccessUsersRouter(gatewayStub as unknown as K8sGateway));

    await request(app).get(`/rpc/access/users/u/mcp-hosts/product`).expect(403);

    // Critical: the handler short-circuits on check #1, so listResource is NEVER called.
    // This is a performance guarantee (skip the K8s roundtrip when DB already rejected).
    expect(gatewayListResource).not.toHaveBeenCalled();
  });
});

describe("GET /rpc/access/users/:userId/mcp-hosts/:hostRef — CHECK #2 (Host CRD must exist)", () => {
  beforeEach(() => {
    svc.getUserAgents.mockReset();
    svc.getTeamAgents.mockReset();
  });

  it("returns 403 when the Host CRD does not exist, even if user_agents has the row (orphan protection)", async () => {
    // This is exactly the orphan 'researcher' case we found in prod — the DB
    // has a user_agents row but no corresponding Host CRD exists.
    svc.getUserAgents.mockResolvedValue({
      userId: "user-orphan",
      agentNames: ["researcher"]
    });
    const { app } = buildApp([
      { metadata: { name: "chatllm" }, spec: {} },
      { metadata: { name: "product" }, spec: {} }
    ]);

    const res = await request(app)
      .get(`/rpc/access/users/user-orphan/mcp-hosts/researcher`)
      .expect(403);
    expect(res.body).toEqual({ error: "Forbidden" });
  });

  it("returns 403 when the gateway returns an empty list of hosts", async () => {
    svc.getUserAgents.mockResolvedValue({ userId: "u", agentNames: ["product"] });
    const { app } = buildApp([]); // no hosts at all
    await request(app).get(`/rpc/access/users/u/mcp-hosts/product`).expect(403);
  });
});

describe("GET /rpc/access/users/:userId/mcp-hosts/:hostRef — CHECK #3 (host must not be disabled)", () => {
  beforeEach(() => {
    svc.getUserAgents.mockReset();
    svc.getTeamAgents.mockReset();
  });

  it("returns 403 when host.spec.enabled === false (kill switch)", async () => {
    svc.getUserAgents.mockResolvedValue({ userId: "u", agentNames: ["product"] });
    const { app } = buildApp([
      { metadata: { name: "product" }, spec: { enabled: false } } // DISABLED
    ]);
    const res = await request(app)
      .get(`/rpc/access/users/u/mcp-hosts/product`)
      .expect(403);
    expect(res.body).toEqual({ error: "Forbidden" });
  });

  it("returns 200 when spec.enabled is undefined (default permissive, the common case)", async () => {
    // This is exactly how 'product' and 'allinone' are configured in prod —
    // no explicit enabled field, which must behave as enabled=true.
    svc.getUserAgents.mockResolvedValue({ userId: "u", agentNames: ["product"] });
    const { app } = buildApp([
      { metadata: { name: "product" }, spec: {} }
    ]);
    await request(app).get(`/rpc/access/users/u/mcp-hosts/product`).expect(200);
  });

  it("returns 200 when spec itself is undefined", async () => {
    svc.getUserAgents.mockResolvedValue({ userId: "u", agentNames: ["product"] });
    const { app } = buildApp([
      { metadata: { name: "product" } } // no spec at all
    ]);
    await request(app).get(`/rpc/access/users/u/mcp-hosts/product`).expect(200);
  });
});

describe("GET /rpc/access/users/:userId/mcp-hosts/:hostRef — error propagation", () => {
  beforeEach(() => {
    svc.getUserAgents.mockReset();
    svc.getTeamAgents.mockReset();
  });

  it("returns 500 when getUserAgents throws (e.g. DB connection lost)", async () => {
    svc.getUserAgents.mockRejectedValue(new Error("postgres down"));
    const { app } = buildApp([{ metadata: { name: "product" }, spec: {} }]);
    await request(app)
      .get(`/rpc/access/users/u/mcp-hosts/product`)
      .expect(500);
  });

  it("returns 500 when gateway.listResource throws", async () => {
    svc.getUserAgents.mockResolvedValue({ userId: "u", agentNames: ["product"] });
    const gatewayStub = {
      listResource: vi.fn(async () => {
        throw new Error("k8s api unreachable");
      }),
      getResource: vi.fn(),
      createResource: vi.fn(),
      updateResource: vi.fn(),
      deleteResource: vi.fn()
    };
    const app = express();
    app.use(express.json());
    app.use(createRpcAccessUsersRouter(gatewayStub as unknown as K8sGateway));

    await request(app).get(`/rpc/access/users/u/mcp-hosts/product`).expect(500);
  });
});

describe("GET /rpc/access/users/:userId/mcp-hosts/:hostRef — team-level access (issue #141)", () => {
  beforeEach(() => {
    svc.getUserAgents.mockReset();
    svc.getTeamAgents.mockReset();
  });

  it("returns 200 when user has no user_agents row but team has the agent (the core bug)", async () => {
    const userId = "josue-user-id";
    const hostRef = "development";
    const teamId = "a9ad4638-efe0-4f03-9bba-dd1f3f9a13ca";

    svc.getUserAgents.mockResolvedValue({ userId, agentNames: [] });
    svc.getTeamAgents.mockResolvedValue({ teamId, agentNames: ["development", "other-agent"] });

    const { app } = buildApp(
      [{ metadata: { name: "development" }, spec: {} }],
      { teamId }
    );

    const res = await request(app)
      .get(`/rpc/access/users/${userId}/mcp-hosts/${hostRef}`)
      .expect(200);

    expect(res.body).toMatchObject({ userId, hostRef, url: expect.stringContaining(hostRef) });
    expect(svc.getTeamAgents).toHaveBeenCalledWith(teamId);
  });

  it("returns 403 when user_agents is empty AND team does not have the agent", async () => {
    const userId = "u";
    const hostRef = "development";
    const teamId = "team-123";

    svc.getUserAgents.mockResolvedValue({ userId, agentNames: [] });
    svc.getTeamAgents.mockResolvedValue({ teamId, agentNames: ["other-agent"] });

    const { app } = buildApp(
      [{ metadata: { name: "development" }, spec: {} }],
      { teamId }
    );

    const res = await request(app)
      .get(`/rpc/access/users/${userId}/mcp-hosts/${hostRef}`)
      .expect(403);
    expect(res.body).toEqual({ error: "Forbidden" });
  });

  it("returns 403 when user_agents is empty AND no teamId is in the token", async () => {
    svc.getUserAgents.mockResolvedValue({ userId: "u", agentNames: [] });

    // No rpcAuth injected → teamId is undefined
    const { app } = buildApp([{ metadata: { name: "development" }, spec: {} }]);

    const res = await request(app)
      .get(`/rpc/access/users/u/mcp-hosts/development`)
      .expect(403);
    expect(res.body).toEqual({ error: "Forbidden" });
    // getTeamAgents must NOT be called when there is no teamId to look up
    expect(svc.getTeamAgents).not.toHaveBeenCalled();
  });

  it("skips team lookup entirely when user already has direct access (performance: no extra DB call)", async () => {
    const userId = "u";
    const hostRef = "development";
    const teamId = "team-123";

    svc.getUserAgents.mockResolvedValue({ userId, agentNames: ["development"] });

    const { app } = buildApp(
      [{ metadata: { name: "development" }, spec: {} }],
      { teamId }
    );

    await request(app).get(`/rpc/access/users/${userId}/mcp-hosts/${hostRef}`).expect(200);
    expect(svc.getTeamAgents).not.toHaveBeenCalled();
  });
});

describe("Sibling endpoint sanity: GET /rpc/access/users/:userId/agents", () => {
  beforeEach(() => {
    svc.getUserAgents.mockReset();
    svc.getTeamAgents.mockReset();
  });

  it("returns the full user_agents list for the user", async () => {
    svc.getUserAgents.mockResolvedValue({
      userId: "u",
      agentNames: ["chatllm", "product"]
    });
    const { app } = buildApp([]);
    const res = await request(app).get(`/rpc/access/users/u/agents`).expect(200);
    expect(res.body).toEqual({ userId: "u", agentNames: ["chatllm", "product"] });
  });
});
