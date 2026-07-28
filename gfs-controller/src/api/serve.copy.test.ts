import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { PassThrough, Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { GfsVerifiedClaims } from "../auth/verify";
import type { AuditEvent } from "../authz/audit";
import type { AuthzContext } from "../authz/permissionClient";
import type { CopyDestinationSnapshot, CopySnapshotNode } from "./copy";
import { GfsServingHandler, type ServingDeps } from "./serve";

const ROOT = "00000000-0000-4000-8000-000000000001";
const DEST = "00000000-0000-4000-8000-000000000002";
const SOURCE = "00000000-0000-4000-8000-000000000003";
const CHILD = "00000000-0000-4000-8000-000000000004";
const REQUEST = "00000000-0000-4000-8000-000000000005";
const claims: GfsVerifiedClaims = {
  sub: "host:test", drive: "main", scopes: ["gfs.read", "gfs.write"], pathBindings: [], iat: 1, exp: 2,
};
const context: AuthzContext = {
  primarySubject: "agent:test", subjects: ["agent:test"], drive: "main", isOperator: false, requestId: REQUEST,
};

function node(over: Partial<CopySnapshotNode> = {}): CopySnapshotNode {
  return { resourceId: SOURCE, drive: "main", parentResourceId: ROOT, name: "source", kind: "directory",
    pathCache: "/source", version: 2, bytes: 0n, blobKey: null, contentSha256: null,
    deletedAt: null, depth: 0, cycle: false, underTombstone: false, ...over };
}

class Response extends EventEmitter {
  statusCode = 0; headersSent = false; body = "";
  writeHead(status: number): this { this.statusCode = status; this.headersSent = true; return this; }
  end(value?: string): this { if (value) this.body += value; this.emit("close"); return this; }
  json(): unknown { return JSON.parse(this.body); }
}

function request(body: Record<string, unknown>) {
  const stream = Readable.from([Buffer.from(JSON.stringify(body))]) as Readable & { method: string; url: string; headers: Record<string, string> };
  stream.method = "POST"; stream.url = "/v1/copy";
  stream.headers = { authorization: "Bearer local", "content-type": "application/json", "x-request-id": REQUEST };
  return stream as unknown as IncomingMessage;
}

function fixture(options: { child?: boolean; snapshotCount?: number; omitLastParent?: boolean; denyChild?: boolean; copyError?: unknown; scopes?: GfsVerifiedClaims["scopes"]; times?: number[] } = {}) {
  const snapshot = [node()];
  if (options.child) snapshot.push(node({ resourceId: CHILD, parentResourceId: SOURCE, name: "child", pathCache: "/source/child", depth: 1 }));
  for (let index = snapshot.length; index < (options.snapshotCount ?? snapshot.length); index += 1) {
    const resourceId = `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    snapshot.push(node({ resourceId, parentResourceId: SOURCE, name: `child-${index}`, pathCache: `/source/child-${index}`, depth: 1 }));
  }
  if (options.omitLastParent && snapshot.length > 1) snapshot[snapshot.length - 1].parentResourceId = ROOT;
  const destination: CopyDestinationSnapshot = { ancestors: [
    node({ resourceId: DEST, parentResourceId: ROOT, name: "archive", pathCache: "/archive", version: 1 }),
    node({ resourceId: ROOT, parentResourceId: null, name: "", pathCache: "/", version: 0, depth: 1 }),
  ], liveChildren: [] };
  const batch: Array<Array<{ resourceId: string; op: string }>> = [];
  const audits: AuditEvent[] = [];
  let loads = 0;
  const copy = vi.fn(async (input: { requestId: string }) => {
    if (options.copyError) throw options.copyError;
    return { root: {
      resourceId: "10000000-0000-4000-8000-000000000001", drive: "main", parentResourceId: DEST,
      name: "source-copy", kind: "directory" as const, pathCache: "/archive/source-copy", version: 0,
      bytes: 0, blobKey: null, contentSha256: null, deletedAt: null,
    }, requestId: input.requestId, objectCount: snapshot.length, fileCount: 0,
      folderCount: snapshot.length, totalBytes: 0n };
  });
  const deps: ServingDeps = {
    verifyToken: () => ({ ...claims, scopes: options.scopes ?? claims.scopes }),
    resolveContext: async (_claims, requestId) => ({ ...context, requestId }),
    authorize: async () => ({ allowed: true }),
    store: { getResource: async () => null, listChildren: async () => [] },
    blobs: { read: async () => Readable.from([]) },
    writeService: { copy } as unknown as ServingDeps["writeService"],
    copy: {
      authorizeMany: async (_ctx, requests) => {
        batch.push(requests.map(item => ({ ...item })));
        return requests.map(item => ({ allowed: !(options.denyChild && item.resourceId === CHILD.replaceAll("-", "")) }));
      },
      permissionEpoch: () => ({ generation: 0, bypassed: false }),
      resources: {
        loadCopyAdmission: async () => ({ sourceRoot: snapshot[0] ?? null, destinationParent: destination.ancestors[0] ?? null }),
        loadCopySnapshot: async () => { loads += 1; return snapshot; },
        loadCopyDestination: async () => { loads += 1; return destination; },
      },
      audit: { record: async event => { audits.push(event); } },
      maxObjects: 1000, maxBytes: 1024 * 1024, timeoutMs: 30_000,
    },
    now: () => options.times?.shift() ?? 10,
  };
  return { deps, destination, handler: new GfsServingHandler(deps), batch, audits, copy, get loads() { return loads; } };
}

describe("POST /v1/copy", () => {
  it("aborts a stalled request body from the HTTP admission timer before metadata loads", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.deps.copy!.timeoutMs = 25;
      const stalled = new PassThrough() as PassThrough & { method: string; url: string; headers: Record<string, string> };
      stalled.method = "POST"; stalled.url = "/v1/copy";
      stalled.headers = { authorization: "Bearer local", "content-type": "application/json", "x-request-id": REQUEST };
      const res = new Response();
      const handling = f.handler.tryHandle(stalled as unknown as IncomingMessage, res as never);
      await vi.advanceTimersByTimeAsync(25);
      await handling;
      expect(res.statusCode).toBe(412);
      expect(f.loads).toBe(0);
      expect(f.batch).toEqual([]);
      expect(f.copy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-arms timeouts above the Node timer maximum instead of overflowing to 1 ms", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.deps.copy!.timeoutMs = 2_147_483_648;
      const stalled = new PassThrough() as PassThrough & { method: string; url: string; headers: Record<string, string> };
      stalled.method = "POST"; stalled.url = "/v1/copy";
      stalled.headers = { authorization: "Bearer local", "content-type": "application/json", "x-request-id": REQUEST };
      const res = new Response();
      const handling = f.handler.tryHandle(stalled as unknown as IncomingMessage, res as never);

      await vi.advanceTimersByTimeAsync(1);
      expect(res.statusCode).toBe(0);
      await vi.advanceTimersByTimeAsync(2_147_483_646);
      expect(res.statusCode).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      await handling;

      expect(res.statusCode).toBe(412);
      expect(f.loads).toBe(0);
      expect(f.copy).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not extend a long deadline when its first timer callback is delayed", async () => {
    vi.useFakeTimers();
    let monotonicNowNs = 0n;
    const monotonicClock = vi.spyOn(process.hrtime, "bigint").mockImplementation(() => monotonicNowNs);
    try {
      const f = fixture();
      f.deps.copy!.timeoutMs = 2_147_484_647;
      const stalled = new PassThrough() as PassThrough & { method: string; url: string; headers: Record<string, string> };
      stalled.method = "POST"; stalled.url = "/v1/copy";
      stalled.headers = { authorization: "Bearer local", "content-type": "application/json", "x-request-id": REQUEST };
      const res = new Response();
      const handling = f.handler.tryHandle(stalled as unknown as IncomingMessage, res as never);

      // Model an event-loop stall or machine suspension: the first bounded
      // timer fires, but the monotonic clock has already crossed the real
      // request deadline. Nominal chunk subtraction would incorrectly re-arm.
      monotonicNowNs = 2_147_484_648n * 1_000_000n;
      await vi.advanceTimersByTimeAsync(2_147_483_647);
      await handling;

      expect(res.statusCode).toBe(412);
      expect(f.loads).toBe(0);
      expect(f.copy).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      monotonicClock.mockRestore();
      vi.useRealTimers();
    }
  });

  it("clears a long copy timer when the request completes", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.deps.copy!.timeoutMs = Number.MAX_SAFE_INTEGER;
      const res = new Response();

      await f.handler.tryHandle(request({ drive: "main", sourceResourceId: SOURCE, destinationParentId: DEST, ifMatch: 2 }), res as never);

      expect(res.statusCode).toBe(201);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the maximum safe timeout exact with a relative deadline budget", async () => {
    const admittedAtMs = 1_700_000_000_000;
    const f = fixture({ times: [
      admittedAtMs,
      admittedAtMs + 1,
      admittedAtMs + 2,
      admittedAtMs + 3,
      admittedAtMs + 4,
      admittedAtMs + 5,
      admittedAtMs + 6,
      admittedAtMs + 7,
    ] });
    f.deps.copy!.timeoutMs = Number.MAX_SAFE_INTEGER;
    const res = new Response();

    await f.handler.tryHandle(request({ drive: "main", sourceResourceId: SOURCE, destinationParentId: DEST, ifMatch: 2 }), res as never);

    expect(res.statusCode).toBe(201);
    const publication = f.copy.mock.calls[0][0] as { deadlineAtMs: number; now: () => number };
    expect(publication.deadlineAtMs).toBe(Number.MAX_SAFE_INTEGER);
    expect(publication.now()).toBe(7);
  });

  it("adopts one request id, batch-authorizes the frozen tree and returns a minimal DTO", async () => {
    const f = fixture({ child: true }); const res = new Response();
    await f.handler.tryHandle(request({ drive: "main", sourceResourceId: SOURCE, destinationParentId: DEST, newName: "source-copy", ifMatch: 2 }), res as never);
    expect(res.statusCode).toBe(201);
    expect(f.batch).toEqual([
      [
        { resourceId: SOURCE.replaceAll("-", ""), op: "read" },
        { resourceId: DEST.replaceAll("-", ""), op: "write" },
      ],
      [
        { resourceId: SOURCE.replaceAll("-", ""), op: "read" },
        { resourceId: CHILD.replaceAll("-", ""), op: "read" },
        { resourceId: DEST.replaceAll("-", ""), op: "write" },
      ],
    ]);
    expect(f.copy).toHaveBeenCalledOnce();
    expect(f.copy.mock.calls[0][0]).toMatchObject({
      requestId: REQUEST, subject: "agent:test", destinationParentId: DEST.replaceAll("-", ""),
    });
    expect(res.json()).toEqual({ ok: true, data: {
      requestId: REQUEST,
      resourceId: "10000000-0000-4000-8000-000000000001",
      rid: "10000000000040008000000000000001",
      gfsUri: "gfs://main/10000000000040008000000000000001",
      name: "source-copy", kind: "directory", version: 0,
      objects: 2, files: 0, folders: 2, bytes: 0,
    } });
    expect(res.body).not.toContain("blobKey");
  });

  it("returns one generic denial when a descendant is denied", async () => {
    const f = fixture({ child: true, denyChild: true }); const res = new Response();
    await f.handler.tryHandle(request({ drive: "main", sourceResourceId: SOURCE, destinationParentId: DEST, ifMatch: 2 }), res as never);
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("copy is not authorized");
    expect(res.body).not.toContain(CHILD);
    expect(f.copy).not.toHaveBeenCalled();
    expect(f.audits).toEqual([]);
  });

  it("is absent on readers and maps ENOSPC without leaking storage details", async () => {
    const reader = fixture();
    delete reader.deps.writeService; delete reader.deps.copy;
    const absent = new Response();
    await reader.handler.tryHandle(request({ drive: "main", sourceResourceId: SOURCE, destinationParentId: DEST, ifMatch: 2 }), absent as never);
    expect(absent.statusCode).toBe(404);

    const writer = fixture({ copyError: Object.assign(new Error("private filesystem path"), { code: "ENOSPC" }) });
    const full = new Response();
    await writer.handler.tryHandle(request({ drive: "main", sourceResourceId: SOURCE, destinationParentId: DEST, ifMatch: 2 }), full as never);
    expect(full.statusCode).toBe(413);
    expect(full.body).not.toContain("private filesystem path");
  });

  it("rejects a body-drive mismatch before loading either tree", async () => {
    const f = fixture(); const res = new Response();
    await f.handler.tryHandle(request({ drive: "other", sourceResourceId: SOURCE, destinationParentId: DEST, ifMatch: 2 }), res as never);
    expect(res.statusCode).toBe(409);
    expect(f.loads).toBe(0);
    expect(f.batch).toEqual([]);
    expect(f.copy).not.toHaveBeenCalled();
    expect(f.audits).toEqual([]);
  });

  it("uses the admission timestamp for timeout and audits only after batch authorization", async () => {
    const timed = fixture({ times: [0, 0, 0, 30_000] }); const timedRes = new Response();
    await timed.handler.tryHandle(request({ drive: "main", sourceResourceId: SOURCE, destinationParentId: DEST, ifMatch: 2 }), timedRes as never);
    expect(timedRes.statusCode).toBe(412);
    expect(timed.copy).not.toHaveBeenCalled();
    expect(timed.audits).toHaveLength(0);

    const ceiling = fixture({ scopes: ["gfs.read"] }); const denied = new Response();
    await ceiling.handler.tryHandle(request({ drive: "main", sourceResourceId: SOURCE, destinationParentId: DEST, ifMatch: 2 }), denied as never);
    expect(denied.statusCode).toBe(403);
    expect(ceiling.copy).not.toHaveBeenCalled();
    expect(ceiling.audits).toEqual([]);
  });

  it("enforces If-Match, collision and object limits after authorization", async () => {
    const stale = fixture(); const staleRes = new Response();
    const staleAudit = vi.spyOn(stale.deps.copy!.audit, "record");
    await stale.handler.tryHandle(request({ drive: "main", sourceResourceId: SOURCE, destinationParentId: DEST }), staleRes as never);
    expect(staleRes.statusCode).toBe(412);
    expect(stale.audits).toHaveLength(1);
    expect(staleAudit.mock.calls[0][2]).toMatchObject({ deadlineAtMs: expect.any(Number) });

    const collision = fixture();
    collision.destination.liveChildren.push({ resourceId: CHILD, name: "source" });
    const collisionRes = new Response();
    await collision.handler.tryHandle(request({ drive: "main", sourceResourceId: SOURCE, destinationParentId: DEST, ifMatch: 2 }), collisionRes as never);
    expect(collisionRes.statusCode).toBe(409);

    const limited = fixture({ child: true }); limited.deps.copy!.maxObjects = 1;
    const limitedRes = new Response();
    await limited.handler.tryHandle(request({ drive: "main", sourceResourceId: SOURCE, destinationParentId: DEST, ifMatch: 2 }), limitedRes as never);
    expect(limitedRes.statusCode).toBe(413);

    const exact = fixture(); exact.deps.copy!.maxObjects = 1;
    const exactRes = new Response();
    await exact.handler.tryHandle(request({ drive: "main", sourceResourceId: SOURCE, destinationParentId: DEST, ifMatch: 2 }), exactRes as never);
    expect(exactRes.statusCode).toBe(201);
  });

  it("rejects the bounded one-over snapshot without publishing", async () => {
    const fixture1001 = fixture({ snapshotCount: 1001 }); const res = new Response();
    await fixture1001.handler.tryHandle(request({ drive: "main", sourceResourceId: SOURCE, destinationParentId: DEST, ifMatch: 2 }), res as never);
    expect(res.statusCode).toBe(413);
    expect(fixture1001.batch[1]).toHaveLength(1002);
    expect(fixture1001.copy).not.toHaveBeenCalled();
    expect(fixture1001.audits).toHaveLength(1);
  });

  it("rejects an unordered one-over sentinel before validating its omitted parent or publishing", async () => {
    const fixture1001 = fixture({ snapshotCount: 1001, omitLastParent: true }); const res = new Response();
    await fixture1001.handler.tryHandle(request({ drive: "main", sourceResourceId: SOURCE, destinationParentId: DEST, ifMatch: 2 }), res as never);
    expect(res.statusCode).toBe(413);
    expect(fixture1001.copy).not.toHaveBeenCalled();
    expect(fixture1001.audits).toHaveLength(1);
  });
});
