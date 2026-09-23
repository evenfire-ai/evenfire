import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { format } from "node:util";
import { Readable, Writable } from "node:stream";
import type { GfsVerifiedClaims } from "../auth/verify";
import type { AuthzContext } from "../authz/permissionClient";
import { GfsMetrics } from "../metrics";
import { RateLimiter } from "../quota/rateLimit";
import type { GfsResource } from "./read";
import { GfsServingHandler, type ServingDeps } from "./serve";

/**
 * The per-subject agent rate limit (#699): every request from a host principal
 * spends the read or the write budget right after subject resolution and before
 * authorization. User and linked-admin principals are never charged here:
 * control-api meters their Desktop requests, and the Control UI operator plane
 * (/api/v1/gfs/proxy) is not metered by either service yet (#762).
 */

class FakeRes extends Writable {
  statusCode = 0;
  headers: Record<string, string> = {};
  headersSent = false;
  private chunks: Buffer[] = [];
  writeHead(status: number, headers?: Record<string, string>): this {
    this.statusCode = status;
    this.headersSent = true;
    if (headers) Object.assign(this.headers, headers);
    return this;
  }
  setHeader(name: string, value: string): this {
    this.headers[name] = value;
    return this;
  }
  _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
    this.chunks.push(Buffer.from(chunk));
    cb();
  }
  get body(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
  get json(): { ok: boolean; error?: { code: string; message: string; limit?: string } } {
    return JSON.parse(this.body);
  }
}

const HOST_A = "host:1st:mcp-host/agent-a";
const HOST_B = "host:1st:mcp-host/agent-b";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const ADMIN_ID = "22222222-2222-4222-8222-222222222222";
const DESKTOP_USER_ID = "33333333-3333-4333-8333-333333333333";
const RID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REQUEST_ID = "44444444-4444-4444-8444-444444444444";

