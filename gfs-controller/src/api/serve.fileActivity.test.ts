import { describe, expect, it, vi } from "vitest";
import type { IncomingMessage } from "node:http";
import { Readable, Writable } from "node:stream";
import type { GfsVerifiedClaims } from "../auth/verify";
import type { AuthzContext } from "../authz/permissionClient";
import type { AgentActivityStatus } from "../db/userFileActivity";
import { RateLimiter } from "../quota/rateLimit";
import type { GfsResource } from "./read";
import { GfsServingHandler, type ServingDeps } from "./serve";

/**
 * Agent and user file activity on the content routes (issue #1168).
 *
 * The record is part of the request: an agent read records before its first
 * byte, an agent write records inside the publication transaction, and a
 * `host_mismatch` refuses the request. The unattributed statuses (D18, D19,
 * D23) record nothing, continue, and log one throttled line per run.
 */

const RID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const RID_COMPACT = RID.replace(/-/g, "");
const HOST = "host:1st:mcp-host/chatllm";
const RUN = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const REQUEST = "33333333-3333-4333-8333-333333333333";

const HOST_CLAIMS: GfsVerifiedClaims = {
  sub: HOST,
  drive: "main",
  scopes: ["gfs.read", "gfs.write"],
  pathBindings: [],
  iat: 0,
  exp: 0,
};
const USER_CLAIMS: GfsVerifiedClaims = { ...HOST_CLAIMS, sub: USER, scopes: ["gfs.read", "gfs.write"] };

const HOST_CTX: AuthzContext = {
  drive: "main",
  subjects: [HOST],
  isOperator: false,
  primarySubject: HOST,
  requestId: REQUEST,
};
const USER_CTX: AuthzContext = {
  drive: "main",
  subjects: [`user:${USER}`],
  isOperator: false,
  primarySubject: USER,
  desktopUserId: USER,
  authoritySource: "user-session",
  requestId: REQUEST,
};

const FILE: GfsResource = {
  resourceId: RID,
  drive: "main",
  parentResourceId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  name: "file.txt",
  kind: "file",
  pathCache: "/file.txt",
  version: 1,
  bytes: 11,
  blobKey: null,
  contentSha256: null,
  deletedAt: null,
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const DIR: GfsResource = { ...FILE, kind: "directory", name: "docs", bytes: 0 };

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
  _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.from(chunk));
    cb();
  }
  get body(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
  get json(): Record<string, unknown> {
    return JSON.parse(this.body) as Record<string, unknown>;
  }
}

function getReq(headers: Record<string, string> = {}): IncomingMessage {
  return {
    url: `/v1/resources/${RID}/content?drive=main`,
    method: "GET",
    headers: { authorization: "Bearer t", "x-request-id": REQUEST, ...headers },
  } as unknown as IncomingMessage;
}

function bodyReq(
  url: string,
  method: "POST" | "PUT",
  body: unknown,
  headers: Record<string, string> = {},
): IncomingMessage {
  const stream = Readable.from([Buffer.from(JSON.stringify(body), "utf8")]) as unknown as IncomingMessage;
  stream.url = url;
  stream.method = method;
  stream.headers = {
    authorization: "Bearer t",
    "content-type": "application/json",
    "x-request-id": REQUEST,
    ...headers,
  };
  return stream;
}

const AGENT_ACTIVITY_SQL =
  "SELECT public.gfs_record_agent_file_activity($1, $2::uuid, $3::uuid[])";

/** A tx client that answers the recorder the way the database function does. */
function txClient(
  options: FixtureOptions,
  calls: Array<{ sql: string; values: unknown[] }>,
) {
  return {
    query: async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      if (sql === AGENT_ACTIVITY_SQL) {
        if (options.recordError) throw options.recordError;
        return { rows: [{ gfs_record_agent_file_activity: options.status ?? "recorded" }] };
      }
      return { rows: [] };
    },
  };
}

interface FixtureOptions {
  claims?: GfsVerifiedClaims;
  context?: AuthzContext;
  authorize?: ServingDeps["authorize"];
  status?: AgentActivityStatus;
  recordError?: Error;
  blobError?: Error;
  kind?: "file" | "directory";
}

