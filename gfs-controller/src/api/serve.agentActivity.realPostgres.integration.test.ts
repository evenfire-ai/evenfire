import type { IncomingMessage } from "node:http";
import { Readable, Writable } from "node:stream";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { GfsVerifiedClaims } from "../auth/verify";
import type { AuditEvent, AuditSink } from "../authz/audit";
import type { AuthzContext } from "../authz/permissionClient";
import { recordManagedMutation } from "../db/managedMutationAudit";
import { recordAgentFileActivity } from "../db/userFileActivity";
import { PgTransactor, type CopyInput, type CreateInput, type GfsWriteService } from "../db/writeStore";
import { RateLimiter } from "../quota/rateLimit";
import type { CopyDestinationSnapshot, CopySnapshotNode } from "./copy";
import type { GfsResource } from "./read";
import { GfsServingHandler, type ServingDeps } from "./serve";

/**
 * An agent's activity row must commit with the file it names and roll back with
 * it. The unit suite scripts the client, so it cannot see which connection the
 * record runs on. These cases run the real recorder on a real PostgreSQL
 * transaction: the success cases hold the only pool connection, which reproduces
 * the production deadlock when the record asks the pool for a second one, and
 * the rollback cases use `nextval` as a witness that survives the rollback.
 */
const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL;
const describeRealPostgres = adminUrl ? describe : describe.skip;

