import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { Readable, Writable } from "node:stream";
import type { GfsVerifiedClaims } from "../auth/verify";
import type { AuthzContext } from "../authz/permissionClient";
import { loadConfig, type GfsConfig } from "../config";
import { GfsMetrics } from "../metrics";
import { RateLimiter } from "../quota/rateLimit";
import { GfsServer } from "../server";
import type { GfsResource } from "./read";
import { GfsServingHandler, type ServingDeps } from "./serve";

/**
 * Stress suite for the per-subject agent rate limit (#699). Concurrent bursts
 * from many host principals, with user and linked-admin traffic interleaved,
 * against real `RateLimiter` instances on an injected clock. Every count is
 * exact: the limiter is in-process and synchronous, so concurrency cannot make
 * the outcome approximate.
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
  get json(): { ok: boolean; error?: { code: string; limit?: string } } {
    return JSON.parse(Buffer.concat(this.chunks).toString("utf8"));
  }
}

const WINDOW_MS = 60_000;
const RID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REQUEST_ID = "44444444-4444-4444-8444-444444444444";
const ADMIN_ID = "22222222-2222-4222-8222-222222222222";
const DESKTOP_USER_ID = "33333333-3333-4333-8333-333333333333";
const LINKED_ADMIN = "linked-admin";

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

const hosts = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `host:1st:mcp-host/agent-${String(i).padStart(2, "0")}`);
const users = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `11111111-1111-4111-8111-${String(i).padStart(12, "0")}`);

function claimsFor(token: string): GfsVerifiedClaims {
  const base = {
    drive: "main",
    scopes: ["gfs.read", "gfs.write"] as GfsVerifiedClaims["scopes"],
    pathBindings: [],
    iat: 0,
    exp: 0,
  };
  if (token === LINKED_ADMIN) {
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

interface Plane {
  deps: ServingDeps;
  handler: GfsServingHandler;
  clock: { t: number };
  metrics: GfsMetrics;
  /** Permission-store decisions, by the subject that asked. */
  authorizeCalls: string[];
  /** Flip to make the permission store deny every later request. */
  store: { allow: boolean };
}

function plane(limits: { reads: number; writes: number }): Plane {
  const clock = { t: 1_000_000 };
  const store = { allow: true };
  const authorizeCalls: string[] = [];
  const metrics = new GfsMetrics();
  const deps: ServingDeps = {
    verifyToken: (token) => claimsFor(token),
    resolveContext: async (claims) => contextFor(claims),
    authorize: async (ctx) => {
      authorizeCalls.push(ctx.primarySubject);
      return { allowed: store.allow };
    },
    audit: { record: async () => undefined },
    store: { getResource: async () => DIR, listChildren: async () => [] },
    blobs: { read: async () => Readable.from([]) },
    writeService: {
      async replace() {
        return { ...DIR, kind: "file" as const, version: 3 };
      },
    } as unknown as ServingDeps["writeService"],
    metrics,
    rateLimit: {
      reads: new RateLimiter({ limit: limits.reads, windowMs: WINDOW_MS, now: () => clock.t }),
      writes: new RateLimiter({ limit: limits.writes, windowMs: WINDOW_MS, now: () => clock.t }),
    },
  };
  return { deps, handler: new GfsServingHandler(deps), clock, metrics, authorizeCalls, store };
}

async function get(p: Plane, token: string): Promise<FakeRes> {
  const res = new FakeRes();
  const req = { url: `/v1/resources/${RID}/children`, method: "GET", headers: { authorization: `Bearer ${token}` } };
  await p.handler.tryHandle(req as unknown as IncomingMessage, res as unknown as ServerResponse);
  return res;
}

async function put(p: Plane, token: string): Promise<FakeRes> {
  const res = new FakeRes();
  const req = Readable.from([Buffer.from(JSON.stringify({ content: "hi", ifMatch: 2 }))]) as unknown as IncomingMessage;
  req.url = `/v1/resources/${RID}/content`;
  req.method = "PUT";
  req.headers = { authorization: `Bearer ${token}`, "x-request-id": REQUEST_ID };
  await p.handler.tryHandle(req, res as unknown as ServerResponse);
  return res;
}

/** Fire `perSubject` concurrent requests for every token in one Promise.all. */
async function burst(
  p: Plane,
  tokens: string[],
  perSubject: number,
  send: (p: Plane, token: string) => Promise<FakeRes>
): Promise<Map<string, FakeRes[]>> {
  const flat = tokens.flatMap((token) => Array.from({ length: perSubject }, () => token));
  const results = await Promise.all(flat.map((token) => send(p, token)));
  const byToken = new Map<string, FakeRes[]>(tokens.map((t) => [t, []]));
  flat.forEach((token, i) => byToken.get(token)!.push(results[i]));
  return byToken;
}