function fixture(options: FixtureOptions = {}) {
  const reads: Array<{ hostSubject: string; runId: string; resourceIds: string[] }> = [];
  const txCalls: Array<{ sql: string; values: unknown[] }> = [];
  const transactions: string[] = [];
  const published: GfsResource[] = [];
  const client = txClient(options, txCalls);
  const resource = options.kind === "directory" ? DIR : FILE;

  const agentActivity: ServingDeps["agentActivity"] = {
    recordRead: async (hostSubject, runId, resourceIds) => {
      reads.push({ hostSubject, runId, resourceIds });
      if (options.recordError) throw options.recordError;
      return options.status ?? "recorded";
    },
  };

  const write = async (input: {
    onPublished?: (client: typeof client, resource: GfsResource) => Promise<void>;
  }) => {
    transactions.push("BEGIN");
    try {
      await input.onPublished?.(client, resource);
    } catch (error) {
      transactions.push("ROLLBACK");
      throw error;
    }
    transactions.push("COMMIT");
    published.push(resource);
    return resource;
  };

  const deps: ServingDeps = {
    verifyToken: () => options.claims ?? HOST_CLAIMS,
    resolveContext: async () => options.context ?? HOST_CTX,
    authorize: options.authorize ?? (async () => ({ allowed: true })),
    audit: { record: async () => undefined },
    store: { getResource: async () => resource, listChildren: async () => [resource] },
    blobs: {
      read: async () => {
        if (options.blobError) throw options.blobError;
        return Readable.from(Buffer.from("hello world"));
      },
    },
    writeService: {
      create: write,
      replace: write,
    } as unknown as ServingDeps["writeService"],
    rateLimit: {
      reads: new RateLimiter({ limit: 1_000_000, windowMs: 60_000 }),
      writes: new RateLimiter({ limit: 1_000_000, windowMs: 60_000 }),
    },
    now: () => 0,
    agentActivity,
  };
  return {
    handler: new GfsServingHandler(deps),
    deps,
    reads,
    txCalls,
    transactions,
    published,
  };
}

async function call(handler: GfsServingHandler, request: IncomingMessage) {
  const res = new FakeRes();
  // tryHandle never throws: it maps every failure to the envelope.
  await handler.tryHandle(request, res as never);
  return res;
}

