import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { GfsAuthError, type GfsScope, type GfsVerifiedClaims } from "../auth/verify";
import type { AuthzContext } from "../authz/permissionClient";
import type { GfsPermission } from "../authz/resolve";
import { GfsError } from "./errors";
import { GfsResource } from "./read";
import { GfsServingHandler, ServingDeps } from "./serve";

/** A minimal ServerResponse stand-in: a Writable that also records status/headers. */
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
  _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
    this.chunks.push(Buffer.from(chunk));
    cb();
  }
  get body(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
  get json(): unknown {
    return JSON.parse(this.body);
  }
}

function req(url: string, opts: { method?: string; auth?: string } = {}): IncomingMessage {
  const headers: Record<string, string> = {};
  if (opts.auth !== undefined) headers["authorization"] = opts.auth;
  return { url, method: opts.method ?? "GET", headers } as unknown as IncomingMessage;
}

/** A request carrying a JSON body — a real Readable so readJsonBody can consume it. */
function reqBody(
  url: string,
  opts: { method: string; auth?: string; body?: unknown; rawBody?: string }
): IncomingMessage {
  const json = opts.rawBody ?? (opts.body === undefined ? "" : JSON.stringify(opts.body));
  const stream = Readable.from(json ? [Buffer.from(json, "utf8")] : []) as unknown as IncomingMessage;
  stream.url = url;
  stream.method = opts.method;
  stream.headers = opts.auth !== undefined ? { authorization: opts.auth } : {};
  return stream;
}

const CLAIMS: GfsVerifiedClaims = {
  sub: "user-1",
  drive: "main",
  scopes: ["gfs.read"],
  pathBindings: [],
  iat: 0,
  exp: 0,
};

const CTX: AuthzContext = {
  drive: "main",
  subjects: ["user:user-1"],
  isOperator: false,
  primarySubject: "user-1",
};

const FILE: GfsResource = {
  resourceId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  drive: "main",
  parentResourceId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  name: "report.pdf",
  kind: "file",
  pathCache: "/docs/report.pdf",
  version: 2,
  bytes: 11,
  blobKey: null,
  contentSha256: null,
  deletedAt: null,
};
const DIR: GfsResource = {
  ...FILE,
  kind: "directory",
  name: "docs",
  pathCache: "/docs",
  bytes: 0,
};
const RID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; // FILE.resourceId, hyphen-stripped

/** Build deps with sensible allow-all defaults; override per test. */
function deps(over: Partial<ServingDeps> = {}): ServingDeps {
  return {
    verifyToken: () => CLAIMS,
    resolveContext: async () => CTX,
    authorize: async () => ({ allowed: true }),
    audit: { record: async () => undefined },
    store: {
      getResource: async () => FILE,
      listChildren: async () => [FILE],
    },
    blobs: { read: async () => Readable.from(Buffer.from("hello world")) },
    ...over,
  };
}

/** Run the handler against a FakeRes (cast to the ServerResponse the API wants). */
function run(d: ServingDeps, request: IncomingMessage, res: FakeRes): Promise<boolean> {
  return new GfsServingHandler(d).tryHandle(request, res as unknown as ServerResponse);
}