const statuses = (rs: FakeRes[]): Record<number, number> =>
  rs.reduce<Record<number, number>>((acc, r) => ({ ...acc, [r.statusCode]: (acc[r.statusCode] ?? 0) + 1 }), {});

let warn: ReturnType<typeof vi.spyOn>;
const denialLogs = (): Array<{ kind: string }> =>
  warn.mock.calls
    .map((c: unknown[]) => c[0] as { event?: string; kind: string })
    .filter((e: { event?: string }) => e?.event === "gfs_rate_limit_denied");

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("agent rate limit under concurrent load", () => {
  const R = 5;
  const W = 2;
  const AGENTS = hosts(20);

  it("G1+G6: 20 agents x 10 concurrent reads each get exactly R through, and only those reach the store", async () => {
    const p = plane({ reads: R, writes: W });

    const byAgent = await burst(p, AGENTS, 10, get);

    for (const agent of AGENTS) {
      const rs = byAgent.get(agent)!;
      expect(statuses(rs)).toEqual({ 200: R, 429: 10 - R });
      for (const denied of rs.filter((r) => r.statusCode === 429)) {
        expect(denied.json.error?.code).toBe("rate_limited");
        expect(denied.json.error?.limit).toBe("agent_reads");
        expect(denied.headers["Retry-After"]).toBe("60");
        expect(denied.headers["X-RateLimit-Limit"]).toBe(String(R));
        expect(denied.headers["X-GFS-RateLimit-Scope"]).toBe("agent_reads");
      }
      // G6: the permission store answered exactly the allowed requests.
      expect(p.authorizeCalls.filter((s) => s === agent)).toHaveLength(R);
    }
    expect(p.authorizeCalls).toHaveLength(AGENTS.length * R);
    expect(p.metrics.snapshot().rateLimitDenied).toEqual({ read: AGENTS.length * (10 - R), write: 0 });
    expect(denialLogs()).toHaveLength(AGENTS.length * (10 - R));
  });

  it("G2: after the read budget is spent, writes spend their own budget; a following read is still denied", async () => {
    const p = plane({ reads: R, writes: W });
    await burst(p, AGENTS, 10, get);
    const authorizedAfterReads = p.authorizeCalls.length;
    p.store.allow = false;

    const byAgent = await burst(p, AGENTS, 5, put);

    for (const agent of AGENTS) {
      const rs = byAgent.get(agent)!;
      expect(statuses(rs)).toEqual({ 403: W, 429: 5 - W });
      for (const denied of rs.filter((r) => r.statusCode === 429)) {
        expect(denied.json.error?.limit).toBe("agent_writes");
        expect(denied.headers["X-RateLimit-Limit"]).toBe(String(W));
      }
    }
    // Only the W writes per agent that passed the limiter asked the store.
    expect(p.authorizeCalls.length - authorizedAfterReads).toBe(AGENTS.length * W);

    const after = await burst(p, AGENTS, 1, get);
    for (const agent of AGENTS) {
      const [r] = after.get(agent)!;
      expect(r.statusCode).toBe(429);
      expect(r.json.error?.limit).toBe("agent_reads");
    }
    expect(p.metrics.snapshot().rateLimitDenied).toEqual({
      read: AGENTS.length * (10 - R) + AGENTS.length,
      write: AGENTS.length * (5 - W),
    });
  });

  it("G3: user and linked-admin reads interleaved with the agent burst are never denied by gfsc", async () => {
    const p = plane({ reads: R, writes: W });
    const people = [...users(5), LINKED_ADMIN];
    const perPerson = 3 * R;

    const [agentResults, peopleResults] = await Promise.all([
      burst(p, AGENTS, 10, get),
      burst(p, people, perPerson, get),
    ]);

    for (const person of people) {
      expect(statuses(peopleResults.get(person)!)).toEqual({ 200: perPerson });
    }
    // Liveness witness: the limiter was active in the same burst.
    for (const agent of AGENTS) {
      expect(statuses(agentResults.get(agent)!)).toEqual({ 200: R, 429: 10 - R });
    }
    expect(p.authorizeCalls.filter((s) => !s.startsWith("host:"))).toHaveLength(people.length * perPerson);
    expect(p.deps.rateLimit.reads.trackedSubjectCount).toBe(AGENTS.length);
  });

  it("G4: the window slides; a full window restores the budget and half a window frees only the older half", async () => {
    const p = plane({ reads: 6, writes: W });
    const [agent] = AGENTS;
    const t0 = p.clock.t;

    expect(statuses((await burst(p, [agent], 3, get)).get(agent)!)).toEqual({ 200: 3 });
    p.clock.t = t0 + WINDOW_MS / 2;
    expect(statuses((await burst(p, [agent], 3, get)).get(agent)!)).toEqual({ 200: 3 });
    const over = await get(p, agent);
    expect(over.statusCode).toBe(429);
    expect(over.headers["Retry-After"]).toBe(String(WINDOW_MS / 2 / 1000));

    // The first three hits leave the window; the three from t0 + W/2 remain.
    p.clock.t = t0 + WINDOW_MS + 1;
    expect(statuses((await burst(p, [agent], 6, get)).get(agent)!)).toEqual({ 200: 3, 429: 3 });

    // A full window after the last allowed hit, the whole budget is back.
    p.clock.t = t0 + 2 * WINDOW_MS + 2;
    expect(statuses((await burst(p, [agent], 8, get)).get(agent)!)).toEqual({ 200: 6, 429: 2 });
  });
});