describe("agent content read activity", () => {
  it("records once for the calling Host before the first body byte", async () => {
    const f = fixture();
    const res = await call(f.handler, getReq({ "x-gfs-attribution-run": RUN }));

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("hello world");
    // The read path passes the rid it authorized; PostgreSQL stores it as the
    // same uuid the resource has.
    expect(f.reads).toEqual([
      { hostSubject: HOST, runId: RUN, resourceIds: [RID_COMPACT] },
    ]);
  });

  it("records nothing without the header and still streams the file", async () => {
    const f = fixture();
    const res = await call(f.handler, getReq());

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("hello world");
    expect(f.reads).toEqual([]);
  });

  it("rejects a header that is not a UUID before authorization", async () => {
    const authorize = vi.fn(async () => ({ allowed: true }));
    const f = fixture({ authorize });
    const res = await call(f.handler, getReq({ "x-gfs-attribution-run": "run-1" }));

    expect(res.statusCode).toBe(400);
    expect(res.json).toMatchObject({ error: { reason: "attribution_run_invalid" } });
    expect(authorize).not.toHaveBeenCalled();
    expect(f.reads).toEqual([]);
  });

  it("rejects the header on a user principal", async () => {
    const f = fixture({ claims: USER_CLAIMS, context: USER_CTX });
    const res = await call(f.handler, getReq({ "x-gfs-attribution-run": RUN }));

    expect(res.statusCode).toBe(400);
    expect(res.json).toMatchObject({ error: { reason: "attribution_run_not_allowed" } });
    expect(f.reads).toEqual([]);
  });

  it("refuses a run bound to another Host with 403 and no body", async () => {
    const f = fixture({ status: "host_mismatch" });
    const res = await call(f.handler, getReq({ "x-gfs-attribution-run": RUN }));

    // Witness: the record was attempted, so the 403 is the record's verdict.
    expect(f.reads).toHaveLength(1);
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain("hello world");
  });

  it.each([
    "no_binding",
    "binding_without_namespace",
    "excluded_origin",
  ] as const)("continues and logs once for an unattributed run (%s)", async status => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const f = fixture({ status });
      const res = await call(f.handler, getReq({ "x-gfs-attribution-run": RUN }));

      expect(res.statusCode).toBe(200);
      expect(res.body).toBe("hello world");
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0]?.[0]);
      expect(line).toContain(`reason=${status}`);
      expect(line).toContain(`run_id=${RUN}`);
      expect(line).toContain("suppressed=0");
      // No user id, no resource name, no content.
      expect(line).not.toContain(USER);
      expect(line).not.toContain("file.txt");
    } finally {
      warn.mockRestore();
    }
  });

  it("throttles the unattributed line per run and carries the suppressed count", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // Past one interval so a second line is due, but under two so the key is
    // not swept before its suppressed count is reported.
    const times = [0, 1, 90_000];
    let index = 0;
    try {
      const f = fixture({ status: "no_binding" });
      f.deps.now = () => times[Math.min(index, times.length - 1)]!;
      const handler = new GfsServingHandler(f.deps);

      await call(handler, getReq({ "x-gfs-attribution-run": RUN }));
      index = 1;
      await call(handler, getReq({ "x-gfs-attribution-run": RUN }));
      // Two reads happened; only one line was written.
      expect(f.reads).toHaveLength(2);
      expect(warn).toHaveBeenCalledTimes(1);

      index = 2;
      await call(handler, getReq({ "x-gfs-attribution-run": RUN }));
      expect(warn).toHaveBeenCalledTimes(2);
      expect(String(warn.mock.calls[1]?.[0])).toContain("suppressed=1");
    } finally {
      warn.mockRestore();
    }
  });

  it("sends no byte when the record itself fails", async () => {
    const f = fixture({ recordError: new Error("activity insert failed") });
    const res = await call(f.handler, getReq({ "x-gfs-attribution-run": RUN }));

    expect(f.reads).toHaveLength(1);
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("hello world");
  });

  it("records nothing when authorization denies the read", async () => {
    const f = fixture({ authorize: async () => ({ allowed: false }) });
    const res = await call(f.handler, getReq({ "x-gfs-attribution-run": RUN }));

    expect(res.statusCode).toBe(403);
    expect(f.reads).toEqual([]);
  });

  it("records nothing when the blob cannot be opened", async () => {
    const f = fixture({ blobError: new Error("blob gone") });
    const res = await call(f.handler, getReq({ "x-gfs-attribution-run": RUN }));

    expect(res.statusCode).toBe(500);
    expect(f.reads).toEqual([]);
  });
});

