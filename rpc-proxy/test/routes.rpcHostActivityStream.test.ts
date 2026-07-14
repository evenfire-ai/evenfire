import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const authTokenMock = vi.hoisted(() => ({
  verifyRpcToken: vi.fn()
}));

const serviceMock = vi.hoisted(() => ({
  resolveHostConnectionForUser: vi.fn()
}));

vi.mock("../src/authToken.js", () => authTokenMock);
vi.mock("../src/services/mcpProxyService.js", () => serviceMock);

import { config } from "../src/config.js";
import { createRpcHostActivityStreamRouter } from "../src/routes/rpcHostActivityStream.js";

const defaultConfig = {
  activityStreamMaxConcurrent: config.activityStreamMaxConcurrent,
  activityStreamMaxPerUser: config.activityStreamMaxPerUser,
  activityStreamMaxPerUserHost: config.activityStreamMaxPerUserHost,
  activityStreamMaxLifetimeMs: config.activityStreamMaxLifetimeMs,
  activityStreamKeepaliveMs: config.activityStreamKeepaliveMs,
  activityStreamIdleTimeoutMs: config.activityStreamIdleTimeoutMs
};

function makeApp() {
  const app = express();
  app.use(createRpcHostActivityStreamRouter());
  return app;
}

describe("routes/rpcHostActivityStream", () => {
  beforeEach(() => {
    authTokenMock.verifyRpcToken.mockReset();
    serviceMock.resolveHostConnectionForUser.mockReset();
    Object.assign(config, defaultConfig);
    vi.restoreAllMocks();
  });

  it("returns 401 without token", async () => {
    const app = makeApp();
    await request(app).get("/rpc/hosts/agent2/activity/stream").expect(401);
  });

  it("returns 403 without host:activity:read scope", async () => {
    authTokenMock.verifyRpcToken.mockReturnValue({
      sub: "user-1",
      typ: "user",
      teamId: "team-1",
      scopes: ["host:status:read"],
      hostRefs: ["agent2"],
      jti: "j1",
      iat: 1,
      exp: 9999999999
    });
    const app = makeApp();
    await request(app).get("/rpc/hosts/agent2/activity/stream").set("authorization", "Bearer token").expect(403);
  });

  it("returns 403 for unauthorized host", async () => {
    authTokenMock.verifyRpcToken.mockReturnValue({
      sub: "user-1",
      typ: "user",
      teamId: "team-1",
      scopes: ["host:activity:read"],
      hostRefs: ["agent2"],
      jti: "j1",
      iat: 1,
      exp: 9999999999
    });
    serviceMock.resolveHostConnectionForUser.mockResolvedValue(null);
    const app = makeApp();
    await request(app).get("/rpc/hosts/nope/activity/stream").set("authorization", "Bearer token").expect(403);
  });

  it("returns 429 when stream limits are exceeded", async () => {
    config.activityStreamMaxConcurrent = 0;
    authTokenMock.verifyRpcToken.mockReturnValue({
      sub: "user-1",
      typ: "user",
      teamId: "team-1",
      scopes: ["host:activity:read"],
      hostRefs: ["agent2"],
      jti: "j1",
      iat: 1,
      exp: 9999999999
    });
    serviceMock.resolveHostConnectionForUser.mockResolvedValue({
      name: "agent2",
      url: "http://host.local",
      headers: {}
    });
    const app = makeApp();
    await request(app).get("/rpc/hosts/agent2/activity/stream").set("authorization", "Bearer token").expect(429);
  });

  it("emits only allowed event names and sanitizes upstream errors", async () => {
    config.activityStreamMaxLifetimeMs = 25;
    config.activityStreamKeepaliveMs = 5;
    config.activityStreamIdleTimeoutMs = 100;
    authTokenMock.verifyRpcToken.mockReturnValue({
      sub: "user-1",
      typ: "user",
      teamId: "team-1",
      scopes: ["host:activity:read"],
      hostRefs: ["agent2"],
      jti: "j1",
      iat: 1,
      exp: 9999999999
    });
    serviceMock.resolveHostConnectionForUser.mockResolvedValue({
      name: "agent2",
      url: "http://host.local",
      headers: {}
    });
    const streamPayload = [
      "event: open",
      `data: ${JSON.stringify({ hostRef: "agent2", observedAt: new Date().toISOString() })}`,
      "",
      "event: activity",
      `data: ${JSON.stringify({
        version: "1.0",
        eventId: "evt_1",
        hostRef: "agent2",
        ts: new Date().toISOString(),
        type: "task.started",
        title: "started",
        severity: "info",
        meta: {},
        redactions: []
      })}`,
      "",
      "event: message",
      `data: ${JSON.stringify({ should: "be ignored" })}`,
      "",
      "event: error",
      `data: ${JSON.stringify({ message: "http://internal.local/secret-token" })}`,
      "",
      "event: closed",
      `data: ${JSON.stringify({ reason: "done" })}`,
      ""
    ].join("\n");

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(streamPayload));
          controller.close();
        }
      }), {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      })
    );

    const app = makeApp();
    const response = await request(app).get("/rpc/hosts/agent2/activity/stream").set("authorization", "Bearer token").expect(200);
    expect(response.text).toContain("event: open");
    expect(response.text).toContain("event: activity");
    expect(response.text).toContain("event: error");
    expect(response.text).toContain("Activity temporarily unavailable");
    expect(response.text).toContain("event: closed");
    expect(response.text).not.toContain("event: message");
    expect(response.text).not.toContain("internal.local");
    expect(response.text).not.toContain("secret-token");
  });
});
