import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { GfsVerifiedClaims } from "../auth/verify";
import type { AuthzContext } from "../authz/permissionClient";
import { GfsServingHandler, type ServingDeps } from "./serve";

const RID = "00000000-0000-4000-8000-000000000011";
const PARENT = "00000000-0000-4000-8000-000000000012";
const REQUEST = "00000000-0000-4000-8000-000000000013";
const claims: GfsVerifiedClaims = {
  sub: "host:test", drive: "main", scopes: ["gfs.write"], pathBindings: [], iat: 1, exp: 2,
};
const context: AuthzContext = {
  primarySubject: "agent:test", subjects: ["agent:test"], drive: "main", isOperator: false, requestId: REQUEST,
};

class Response extends EventEmitter {
  statusCode = 0; headersSent = false; body = "";
  writeHead(status: number): this { this.statusCode = status; this.headersSent = true; return this; }
  end(value?: string): this { if (value) this.body += value; this.emit("close"); return this; }
}

function request(body: Record<string, unknown>): IncomingMessage {
  const stream = Readable.from([Buffer.from(JSON.stringify(body))]) as Readable & {
    method: string; url: string; headers: Record<string, string>;
  };
  stream.method = "PATCH"; stream.url = `/v1/resources/${RID}`;
  stream.headers = { authorization: "Bearer local", "x-request-id": REQUEST };
  return stream as unknown as IncomingMessage;
}

function fixture(options: { allowed?: boolean } = {}) {
  const operations: string[] = [];
  const rename = vi.fn(async (_input: unknown) => ({
    resourceId: RID, drive: "main", parentResourceId: PARENT, name: "renamed", kind: "directory" as const,
    pathCache: "/docs/renamed", version: 5, bytes: 0, blobKey: null, contentSha256: null, deletedAt: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
  }));
  const deps: ServingDeps = {
    verifyToken: () => claims,
    resolveContext: async (_claims, requestId) => ({ ...context, requestId }),
    authorize: async (_ctx, _rid, op) => { operations.push(op); return { allowed: options.allowed !== false }; },
    store: { getResource: async () => null, listChildren: async () => [] },
    blobs: { read: async () => Readable.from([]) },
    writeService: { rename } as unknown as ServingDeps["writeService"],
    audit: { record: async () => undefined },
    rename: { maxObjects: 1000, timeoutMs: 30_000 },
  };
  return { deps, handler: new GfsServingHandler(deps), rename, operations };
}

describe("PATCH resource rename", () => {
  it("authorizes write only and preserves stable identity", async () => {
    const f = fixture(); const res = new Response();
    await f.handler.tryHandle(request({ drive: "main", newName: "renamed", ifMatch: 4 }), res as never);
    expect(res.statusCode).toBe(200);
    expect(f.operations).toEqual(["write"]);
    expect(f.rename).toHaveBeenCalledOnce();
    expect(f.rename.mock.calls[0][0]).toMatchObject({
      requestId: REQUEST, subject: "agent:test", drive: "main",
      resourceId: RID.replaceAll("-", ""), newName: "renamed", ifMatch: 4,
      maxObjects: 1000, deadlineAtMs: expect.any(Number),
    });
    expect(res.body).toContain(RID.replaceAll("-", ""));
    expect(res.body).not.toContain("blobKey");
  });

  it("rejects drive mismatch and non-exact bodies before authorization", async () => {
    const mismatch = fixture(); const mismatchRes = new Response();
    await mismatch.handler.tryHandle(request({ drive: "other", newName: "renamed", ifMatch: 4 }), mismatchRes as never);
    expect(mismatchRes.statusCode).toBe(409); expect(mismatch.operations).toEqual([]);
    const extra = fixture(); const extraRes = new Response();
    await extra.handler.tryHandle(request({ drive: "main", newName: "renamed", ifMatch: 4, extra: false }), extraRes as never);
    expect(extraRes.statusCode).toBe(400); expect(extra.operations).toEqual([]);
  });

  it("returns generic deny and never calls rename", async () => {
    const f = fixture({ allowed: false }); const res = new Response();
    await f.handler.tryHandle(request({ drive: "main", newName: "renamed", ifMatch: 4 }), res as never);
    expect(res.statusCode).toBe(403); expect(res.body).toContain("rename is not authorized");
    expect(f.rename).not.toHaveBeenCalled();
  });

  it("does not expose PATCH on a reader", async () => {
    const f = fixture(); delete f.deps.writeService; delete f.deps.audit;
    const res = new Response();
    await f.handler.tryHandle(request({ drive: "main", newName: "renamed", ifMatch: 4 }), res as never);
    expect(res.statusCode).toBe(404); expect(f.operations).toEqual([]);
  });

  it("does not expose PATCH without configured rename admission limits", async () => {
    const f = fixture(); delete f.deps.rename;
    const res = new Response();
    await f.handler.tryHandle(request({ drive: "main", newName: "renamed", ifMatch: 4 }), res as never);
    expect(res.statusCode).toBe(404); expect(f.operations).toEqual([]);
    expect(f.rename).not.toHaveBeenCalled();
  });
});