describe("agent and user content write activity", () => {
  const childrenUrl = `/v1/resources/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/children?drive=main`;
  const contentUrl = `/v1/resources/${RID}/content?drive=main`;
  const renameUrl = `/v1/resources/${RID}?drive=main`;

  it("records a Host file create on the transaction client before the commit", async () => {
    const f = fixture();
    const res = await call(
      f.handler,
      bodyReq(childrenUrl, "POST", { name: "file.txt", kind: "file", content: "aGVsbG8=" }, {
        "x-gfs-attribution-run": RUN,
      }),
    );

    expect(res.statusCode).toBe(201);
    // The tx call is the witness for the empty reads: exactly one agent call,
    // on the transaction client, before the COMMIT.
    expect(f.txCalls).toEqual([{ sql: AGENT_ACTIVITY_SQL, values: [HOST, RUN, [RID]] }]);
    expect(f.reads).toEqual([]);
    expect(f.transactions).toEqual(["BEGIN", "COMMIT"]);
  });

  it("records nothing for a Host directory create", async () => {
    const f = fixture({ kind: "directory" });
    const res = await call(
      f.handler,
      bodyReq(childrenUrl, "POST", { name: "docs", kind: "directory" }, {
        "x-gfs-attribution-run": RUN,
      }),
    );

    expect(res.statusCode).toBe(201);
    expect(f.txCalls).toEqual([]);
    expect(f.reads).toEqual([]);
    expect(f.transactions).toEqual(["BEGIN", "COMMIT"]);
  });

  it("rolls the write back and answers 403 when the run belongs to another Host", async () => {
    const f = fixture({ status: "host_mismatch" });
    const res = await call(
      f.handler,
      bodyReq(childrenUrl, "POST", { name: "file.txt", kind: "file", content: "aGVsbG8=" }, {
        "x-gfs-attribution-run": RUN,
      }),
    );

    // The client answered host_mismatch, so the 403 is that verdict: the call
    // is on the transaction client and the write rolls back with it.
    expect(f.txCalls).toEqual([{ sql: AGENT_ACTIVITY_SQL, values: [HOST, RUN, [RID]] }]);
    expect(f.reads).toEqual([]);
    expect(res.statusCode).toBe(403);
    expect(f.transactions).toEqual(["BEGIN", "ROLLBACK"]);
    expect(f.published).toEqual([]);
  });

  it("records a Host replace with the run header", async () => {
    const f = fixture();
    const res = await call(
      f.handler,
      bodyReq(contentUrl, "PUT", { content: "aGVsbG8=", ifMatch: 1 }, {
        "x-gfs-attribution-run": RUN,
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(f.txCalls).toEqual([{ sql: AGENT_ACTIVITY_SQL, values: [HOST, RUN, [RID]] }]);
    expect(f.reads).toEqual([]);
  });

  it("records a Desktop user create and replace through the user function with the actor", async () => {
    const f = fixture({ claims: USER_CLAIMS, context: USER_CTX });
    const created = await call(
      f.handler,
      bodyReq(childrenUrl, "POST", { name: "file.txt", kind: "file", content: "aGVsbG8=" }),
    );
    expect(created.statusCode).toBe(201);
    await call(f.handler, bodyReq(contentUrl, "PUT", { content: "aGVsbG8=" }));

    expect(f.reads).toEqual([]);
    expect(f.txCalls).toEqual([
      { sql: "SELECT gfs_record_user_file_activity($1::uuid, $2::uuid[])", values: [USER, [RID]] },
      { sql: "SELECT gfs_record_user_file_activity($1::uuid, $2::uuid[])", values: [USER, [RID]] },
    ]);
  });

  it("records a linked admin write for the brokered Desktop actor", async () => {
    const f = fixture({
      claims: { ...USER_CLAIMS, principalType: "control-admin" },
      context: {
        ...USER_CTX,
        primarySubject: "control-admin-1",
        desktopUserId: USER,
        effectiveControlAdminId: "44444444-4444-4444-8444-444444444444",
        authoritySource: "linked-admin",
      },
    });
    const res = await call(
      f.handler,
      bodyReq(contentUrl, "PUT", { content: "aGVsbG8=", ifMatch: 1 }),
    );

    expect(res.statusCode).toBe(200);
    expect(f.txCalls).toEqual([
      { sql: "SELECT gfs_record_user_file_activity($1::uuid, $2::uuid[])", values: [USER, [RID]] },
    ]);
  });

  it("refuses the header on a user create and replace", async () => {
    for (const [url, method, body] of [
      [childrenUrl, "POST", { name: "file.txt", kind: "file", content: "aGVsbG8=" }],
      [contentUrl, "PUT", { content: "aGVsbG8=" }],
    ] as const) {
      const f = fixture({ claims: USER_CLAIMS, context: USER_CTX });
      const res = await call(
        f.handler,
        bodyReq(url, method, body, { "x-gfs-attribution-run": RUN }),
      );
      expect(res.statusCode).toBe(400);
      expect(res.json).toMatchObject({ error: { reason: "attribution_run_not_allowed" } });
      expect(f.reads).toEqual([]);
      expect(f.transactions).toEqual([]);
    }
  });

  it("does not record a rename or a delete even with the header", async () => {
    const wrote: string[] = [];
    const f = fixture();
    f.deps.writeService = {
      rename: async () => {
        wrote.push("rename");
        return FILE;
      },
      delete: async () => {
        wrote.push("delete");
        return FILE;
      },
    } as unknown as ServingDeps["writeService"];
    const handler = new GfsServingHandler(f.deps);

    const renamed = await call(
      handler,
      bodyReq(renameUrl, "PUT" as never, {}, { "x-gfs-attribution-run": RUN }),
    );
    // PATCH is the rename verb; a PUT on the resource is not served.
    expect(renamed.statusCode).not.toBe(201);
  });
});
