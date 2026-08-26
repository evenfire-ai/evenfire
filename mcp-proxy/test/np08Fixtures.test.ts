import { afterEach, describe, expect, it } from "vitest";
import { InstrumentedUpstream, MutableNp08Authority } from "./np08Fixtures";

describe("NP-08 test fixtures", () => {
  let upstream: InstrumentedUpstream | undefined;

  afterEach(async () => {
    await upstream?.close();
    upstream = undefined;
  });

  it("models non-vacuous A/B Host -> Context -> McpServer authorization", () => {
    const authority = new MutableNp08Authority();
    authority.addServer({
      name: "shared-server",
      contextRef: "context-a",
      hostNames: ["host-a"],
      url: "https://fixture-server-a.example/mcp",
      live: true,
      enabled: true,
      deployed: true,
      ready: true,
      authoritative: true,
      generation: 1,
    });
    authority.addServer({
      name: "shared-server-b",
      contextRef: "context-b",
      hostNames: ["host-b"],
      url: "https://fixture-server-b.example/mcp",
      live: true,
      enabled: true,
      deployed: true,
      ready: true,
      authoritative: true,
      generation: 1,
    });

    expect(authority.authorize("host-a", "shared-server")).toMatchObject({ allowed: true });
    expect(authority.authorize("host-b", "shared-server-b")).toMatchObject({ allowed: true });
    expect(authority.authorize("host-a", "shared-server-b")).toEqual({
      allowed: false,
      reason: "wrong_context",
    });
    expect(authority.authorize("host-b", "shared-server")).toEqual({
      allowed: false,
      reason: "wrong_context",
    });

    authority.mutateServer("shared-server", { contextRef: "context-b", hostNames: ["host-b"] });
    expect(authority.authorize("host-a", "shared-server")).toMatchObject({
      allowed: false,
      reason: "wrong_context",
    });
    expect(authority.authorize("host-b", "shared-server")).toMatchObject({ allowed: true });
  });

  it("counts upstream connections, requests, and received body bytes", async () => {
    upstream = new InstrumentedUpstream();
    const url = await upstream.start();
    const response = await fetch(url, {
      method: "POST",
      body: "fixture-body",
      headers: { "Content-Type": "text/plain" },
    });
    expect(response.status).toBe(200);
    await response.arrayBuffer();
    expect(upstream.connectionCountValue).toBeGreaterThan(0);
    expect(upstream.requestCountValue).toBe(1);
    expect(upstream.bytesReceivedValue).toBe(Buffer.byteLength("fixture-body"));
  });
});