const DIR: GfsResource = {
  resourceId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  drive: "main",
  parentResourceId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  name: "docs",
  kind: "directory",
  pathCache: "/docs",
  version: 2,
  bytes: 0,
  blobKey: null,
  contentSha256: null,
  deletedAt: null,
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function claimsFor(token: string): GfsVerifiedClaims {
  const base = { drive: "main", scopes: ["gfs.read", "gfs.write"] as GfsVerifiedClaims["scopes"], pathBindings: [], iat: 0, exp: 0 };
  if (token === "linked-admin") {
    return {
      ...base,
      sub: ADMIN_ID,
      principalType: "control-admin",
      brokeredAuthority: { desktopUserId: DESKTOP_USER_ID, controlAdminId: ADMIN_ID, authoritySource: "linked-admin" },
    };
  }
  return { ...base, sub: token };
}

function contextFor(claims: Pick<GfsVerifiedClaims, "sub" | "brokeredAuthority">): AuthzContext {
  if (claims.brokeredAuthority) {
    return {
      drive: "main",
      subjects: ["operator:"],
      isOperator: true,
      primarySubject: ADMIN_ID,
      effectiveControlAdminId: ADMIN_ID,
      desktopUserId: DESKTOP_USER_ID,
      authoritySource: "linked-admin",
    };
  }
  if (claims.sub.startsWith("host:")) {
    return { drive: "main", subjects: [claims.sub], isOperator: false, primarySubject: claims.sub };
  }
  return { drive: "main", subjects: [`user:${claims.sub}`], isOperator: false, primarySubject: claims.sub };
}

function harness(opts: { reads?: number; writes?: number; windowMs?: number; allowed?: boolean } = {}) {
  const clock = { t: 1_000_000 };
  const windowMs = opts.windowMs ?? 60_000;
  const rateLimit = {
    reads: new RateLimiter({ limit: opts.reads ?? 100, windowMs, now: () => clock.t }),
    writes: new RateLimiter({ limit: opts.writes ?? 100, windowMs, now: () => clock.t }),
  };
  const replaces: string[] = [];
  const listChildrenBySubject: string[] = [];
  const metrics = new GfsMetrics();
  let current = "";
  const listChildren = vi.fn(async () => {
    listChildrenBySubject.push(current);
    return [];
  });
  const writeService = {
    async replace(input: { mutation: { subject: string } }) {
      replaces.push(input.mutation.subject);
      return { ...DIR, kind: "file" as const, version: 3 };
    },
  } as unknown as ServingDeps["writeService"];
  const deps: ServingDeps = {
    verifyToken: (token) => {
      current = token;
      return claimsFor(token);
    },
    resolveContext: async (claims) => contextFor(claims),
    authorize: async () => ({ allowed: opts.allowed !== false }),
    audit: { record: async () => undefined },
    store: { getResource: async () => DIR, listChildren },
    blobs: { read: async () => Readable.from([]) },
    writeService,
    metrics,
    rateLimit,
  };
  const handler = new GfsServingHandler(deps);

  async function get(token: string): Promise<FakeRes> {
    const res = new FakeRes();
    const request = { url: `/v1/resources/${RID}/children`, method: "GET", headers: { authorization: `Bearer ${token}` } };
    await handler.tryHandle(request as unknown as IncomingMessage, res as unknown as ServerResponse);
    return res;
  }

  async function put(token: string): Promise<FakeRes> {
    const res = new FakeRes();
    const stream = Readable.from([Buffer.from(JSON.stringify({ content: "hi", ifMatch: 2 }))]) as unknown as IncomingMessage;
    stream.url = `/v1/resources/${RID}/content`;
    stream.method = "PUT";
    stream.headers = { authorization: `Bearer ${token}`, "x-request-id": REQUEST_ID };
    await handler.tryHandle(stream, res as unknown as ServerResponse);
    return res;
  }

  return { clock, rateLimit, replaces, listChildren, listChildrenBySubject, metrics, get, put };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GfsServingHandler — per-subject agent rate limit", () => {
  it("case 1: caps an agent's writes and answers 429 with the retry headers", async () => {
    const h = harness({ writes: 2 });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect((await h.put(HOST_A)).statusCode).toBe(200);
    expect((await h.put(HOST_A)).statusCode).toBe(200);
    const denied = await h.put(HOST_A);
    expect(denied.statusCode).toBe(429);
    expect(denied.json.error?.code).toBe("rate_limited");
    expect(denied.json.error?.limit).toBe("agent_writes");
    expect(denied.headers["Retry-After"]).toBe("60");
    expect(denied.headers["X-RateLimit-Limit"]).toBe("2");
    expect(denied.headers["X-GFS-RateLimit-Scope"]).toBe("agent_writes");
    // The denied attempt never reached the executor.
    expect(h.replaces).toHaveLength(2);
  });

  it("case 2: caps an agent's reads", async () => {
    const h = harness({ reads: 2 });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect((await h.get(HOST_A)).statusCode).toBe(200);
    expect((await h.get(HOST_A)).statusCode).toBe(200);
    const denied = await h.get(HOST_A);
    expect(denied.statusCode).toBe(429);
    expect(denied.json.error?.code).toBe("rate_limited");
    expect(denied.headers["X-GFS-RateLimit-Scope"]).toBe("agent_reads");
    expect(denied.headers["X-RateLimit-Limit"]).toBe("2");
    expect(h.listChildren).toHaveBeenCalledTimes(2);
  });

  it("case 3: keeps separate read and write budgets, and the read budget stays finite", async () => {
    const h = harness({ reads: 2, writes: 1 });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const readsCheck = vi.spyOn(h.rateLimit.reads, "check");
    expect((await h.get(HOST_A)).statusCode).toBe(200);
    expect((await h.put(HOST_A)).statusCode).toBe(200);
    expect((await h.put(HOST_A)).statusCode).toBe(429);
    // Exhausting the writes did not drain the reads...
    expect((await h.get(HOST_A)).statusCode).toBe(200);
    // ...and the reads are still capped.
    const third = await h.get(HOST_A);
    expect(third.statusCode).toBe(429);
    expect(third.headers["X-GFS-RateLimit-Scope"]).toBe("agent_reads");
    expect(readsCheck).toHaveBeenCalledTimes(3);
  });

  it("case 4: charges every attempt, including one that authorization denies", async () => {
    const h = harness({ writes: 1, allowed: false });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const first = await h.put(HOST_A);
    expect(first.statusCode).toBe(403);
    expect(first.json.error?.code).toBe("forbidden");
    const second = await h.put(HOST_A);
    expect(second.statusCode).toBe(429);
    expect(second.json.error?.code).toBe("rate_limited");
    expect(h.replaces).toHaveLength(0);
  });

  it("case 5: meters each agent subject independently", async () => {
    const h = harness({ reads: 1 });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect((await h.get(HOST_A)).statusCode).toBe(200);
    expect((await h.get(HOST_A)).statusCode).toBe(429);
    expect((await h.get(HOST_A)).statusCode).toBe(429);
    expect((await h.get(HOST_B)).statusCode).toBe(200);
    expect(h.listChildrenBySubject).toEqual([HOST_A, HOST_B]);
  });

  it("case 6: restores the budget once the window has elapsed", async () => {
    const h = harness({ reads: 1, windowMs: 60_000 });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect((await h.get(HOST_A)).statusCode).toBe(200);
    expect((await h.get(HOST_A)).statusCode).toBe(429);
    expect(h.listChildren).toHaveBeenCalledTimes(1);
    h.clock.t += 60_001;
    expect((await h.get(HOST_A)).statusCode).toBe(200);
    expect(h.listChildren).toHaveBeenCalledTimes(2);
  });

  it("case 7: reports one denial as exactly one warning and one counter increment", async () => {
    const h = harness({ reads: 1 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect((await h.get(HOST_A)).statusCode).toBe(200);
    expect(warn).toHaveBeenCalledTimes(0);
    expect(h.metrics.snapshot().rateLimitDenied).toEqual({ read: 0, write: 0 });
    expect((await h.get(HOST_A)).statusCode).toBe(429);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(h.metrics.snapshot().rateLimitDenied).toEqual({ read: 1, write: 0 });
    expect(h.metrics.render()).toContain('gfs_rate_limit_denied_total{kind="read"} 1');
    expect(h.metrics.render()).toContain('gfs_rate_limit_denied_total{kind="write"} 0');
  });

  it("case 8: logs one line with a hashed subject and never the raw one", async () => {
    const h = harness({ writes: 1 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect((await h.put(HOST_A)).statusCode).toBe(200);
    const denied = await h.put(HOST_A);
    expect(denied.statusCode).toBe(429);
    expect(warn).toHaveBeenCalledTimes(1);
    const hashed = createHash("sha256").update(HOST_A).digest("hex");
    expect(warn.mock.calls[0]).toEqual([`[gfsc] rate_limit_denied kind=write subject=${hashed}`]);
    // console.warn renders its arguments with util.format; a log collector
    // splits records on newlines, so the rendered line must hold none.
    expect(format(...(warn.mock.calls[0] as unknown[]))).not.toContain("\n");
    expect(JSON.stringify(warn.mock.calls[0])).not.toContain(HOST_A);
    expect(JSON.stringify(warn.mock.calls[0])).not.toContain("agent-a");
    expect(denied.body).not.toContain(HOST_A);
    expect(denied.body).not.toContain("agent-a");
  });

  it("case 9: never charges user or linked-admin principals", async () => {
    const h = harness({ reads: 2 });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const readsCheck = vi.spyOn(h.rateLimit.reads, "check");
    for (let i = 0; i < 5; i += 1) {
      expect((await h.get(USER_ID)).statusCode).toBe(200);
      expect((await h.get("linked-admin")).statusCode).toBe(200);
    }
    expect(readsCheck).toHaveBeenCalledTimes(0);
    expect(h.listChildren).toHaveBeenCalledTimes(10);
    // The limiter is wired and live: a host subject is capped in the same test.
    expect((await h.get(HOST_A)).statusCode).toBe(200);
    expect((await h.get(HOST_A)).statusCode).toBe(200);
    expect((await h.get(HOST_A)).statusCode).toBe(429);
    expect(readsCheck).toHaveBeenCalledTimes(3);
  });

  it("case 10: reports Retry-After from the oldest hit still in the window", async () => {
    const h = harness({ reads: 2, windowMs: 60_000 });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect((await h.get(HOST_A)).statusCode).toBe(200);
    h.clock.t += 20_000;
    expect((await h.get(HOST_A)).statusCode).toBe(200);
    h.clock.t += 10_000;
    const denied = await h.get(HOST_A);
    expect(denied.statusCode).toBe(429);
    expect(denied.headers["Retry-After"]).toBe("30");
  });

  it("case 11: evicts subjects whose window has emptied", async () => {
    const h = harness({ reads: 5, windowMs: 60_000 });
    for (let i = 0; i < 50; i += 1) {
      expect((await h.get(`host:1st:mcp-host/agent-${i}`)).statusCode).toBe(200);
    }
    expect(h.rateLimit.reads.trackedSubjectCount).toBe(50);
    h.clock.t += 60_001;
    expect((await h.get(HOST_A)).statusCode).toBe(200);
    expect(h.rateLimit.reads.trackedSubjectCount).toBe(1);
  });
});
