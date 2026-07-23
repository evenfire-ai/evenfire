import { describe, it, expect, vi } from "vitest";

vi.mock("../src/config.js", () => ({
  config: { requestTimeoutMs: 5000, externalRestApiBaseUrl: "http://localhost:8091" },
}));
vi.mock("../src/httpClient.js", () => ({
  requestJson: vi.fn(),
  ApiError: class extends Error { status = 0; bodyText = ""; },
}));

import { RpcTokenManager } from "../src/rpcTokenManager.js";
import type { AuthClient } from "../src/authClient.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeAuthClient(token = "rpc-token-123", expiresInSeconds = 60) {
  return {
    issueRpcToken: vi.fn().mockResolvedValue({
      token,
      teamId: "team-1",
      scopes: ["host:message:invoke"],
      hostRefs: ["chatllm"],
      expiresInSeconds,
    }),
  } as unknown as AuthClient;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("RpcTokenManager — initial state", () => {
  it("returns null expiresAtMs before any token is fetched", () => {
    const manager = new RpcTokenManager(makeAuthClient());
    const meta = manager.getMetadata();

    expect(meta.expiresAtMs).toBeNull();
    expect(meta.scopes).toEqual([]);
    expect(meta.hostRefs).toEqual([]);
  });
});

describe("RpcTokenManager — clear()", () => {
  it("resets cache so next getOrIssue() fetches fresh", async () => {
    const authClient = makeAuthClient();
    const manager = new RpcTokenManager(authClient);

    // Prime cache
    await manager.getOrIssue("sess-token", ["host:message:invoke"]);
    expect(authClient.issueRpcToken).toHaveBeenCalledOnce();

    // After clear(), a second getOrIssue() should re-fetch
    manager.clear();
    await manager.getOrIssue("sess-token", ["host:message:invoke"]);
    expect(authClient.issueRpcToken).toHaveBeenCalledTimes(2);
  });
});

describe("RpcTokenManager — getOrIssue()", () => {
  it("fetches a new token when cache is empty", async () => {
    const authClient = makeAuthClient("rpc-fresh-token");
    const manager = new RpcTokenManager(authClient);

    const result = await manager.getOrIssue("sess-token", ["host:message:invoke"]);
    expect(result.token).toBe("rpc-fresh-token");
    expect(authClient.issueRpcToken).toHaveBeenCalledOnce();
  });

  it("reuses cached token on second call when not expired", async () => {
    const authClient = makeAuthClient("rpc-cached-token", 60);
    const manager = new RpcTokenManager(authClient);

    const first = await manager.getOrIssue("sess-token", ["host:message:invoke"]);
    const second = await manager.getOrIssue("sess-token", ["host:message:invoke"]);

    expect(first.token).toBe(second.token);
    // Should only have fetched once (cache hit)
    expect(authClient.issueRpcToken).toHaveBeenCalledOnce();
  });

  it("re-fetches when token is expired (expiresInSeconds = 0)", async () => {
    const authClient = makeAuthClient("rpc-expired", 0);
    const manager = new RpcTokenManager(authClient);

    // First call populates cache with 0s TTL (expired immediately)
    await manager.getOrIssue("sess-token", ["host:message:invoke"]);

    // Override to return fresh token
    vi.mocked(authClient.issueRpcToken).mockResolvedValueOnce({
      token: "rpc-fresh-2",
      accessScope: "team",
      teamId: "team-1",
      scopes: ["host:message:invoke"],
      hostRefs: ["chatllm"],
      expiresInSeconds: 60,
    });

    const result = await manager.getOrIssue("sess-token", ["host:message:invoke"]);
    expect(result.token).toBe("rpc-fresh-2");
    expect(authClient.issueRpcToken).toHaveBeenCalledTimes(2);
  });

  it("returns metadata reflecting cached token after first fetch", async () => {
    const manager = new RpcTokenManager(makeAuthClient("tok", 120));
    await manager.getOrIssue("sess", ["host:message:invoke"]);

    const meta = manager.getMetadata();
    expect(meta.expiresAtMs).toBeGreaterThan(Date.now());
    expect(meta.scopes).toContain("host:message:invoke");
    expect(meta.hostRefs).toContain("chatllm");
  });
});

// ── Subset-scope reuse: INTENTIONAL, pinned on purpose ────────────────────────
//
// A narrower request is satisfied from a cached SUPERSET token, so the token a
// caller receives can carry scopes it did not ask for — including
// host:wake:write on a stream/observability surface. That is deliberate: it
// keeps issuance to one round trip instead of one per distinct scope set, and
// it is NOT a wake risk, because possessing the scope never wakes a Host —
// rpc-proxy triggers a wake only from its explicit per-route allowlist plus the
// isWakeCapable gate (wakeAndHold.ts).
//
// This test exists so the behavior is a pinned contract rather than an
// undocumented side effect: if someone later makes stream open a wake-capable
// route, or narrows this cache to exact-scope keying, one of these two
// assertions turns red and forces the decision to be made explicitly.
describe("RpcTokenManager — subset scope reuse", () => {
  it("serves a narrower request from the cached superset token, which still carries host:wake:write", async () => {
    const authClient = {
      issueRpcToken: vi.fn().mockResolvedValue({
        token: "rpc-token-superset",
        accessScope: "team",
        teamId: "team-1",
        scopes: ["host:activity:read", "host:task:read", "host:wake:write"],
        hostRefs: ["chatllm"],
        expiresInSeconds: 60,
      }),
    } as unknown as AuthClient;
    const manager = new RpcTokenManager(authClient);

    // Broad issuance (e.g. a finite operation that legitimately needs wake).
    await manager.getOrIssue(
      "sess-token",
      ["host:activity:read", "host:task:read", "host:wake:write"],
      ["chatllm"]
    );
    expect(authClient.issueRpcToken).toHaveBeenCalledOnce();

    // Narrower request (e.g. an observability read) — served from cache.
    const reused = await manager.getOrIssue("sess-token", ["host:activity:read"], ["chatllm"]);

    // 1. Exactly ONE issuance: the subset did not trigger a second round trip.
    expect(authClient.issueRpcToken).toHaveBeenCalledOnce();
    // 2. The DELIVERED token is the cached superset — it still carries wake.
    expect(reused.token).toBe("rpc-token-superset");
    expect(reused.scopes).toContain("host:wake:write");
  });
});