describe("GfsReadServer.tryHandle — routing", () => {
  it("returns false for a path it does not own (caller falls through to 404)", async () => {
    const res = new FakeRes();
    const handled = await run(deps(), req("/healthz"), res);
    expect(handled).toBe(false);
    expect(res.statusCode).toBe(0); // untouched
  });

  it("handles a matched read path with the wrong method as a 404", async () => {
    const res = new FakeRes();
    const handled = await run(deps(),
      req(`/v1/resources/${RID}`, { method: "POST", auth: "Bearer t" }),
      res
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(404);
  });
});

describe("GfsReadServer.tryHandle — auth chain (fail-closed)", () => {
  it("401 when the Authorization header is missing", async () => {
    const res = new FakeRes();
    await run(deps(), req(`/v1/resources/${RID}`), res);
    expect(res.statusCode).toBe(401);
    expect((res.json as { error: { code: string } }).error.code).toBe("unauthorized");
  });

  it("401 when token verification fails", async () => {
    const res = new FakeRes();
    const d = deps({
      verifyToken: () => {
        throw new GfsAuthError("bad signature");
      },
    });
    await run(d, req(`/v1/resources/${RID}`, { auth: "Bearer bad" }), res);
    expect(res.statusCode).toBe(401);
  });

  it("503 (fail-closed) when subject resolution hits a store error", async () => {
    const res = new FakeRes();
    const d = deps({
      resolveContext: async () => {
        throw new Error("permission store down");
      },
    });
    await run(d, req(`/v1/resources/${RID}`, { auth: "Bearer t" }), res);
    expect(res.statusCode).toBe(503);
    expect((res.json as { error: { code: string } }).error.code).toBe("not_mounted");
  });

  it("403 when the store denies — and NO resource metadata is leaked", async () => {
    const res = new FakeRes();
    const d = deps({ authorize: async () => ({ allowed: false }) });
    await run(d, req(`/v1/resources/${RID}`, { auth: "Bearer t" }), res);
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain("report.pdf"); // no existence/name leak
  });

  it("403 when the token ceiling denies (scope absent) — store never consulted", async () => {
    const res = new FakeRes();
    let authorizeCalled = false;
    const d = deps({
      verifyToken: () => ({ ...CLAIMS, scopes: [] }), // no gfs.read
      authorize: async () => {
        authorizeCalled = true;
        return { allowed: true };
      },
    });
    await run(d, req(`/v1/resources/${RID}`, { auth: "Bearer t" }), res);
    expect(res.statusCode).toBe(403);
    expect(authorizeCalled).toBe(false); // ceiling short-circuits before the store
  });

  it("503 (fail-closed) when the store authorize throws not_mounted", async () => {
    const res = new FakeRes();
    const d = deps({
      authorize: async () => {
        throw new GfsError("not_mounted", "permission store unavailable");
      },
    });
    await run(d, req(`/v1/resources/${RID}`, { auth: "Bearer t" }), res);
    expect(res.statusCode).toBe(503);
  });

  it("400 path_invalid for a malformed rid (never reaches the store as a 503)", async () => {
    const res = new FakeRes();
    await run(deps(),
      req("/v1/resources/not-a-valid-rid!!", { auth: "Bearer t" }),
      res
    );
    expect(res.statusCode).toBe(400);
    expect((res.json as { error: { code: string } }).error.code).toBe("path_invalid");
  });
});

describe("GfsReadServer.tryHandle — served reads", () => {
  it("200 stat returns the resource VIEW with a stable gfsUri", async () => {
    const res = new FakeRes();
    await run(deps(), req(`/v1/resources/${RID}`, { auth: "Bearer t" }), res);
    expect(res.statusCode).toBe(200);
    const data = (res.json as { ok: boolean; data: { gfsUri: string; name: string } }).data;
    expect(data.name).toBe("report.pdf");
    expect(data.gfsUri).toBe(`gfs://main/${RID}`);
  });

  it("200 children returns the paged items", async () => {
    const res = new FakeRes();
    // The listed resource must be a directory; a file would (correctly) 409.
    const d = deps({ store: { getResource: async () => DIR, listChildren: async () => [FILE] } });
    await run(d, req(`/v1/resources/${RID}/children?limit=10`, { auth: "Bearer t" }), res);
    expect(res.statusCode).toBe(200);
    const data = (res.json as { data: { items: unknown[]; nextCursor: string | null } }).data;
    expect(data.items).toHaveLength(1);
    expect(data.nextCursor).toBeNull();
  });

  it("200 content streams the raw bytes with length + uri headers", async () => {
    const res = new FakeRes();
    await run(deps(),
      req(`/v1/resources/${RID}/content`, { auth: "Bearer t" }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Length"]).toBe("11");
    expect(res.headers["X-Gfs-Uri"]).toBe(`gfs://main/${RID}`);
    expect(res.body).toBe("hello world");
  });

  it("destroys the blob stream when the client disconnects mid-download", async () => {
    // fd-leak regression: pipe() does not propagate destination close to the
    // source, so a client abort must destroy the blob stream explicitly.
    const res = new FakeRes();
    const source = new Readable({ read() {} });
    source.push("partial");
    const d = deps({ blobs: { read: async () => source } });
    const handled = run(d, req(`/v1/resources/${RID}/content`, { auth: "Bearer t" }), res);
    await new Promise(resolve => setTimeout(resolve, 0));
    res.emit("close");
    await handled;
    expect(source.destroyed).toBe(true);
  });

  it("200 resolve maps a gfs:// uri (same drive) to its view", async () => {
    const res = new FakeRes();
    await run(deps(),
      req(`/v1/resolve?uri=${encodeURIComponent(`gfs://main/${RID}`)}`, { auth: "Bearer t" }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect((res.json as { data: { name: string } }).data.name).toBe("report.pdf");
  });

  it("403 resolve across a DIFFERENT drive than the token (no cross-drive existence probe)", async () => {
    const res = new FakeRes();
    await run(deps(),
      req(`/v1/resolve?uri=${encodeURIComponent(`gfs://other/${RID}`)}`, { auth: "Bearer t" }),
      res
    );
    expect(res.statusCode).toBe(403);
  });

  it("200 accessible returns direct resources and effective permissions for the principal", async () => {
    const res = new FakeRes();
    const listAccessible: ServingDeps["listAccessible"] = async () => ({
      items: [
        {
          resourceId: FILE.resourceId,
          rid: RID,
          gfsUri: `gfs://main/${RID}`,
          drive: "main",
          parentResourceId: FILE.parentResourceId,
          name: FILE.name,
          kind: FILE.kind,
          path: FILE.pathCache,
          version: FILE.version,
          bytes: FILE.bytes,
          permissions: ["read", "write"],
          sources: ["grant"],
          coversDescendants: true,
        },
      ],
      nextCursor: null,
    });
    await run(deps({ listAccessible }), req("/v1/accessible?limit=20", { auth: "Bearer t" }), res);
    expect(res.statusCode).toBe(200);
    const data = (res.json as { data: { items: Array<{ gfsUri: string; permissions: string[] }> } }).data;
    expect(data.items[0]?.gfsUri).toBe(`gfs://main/${RID}`);
    expect(data.items[0]?.permissions).toContain("write");
  });

  it("403 accessible requires a read scope even if the store would return rows", async () => {
    const res = new FakeRes();
    await run(
      deps({
        verifyToken: () => ({ ...CLAIMS, scopes: [] }),
        listAccessible: async () => ({ items: [], nextCursor: null }),
      }),
      req("/v1/accessible", { auth: "Bearer t" }),
      res
    );
    expect(res.statusCode).toBe(403);
  });

  it("403 accessible honors path-scoped token ceilings", async () => {
    const res = new FakeRes();
    await run(
      deps({
        verifyToken: () => ({
          ...CLAIMS,
          pathBindings: [{ path: "/docs", permissions: ["read"] }],
        }),
        listAccessible: async () => ({ items: [], nextCursor: null }),
      }),
      req("/v1/accessible", { auth: "Bearer t" }),
      res
    );
    expect(res.statusCode).toBe(403);
  });

});

const WRITE_SCOPES: GfsScope[] = ["gfs.read", "gfs.write", "gfs.delete"];
const AGENT_CLAIMS: GfsVerifiedClaims = { ...CLAIMS, sub: "host:1st:mcp-host/standalone", scopes: WRITE_SCOPES };
const USER_WRITE_CLAIMS: GfsVerifiedClaims = { ...CLAIMS, scopes: WRITE_SCOPES };

/** A recording write service; each method records its input and returns a row. */
function recordingWriteService() {
  const calls: Array<{ op: string; input: unknown }> = [];
  const svc = {
    async create(input: unknown) {
      calls.push({ op: "create", input });
      return { ...FILE, name: (input as { name: string }).name, version: 0 };
    },
    async replace(input: unknown) {
      calls.push({ op: "replace", input });
      return { ...FILE, version: 3 };
    },
    async delete(input: unknown) {
      calls.push({ op: "delete", input });
    },
  };
  return { svc: svc as unknown as ServingDeps["writeService"], calls };
}

function writeDeps(over: Partial<ServingDeps> = {}): { d: ServingDeps; calls: Array<{ op: string; input: unknown }>; authzOps: GfsPermission[] } {
  const { svc, calls } = recordingWriteService();
  const authzOps: GfsPermission[] = [];
  const d = deps({
    verifyToken: () => AGENT_CLAIMS,
    authorize: async (_ctx, _rid, op) => {
      authzOps.push(op);
      return { allowed: true };
    },
    writeService: svc,
    ...over,
  });
  return { d, calls, authzOps };
}

describe("GfsServingHandler — write routes (governed mutation)", () => {
  it("keeps linked actor, effective admin, token subject, and request id distinct through publication", async () => {
    const desktopUserId = "11111111-1111-4111-8111-111111111111";
    const controlAdminId = "22222222-2222-4222-8222-222222222222";
    const requestId = "33333333-3333-4333-8333-333333333333";
    const brokeredAuthority = {
      desktopUserId,
      controlAdminId,
      authoritySource: "linked-admin" as const,
    };
    const linkedClaims: GfsVerifiedClaims = {
      ...USER_WRITE_CLAIMS,
      sub: controlAdminId,
      principalType: "control-admin",
      brokeredAuthority,
    };
    const linkedContext: AuthzContext = {
      drive: "main",
      subjects: ["operator:"],
      isOperator: true,
      primarySubject: controlAdminId,
      effectiveControlAdminId: controlAdminId,
      desktopUserId,
      authoritySource: "linked-admin",
      requestId,
    };
    const { d, calls } = writeDeps({
      verifyToken: () => linkedClaims,
      resolveContext: async (claims, resolvedRequestId) => {
        expect(claims).toEqual({
          sub: controlAdminId,
          drive: "main",
          principalType: "control-admin",
          brokeredAuthority,
        });
        expect(resolvedRequestId).toBe(requestId);
        return linkedContext;
      },
    });
    const request = reqBody(`/v1/resources/${RID}/children`, {
      method: "POST",
      auth: "Bearer t",
      body: { name: "linked.txt", content: "hi" },
    });
    request.headers["x-request-id"] = requestId;

    const res = new FakeRes();
    await run(d, request, res);

    expect(res.statusCode).toBe(201);
    expect(calls[0].input).toMatchObject({
      mutation: {
        subject: controlAdminId,
        requestId,
        actorOnBehalfOf: controlAdminId,
        desktopUserId,
        authoritySource: "linked-admin",
      },
    });
  });

  it("does not expose internal blob keys or physical paths in a failure response", async () => {
    const res = new FakeRes();
    const { d } = writeDeps({
      writeService: {
        create: async () => {
          throw new Error(
            "immutable blob failed: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/11111111-1111-4111-8111-111111111111 at /data/gfs/private"
          );
        },
      } as unknown as ServingDeps["writeService"],
    });
    await run(
      d,
      reqBody(`/v1/resources/${RID}/children`, {
        method: "POST",
        auth: "Bearer t",
        body: { name: "n.txt", content: "hi" },
      }),
      res
    );
    expect(res.statusCode).toBe(500);
    expect(res.json).toEqual({
      ok: false,
      error: { code: "internal", message: "internal server error" },
    });
    expect(res.body).not.toContain("11111111-1111-4111-8111-111111111111");
    expect(res.body).not.toContain("/data/gfs/private");
  });

  it("201 create (POST children) authorizes WRITE on the parent and calls the write service", async () => {
    const res = new FakeRes();
    const { d, calls, authzOps } = writeDeps();
    await run(
      d,
      reqBody(`/v1/resources/${RID}/children`, { method: "POST", auth: "Bearer t", body: { name: "n.txt", content: "hi" } }),
      res
    );
    expect(res.statusCode).toBe(201);
    expect(authzOps).toEqual(["write"]); // create needs write on the parent
    expect(calls[0].op).toBe("create");
    expect((calls[0].input as { name: string; content: Buffer }).name).toBe("n.txt");
    expect((calls[0].input as { content: Buffer }).content.toString("utf8")).toBe("hi");
  });

  it("201 create directory sends kind=directory without file content", async () => {
    const res = new FakeRes();
    const { d, calls, authzOps } = writeDeps();
    await run(
      d,
      reqBody(`/v1/resources/${RID}/children`, { method: "POST", auth: "Bearer t", body: { name: "docs", kind: "directory" } }),
      res
    );
    expect(res.statusCode).toBe(201);
    expect(authzOps).toEqual(["write"]);
    expect(calls[0].op).toBe("create");
    expect(calls[0].input).toMatchObject({ name: "docs", kind: "directory" });
    expect((calls[0].input as { content?: Buffer }).content).toBeUndefined();
  });

  it.each(["../evil.txt", "..", "", "bad\u0000name"])(
    "400 path_invalid when create name is not a single safe path segment: %j",
    async (name) => {
      const res = new FakeRes();
      const { d, calls, authzOps } = writeDeps();
      await run(
        d,
        reqBody(`/v1/resources/${RID}/children`, {
          method: "POST",
          auth: "Bearer t",
          body: { name, content: "hi" },
        }),
        res
      );

      expect(res.statusCode).toBe(400);
      expect((res.json as { error: { code: string } }).error.code).toBe("path_invalid");
      expect(authzOps).toEqual([]);
      expect(calls).toHaveLength(0);
    }
  );

  it("200 replace (PUT content) by an agent WITH If-Match bumps the file", async () => {
    const res = new FakeRes();
    const { d, calls, authzOps } = writeDeps();
    await run(
      d,
      reqBody(`/v1/resources/${RID}/content`, { method: "PUT", auth: "Bearer t", body: { content: "new", ifMatch: 2 } }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect(authzOps).toEqual(["write"]);
    expect((calls[0].input as { ifMatch: number }).ifMatch).toBe(2);
  });

  it("200 replace accepts encoded file content", async () => {
    const res = new FakeRes();
    const { d, calls } = writeDeps();
    await run(
      d,
      reqBody(`/v1/resources/${RID}/content`, { method: "PUT", auth: "Bearer t", body: { contentBase64: "bmV3", ifMatch: 2 } }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect((calls[0].input as { content: Buffer }).content.toString("utf8")).toBe("new");
  });

  it("200 replace accepts a large (>4.47MB) base64 body without a regex stack overflow", async () => {
    // 5MiB raw -> ~6.99MB base64, well past the ~4.47MB-char threshold where the
    // previous grouped-quantifier regex /(?:[A-Za-z0-9+/]{4})*.../ overflowed V8's
    // regexp backtrack stack (RangeError -> bogus 500 `internal` on any large upload).
    const rawBytes = 5 * 1024 * 1024;
    const largeBase64 = Buffer.alloc(rawBytes, 0x41).toString("base64");
    const res = new FakeRes();
    const { d, calls } = writeDeps();
    await run(
      d,
      reqBody(`/v1/resources/${RID}/content`, {
        method: "PUT",
        auth: "Bearer t",
        body: { contentBase64: largeBase64, ifMatch: 2 },
      }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect((calls[0].input as { content: Buffer }).content.length).toBe(rawBytes);
  });

  it("400 path_invalid for invalid encoded file content", async () => {
    const res = new FakeRes();
    const { d, calls, authzOps } = writeDeps();
    await run(
      d,
      reqBody(`/v1/resources/${RID}/content`, {
        method: "PUT",
        auth: "Bearer t",
        body: { contentBase64: "@@@not-base64@@@", ifMatch: 2 },
      }),
      res
    );
    expect(res.statusCode).toBe(400);
    expect((res.json as { error: { code: string } }).error.code).toBe("path_invalid");
    expect(authzOps).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("413 payload_too_large advertises Connection: close (request body not fully received)", async () => {
    // When readJsonBody aborts mid-stream (body over MAX_WRITE_BODY_BYTES), the
    // client is still sending: the socket cannot be reused and Node will reset
    // it. Without `Connection: close`, a pooling client (undici in control-api's
    // gfs proxy) queues its NEXT request onto the poisoned socket and gets
    // ECONNRESET -> 502 gfsc_unreachable (reproduced live: 413 then-immediate
    // request failed deterministically). Real IncomingMessage semantics:
    // `complete` is false while the body has not been fully received.
    const res = new FakeRes();
    const { d, calls } = writeDeps();
    const oversized = "A".repeat(16 * 1024 * 1024 + 4);
    const request = reqBody(`/v1/resources/${RID}/content`, {
      method: "PUT",
      auth: "Bearer t",
      rawBody: `{"contentBase64":"${oversized}","ifMatch":2}`,
    });
    (request as unknown as { complete: boolean }).complete = false;
    await run(d, request, res);
    expect(res.statusCode).toBe(413);
    expect((res.json as { error: { code: string } }).error.code).toBe("payload_too_large");
    expect(res.headers["Connection"]).toBe("close");
    expect(calls).toHaveLength(0);
  });

  it("does NOT close the connection on an error whose request body WAS fully received", async () => {
    // A fully-consumed body (here: valid JSON, invalid base64) leaves the socket
    // clean — keep-alive must survive, only the mid-stream abort case may close.
    const res = new FakeRes();
    const { d } = writeDeps();
    const request = reqBody(`/v1/resources/${RID}/content`, {
      method: "PUT",
      auth: "Bearer t",
      body: { contentBase64: "@@@not-base64@@@", ifMatch: 2 },
    });
    (request as unknown as { complete: boolean }).complete = true;
    await run(d, request, res);
    expect(res.statusCode).toBe(400);
    expect(res.headers["Connection"]).toBeUndefined();
  });

  it("412 precondition_failed: an AGENT replace WITHOUT If-Match is rejected before the store", async () => {
    const res = new FakeRes();
    const { d, calls } = writeDeps();
    await run(
      d,
      reqBody(`/v1/resources/${RID}/content`, { method: "PUT", auth: "Bearer t", body: { content: "new" } }),
      res
    );
    expect(res.statusCode).toBe(412);
    expect(calls).toHaveLength(0); // never reached the write service
  });

  it("a NON-agent (user) replace WITHOUT If-Match is allowed (agent invariant only)", async () => {
    const res = new FakeRes();
    const { d, calls } = writeDeps({ verifyToken: () => USER_WRITE_CLAIMS });
    await run(
      d,
      reqBody(`/v1/resources/${RID}/content`, { method: "PUT", auth: "Bearer t", body: { content: "new" } }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect(calls[0].op).toBe("replace");
  });

  it("DELETE authorizes the destructive DELETE bit (not write)", async () => {
    const res = new FakeRes();
    const { d, authzOps } = writeDeps();
    await run(
      d,
      reqBody(`/v1/resources/${RID}`, { method: "DELETE", auth: "Bearer t", body: { ifMatch: 2 } }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect(authzOps).toEqual(["delete"]); // destructive bit, agents default-denied
  });

  it("403 when the store denies the write — the write service is never called", async () => {
    const res = new FakeRes();
    const { svc, calls } = recordingWriteService();
    const d = deps({ verifyToken: () => AGENT_CLAIMS, authorize: async () => ({ allowed: false }), writeService: svc });
    await run(
      d,
      reqBody(`/v1/resources/${RID}/children`, { method: "POST", auth: "Bearer t", body: { name: "x", content: "y" } }),
      res
    );
    expect(res.statusCode).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("404 when a write hits a server with NO write service (verb not served, not a silent no-op)", async () => {
    const res = new FakeRes();
    // default deps() has no writeService
    await run(
      deps({ verifyToken: () => AGENT_CLAIMS }),
      reqBody(`/v1/resources/${RID}/children`, { method: "POST", auth: "Bearer t", body: { name: "x", content: "y" } }),
      res
    );
    expect(res.statusCode).toBe(404);
  });

  it("400 path_invalid when create is missing a required body field", async () => {
    const res = new FakeRes();
    const { d } = writeDeps();
    await run(
      d,
      reqBody(`/v1/resources/${RID}/children`, { method: "POST", auth: "Bearer t", body: { content: "no name" } }),
      res
    );
    expect(res.statusCode).toBe(400);
    expect((res.json as { error: { code: string } }).error.code).toBe("path_invalid");
  });
});