function databaseUrl(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

const HOST = "host:1st:mcp-host/chatllm";
const RUN = "11111111-1111-4111-8111-111111111111";
const REQUEST = "33333333-3333-4333-8333-333333333333";
const RID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const PARENT = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const ROOT = "00000000-0000-4000-8000-000000000001";
const DEST = "00000000-0000-4000-8000-000000000002";
const SOURCE = "00000000-0000-4000-8000-000000000003";
const COPIED = [
  "10000000-0000-4000-8000-000000000001",
  "10000000-0000-4000-8000-000000000002",
];

const CLAIMS: GfsVerifiedClaims = {
  sub: HOST,
  drive: "main",
  scopes: ["gfs.read", "gfs.write"],
  pathBindings: [],
  iat: 0,
  exp: 0,
};
const CONTEXT: AuthzContext = {
  drive: "main",
  subjects: [HOST],
  isOperator: false,
  primarySubject: HOST,
  requestId: REQUEST,
};

const CREATE_RESOURCE: GfsResource = {
  resourceId: RID,
  drive: "main",
  parentResourceId: PARENT,
  name: "file.txt",
  kind: "file",
  pathCache: "/file.txt",
  version: 1,
  bytes: 5,
  blobKey: null,
  contentSha256: null,
  deletedAt: null,
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const SOURCE_ROOT: CopySnapshotNode = {
  resourceId: SOURCE,
  drive: "main",
  parentResourceId: ROOT,
  name: "source",
  kind: "directory",
  pathCache: "/source",
  version: 2,
  bytes: 0n,
  blobKey: null,
  contentSha256: null,
  deletedAt: null,
  depth: 0,
  cycle: false,
  underTombstone: false,
};
const SNAPSHOT: CopySnapshotNode[] = [
  SOURCE_ROOT,
  {
    ...SOURCE_ROOT,
    resourceId: COPIED[0]!,
    parentResourceId: SOURCE,
    name: "a.txt",
    kind: "file",
    pathCache: "/source/a.txt",
    version: 1,
    bytes: 5n,
    depth: 1,
  },
  {
    ...SOURCE_ROOT,
    resourceId: COPIED[1]!,
    parentResourceId: SOURCE,
    name: "b.txt",
    kind: "file",
    pathCache: "/source/b.txt",
    version: 1,
    bytes: 5n,
    depth: 1,
  },
];
const DESTINATION: CopyDestinationSnapshot = {
  ancestors: [
    {
      ...SOURCE_ROOT,
      resourceId: DEST,
      parentResourceId: ROOT,
      name: "archive",
      pathCache: "/archive",
      version: 1,
    },
    {
      ...SOURCE_ROOT,
      resourceId: ROOT,
      parentResourceId: null,
      name: "",
      pathCache: "/",
      version: 0,
      depth: 1,
    },
  ],
  liveChildren: [],
};
const COPY_RESULT = {
  root: {
    ...CREATE_RESOURCE,
    resourceId: "10000000-0000-4000-8000-000000000003",
    parentResourceId: DEST,
    name: "copy",
    kind: "directory" as const,
    pathCache: "/archive/copy",
    version: 0,
    bytes: 0,
  },
  requestId: REQUEST,
  objectCount: SNAPSHOT.length,
  fileCount: 2,
  folderCount: 1,
  totalBytes: 10n,
};

const COPY_SUCCEEDED: AuditEvent = {
  recordType: "mutation_outcome",
  subject: HOST,
  op: "copy",
  resourceId: SOURCE,
  drive: "main",
  outcome: "allow",
  requestId: REQUEST,
  matchedSubject: null,
  authorizationSource: null,
  cachedAuthorizationSource: null,
  mutationOutcome: "succeeded",
};

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
}

function mutationRequest(url: string, body: unknown): IncomingMessage {
  const stream = Readable.from([
    Buffer.from(JSON.stringify(body), "utf8"),
  ]) as unknown as IncomingMessage;
  stream.url = url;
  stream.method = "POST";
  stream.headers = {
    authorization: "Bearer t",
    "content-type": "application/json",
    "x-request-id": REQUEST,
    "x-gfs-attribution-run": RUN,
  };
  return stream;
}

function createRequest(): IncomingMessage {
  return mutationRequest(`/v1/resources/${PARENT}/children?drive=main`, {
    name: "file.txt",
    kind: "file",
    content: "aGVsbG8=",
  });
}

function copyRequest(): IncomingMessage {
  return mutationRequest("/v1/copy", {
    drive: "main",
    sourceResourceId: SOURCE,
    destinationParentId: DEST,
    newName: "copy",
    ifMatch: 2,
  });
}

/** Records every event and resolves, so the publication commits. */
function recordingAudit(events: AuditEvent[]): AuditSink {
  return {
    record: async (event) => {
      events.push(event);
    },
  };
}

/** Throws on the success event: a real post-hook failure on the same path. */
function failingSucceededAudit(events: AuditEvent[]): AuditSink {
  return {
    record: async (event) => {
      events.push(event);
      if (event.mutationOutcome === "succeeded") throw new Error("audit append failed");
    },
  };
}

function baseDeps(pool: Pool, writeService: GfsWriteService): ServingDeps {
  return {
    verifyToken: () => CLAIMS,
    resolveContext: async () => CONTEXT,
    authorize: async () => ({ allowed: true }),
    store: { getResource: async () => null, listChildren: async () => [] },
    blobs: { read: async () => Readable.from([]) },
    writeService,
    rateLimit: {
      reads: new RateLimiter({ limit: 1_000_000, windowMs: 60_000 }),
      writes: new RateLimiter({ limit: 1_000_000, windowMs: 60_000 }),
    },
    now: () => 0,
    agentActivity: {
      recordRead: (hostSubject, runId, resourceIds) =>
        recordAgentFileActivity(pool, hostSubject, runId, resourceIds),
    },
  };
}

/** The create publication: hook, then the managed-mutation audit, then COMMIT. */
function createHandler(pool: Pool, audit: AuditSink): GfsServingHandler {
  const writeService = {
    create: async (input: CreateInput) =>
      new PgTransactor(pool).transaction(async (client) => {
        await input.onPublished?.(client, CREATE_RESOURCE, input.signal);
        await recordManagedMutation(
          input.mutation,
          { op: "create", resourceId: RID, drive: "main" },
          "succeeded",
          undefined,
          client,
        );
        return CREATE_RESOURCE;
      }),
  } as unknown as GfsWriteService;
  return new GfsServingHandler({ ...baseDeps(pool, writeService), audit });
}

/** The copy publication: hook with every copied file, then the success audit. */
function copyHandler(pool: Pool, audit: AuditSink): GfsServingHandler {
  const writeService = {
    copy: async (input: CopyInput) =>
      new PgTransactor(pool).transaction(async (client) => {
        const copiedFileIds = input.plan.nodes
          .filter((node) => node.kind === "file")
          .map((node) => node.resourceId);
        await input.onPublished?.(client, copiedFileIds);
        await input.audit.record(COPY_SUCCEEDED, client);
        return COPY_RESULT;
      }),
  } as unknown as GfsWriteService;
  return new GfsServingHandler({
    ...baseDeps(pool, writeService),
    copy: {
      authorizeMany: async (_context, requests) => requests.map(() => ({ allowed: true })),
      permissionEpoch: () => ({ generation: 0, bypassed: false }),
      resources: {
        loadCopyAdmission: async () => ({ sourceRoot: SOURCE_ROOT, destinationParent: DESTINATION.ancestors[0]! }),
        loadCopySnapshot: async () => SNAPSHOT,
        loadCopyDestination: async () => DESTINATION,
      },
      audit,
      maxObjects: 1000,
      maxBytes: 1024 * 1024,
      timeoutMs: 30_000,
    },
  });
}

async function serve(handler: GfsServingHandler, req: IncomingMessage): Promise<FakeRes> {
  const res = new FakeRes();
  await handler.tryHandle(req, res as never);
  return res;
}

interface ActivityRow {
  resourceId: string;
  hostSubject: string;
  runId: string;
}

async function activityRows(db: Pool): Promise<ActivityRow[]> {
  const result = await db.query(
    `SELECT resource_id::text AS resource_id, host_subject, run_id::text AS run_id
       FROM agent_activity_rows ORDER BY resource_id`,
  );
  return result.rows.map((row) => ({
    resourceId: String(row.resource_id),
    hostSubject: String(row.host_subject),
    runId: String(row.run_id),
  }));
}

async function recordedCalls(db: Pool): Promise<bigint> {
  const result = await db.query("SELECT last_value FROM agent_activity_calls");
  return BigInt(String(result.rows[0]?.last_value));
}

describeRealPostgres("agent file activity on the publication transaction", () => {
  const database = `gfsc_agent_activity_${Date.now()}`;
  let adminPool: Pool | undefined;
  let pool: Pool;
  let singlePool: Pool;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl });
    await adminPool.query(`CREATE DATABASE ${database}`);
    const url = databaseUrl(adminUrl as string, database);
    pool = new Pool({ connectionString: url, max: 4 });
    // The production deadlock, with no cheaper reproducer: the write transaction
    // holds the only connection, so a record that checks a second one out of the
    // pool cannot proceed. A bounded timeout turns a hang into a red assertion.
    singlePool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 2_000 });
    // Stand-in for the real function: same contract (status text, one row per
    // resource id). The function body is covered by control-api's real-PG suite.
    await pool.query(`
      CREATE TABLE agent_activity_rows (
        resource_id uuid NOT NULL,
        host_subject text NOT NULL,
        run_id uuid NOT NULL
      );
      CREATE SEQUENCE agent_activity_calls;
      CREATE FUNCTION public.gfs_record_agent_file_activity(
        p_host_subject text, p_run_id uuid, p_resource_ids uuid[]
      ) RETURNS text LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM nextval('agent_activity_calls');
        INSERT INTO agent_activity_rows
          SELECT u, p_host_subject, p_run_id FROM unnest(p_resource_ids) AS u;
        RETURN 'recorded';
      END $$;
    `);
    // last_value only proves an advance after the first nextval; prime it so
    // each case measures its own delta.
    await pool.query("SELECT nextval('agent_activity_calls')");
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE agent_activity_rows");
  });

  afterAll(async () => {
    await singlePool?.end();
    await pool?.end();
    if (!adminPool) return;
    await adminPool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [database],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${database}`);
    await adminPool.end();
  });

  it("R1: an agent create whose publication rolls back leaves no activity row", async () => {
    const events: AuditEvent[] = [];
    const handler = createHandler(pool, failingSucceededAudit(events));
    const callsBefore = await recordedCalls(pool);

    const res = await serve(handler, createRequest());

    expect(res.statusCode).toBe(500);
    // The managed-mutation audit threw after the hook: the transaction rolled
    // back, so the row that names the file never committed.
    expect(events.filter((event) => event.mutationOutcome === "succeeded")).toHaveLength(1);
    expect(await activityRows(pool)).toEqual([]);
    // nextval is not transactional: the record DID run inside the transaction.
    expect(await recordedCalls(pool)).toBe(callsBefore + 1n);
  });

  it("R2: an agent create succeeds while its transaction holds the only connection", async () => {
    const handler = createHandler(singlePool, recordingAudit([]));

    const res = await serve(handler, createRequest());

    expect(res.statusCode).toBe(201);
    expect(await activityRows(pool)).toEqual([{ resourceId: RID, hostSubject: HOST, runId: RUN }]);
  });

  it("R3: an agent copy whose publication rolls back leaves no activity row", async () => {
    const events: AuditEvent[] = [];
    const handler = copyHandler(pool, failingSucceededAudit(events));
    const callsBefore = await recordedCalls(pool);

    const res = await serve(handler, copyRequest());

    expect(res.statusCode).toBe(500);
    expect(events.filter((event) => event.mutationOutcome === "succeeded")).toHaveLength(1);
    expect(await activityRows(pool)).toEqual([]);
    expect(await recordedCalls(pool)).toBe(callsBefore + 1n);
  });

  it("R4: an agent copy succeeds while its transaction holds the only connection", async () => {
    const handler = copyHandler(singlePool, recordingAudit([]));

    const res = await serve(handler, copyRequest());

    expect(res.statusCode).toBe(201);
    expect(await activityRows(pool)).toEqual([
      { resourceId: COPIED[0], hostSubject: HOST, runId: RUN },
      { resourceId: COPIED[1], hostSubject: HOST, runId: RUN },
    ]);
  });
});