describe("agent rate limit through a real GfsServer", () => {
  const R = 5;
  const PER_CLIENT = R + 5;
  const AGENT = "host:1st:mcp-host/agent-wire";

  /** The operator's value travels env → loadConfig → limiter, as in index.ts. */
  function operatorConfig(): GfsConfig {
    vi.stubEnv("GFS_STORAGE_ROLE", "reader");
    vi.stubEnv("GFS_DEV_MODE", "true");
    vi.stubEnv("GFS_PORT", "0");
    vi.stubEnv("GFS_AGENT_READ_RL_PER_MIN_PER_REPLICA", String(R));
    vi.stubEnv("GFS_AGENT_WRITE_RL_PER_MIN_PER_REPLICA", "2");
    return loadConfig();
  }

  let server: GfsServer | null = null;
  const agents: http.Agent[] = [];
  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const a of agents.splice(0)) a.destroy();
    if (server) await server.stop();
    server = null;
  });

  interface WireResponse {
    status: number;
    retryAfter: string | undefined;
    limit: string | undefined;
    localPort: number;
  }

  function wireGet(port: number, agent: http.Agent): Promise<WireResponse> {
    return new Promise((resolve, reject) => {
      const req = http.get(
        {
          host: "127.0.0.1",
          port,
          path: `/v1/resources/${RID}/children`,
          agent,
          headers: { authorization: `Bearer ${AGENT}` },
        },
        (res) => {
          // Read the socket before "end": keep-alive detaches it on release.
          const localPort = res.socket.localPort;
          if (localPort === undefined) {
            reject(new Error("response socket has no local port"));
            return;
          }
          res.resume();
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              retryAfter: res.headers["retry-after"] as string | undefined,
              limit: res.headers["x-ratelimit-limit"] as string | undefined,
              localPort,
            })
          );
        }
      );
      req.on("error", reject);
    });
  }

  function metricsText(port: number): Promise<string> {
    return new Promise((resolve, reject) => {
      http
        .get({ host: "127.0.0.1", port, path: "/metrics" }, (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => resolve(text));
        })
        .on("error", reject);
    });
  }

  it("G5: two keep-alive clients of one agent share one budget across both sockets", async () => {
    const config = operatorConfig();
    expect(config.port).toBe(0);
    const p = plane({ reads: config.agentReadRlPerMinPerReplica, writes: config.agentWriteRlPerMinPerReplica });
    server = new GfsServer(
      config,
      { isStorageMounted: async () => true, pingPermissionStore: async () => undefined },
      p.handler,
      p.metrics
    );
    const port = await server.start();

    const clients = [0, 1].map(() => {
      const a = new http.Agent({ keepAlive: true, maxSockets: 1 });
      agents.push(a);
      return a;
    });
    const sequential = async (a: http.Agent): Promise<WireResponse[]> => {
      const out: WireResponse[] = [];
      for (let i = 0; i < PER_CLIENT; i++) out.push(await wireGet(port, a));
      return out;
    };
    const [first, second] = await Promise.all(clients.map(sequential));
    const all = [...first, ...second];

    // Each client reused one socket, and the two sockets are distinct.
    const firstPorts = new Set(first.map((r) => r.localPort));
    const secondPorts = new Set(second.map((r) => r.localPort));
    expect(firstPorts.size).toBe(1);
    expect(secondPorts.size).toBe(1);
    expect([...firstPorts][0]).not.toBe([...secondPorts][0]);

    expect(all.filter((r) => r.status === 200)).toHaveLength(R);
    const denied = all.filter((r) => r.status === 429);
    expect(denied).toHaveLength(2 * PER_CLIENT - R);
    for (const r of denied) {
      expect(r.retryAfter).toBe("60");
      expect(r.limit).toBe(String(R));
    }
    expect(p.authorizeCalls).toHaveLength(R);
    expect(await metricsText(port)).toContain(`gfs_rate_limit_denied_total{kind="read"} ${2 * PER_CLIENT - R}`);
  });
});
