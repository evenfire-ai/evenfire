import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { preflightCopy, type CopyDestinationSnapshot, type CopySnapshotNode } from "../src/api/copy";
import type { AuditEvent, AuditSink, Queryable } from "../src/authz/audit";
import { PgBlobStagingStore } from "../src/db/blobStaging";
import type { DeadlineBudget } from "../src/db/deadlineQuery";
import { CommitOutcomeUnknownError, GfsWriteService, type BlobWriter, type CopyInput, type Transactor, type TxClient } from "../src/db/writeStore";

export const ROOT = "00000000-0000-4000-8000-000000000001";
export const DEST = "00000000-0000-4000-8000-000000000002";
export const SOURCE = "00000000-0000-4000-8000-000000000003";
export const FILE = "00000000-0000-4000-8000-000000000004";
export const EMPTY = "00000000-0000-4000-8000-000000000005";
export const UNICODE = "00000000-0000-4000-8000-000000000006";
export const REQUEST = "00000000-0000-4000-8000-000000000007";

export function node(over: Partial<CopySnapshotNode> = {}): CopySnapshotNode {
  return { resourceId: SOURCE, drive: "main", parentResourceId: ROOT, name: "source", kind: "directory",
    pathCache: "/source", version: 3, bytes: 0n, blobKey: null, contentSha256: null,
    deletedAt: null, depth: 0, cycle: false, underTombstone: false, ...over };
}

const hello = Buffer.from("hello");
const accent = Buffer.from("café");
export const sourceNodes = (): CopySnapshotNode[] => [
  node(),
  node({ resourceId: FILE, parentResourceId: SOURCE, name: "file.txt", kind: "file", pathCache: "/source/file.txt",
    version: 2, bytes: BigInt(hello.length), blobKey: `${FILE.replaceAll("-", "")}/old`, contentSha256: createHash("sha256").update(hello).digest("hex"), depth: 1 }),
  node({ resourceId: EMPTY, parentResourceId: SOURCE, name: "empty", pathCache: "/source/empty", version: 0, depth: 1 }),
  node({ resourceId: UNICODE, parentResourceId: EMPTY, name: "café.txt", kind: "file", pathCache: "/source/empty/café.txt",
    version: 1, bytes: BigInt(accent.length), blobKey: null, contentSha256: null, depth: 2 }),
];

export const destination = (): CopyDestinationSnapshot => ({
  ancestors: [
    node({ resourceId: DEST, parentResourceId: ROOT, name: "archive", pathCache: "/archive", version: 1 }),
    node({ resourceId: ROOT, parentResourceId: null, name: "", pathCache: "/", version: 0, depth: 1 }),
  ], liveChildren: [],
});

function dbRow(value: CopySnapshotNode): Record<string, unknown> {
  return { resource_id: value.resourceId, drive: value.drive, parent_resource_id: value.parentResourceId,
    name: value.name, kind: value.kind, path_cache: value.pathCache, version: value.version,
    bytes: value.bytes.toString(), blob_key: value.blobKey, content_sha256: value.contentSha256, deleted_at: value.deletedAt,
    updated_at: new Date("2026-01-01T00:00:00.000Z") };
}

export class CopyDb implements TxClient {
  calls: Array<{ sql: string; values: unknown[] }> = [];
  resources = new Map<string, Record<string, unknown>>();
  manifests = new Map<string, "staged" | "committed" | "deleting">();
  failInsert: unknown = null;
  failCommitManifests = false;
  failResourceLookup = false;
  constructor(nodes = sourceNodes(), dest = destination()) {
    for (const value of [...nodes, ...dest.ancestors]) this.resources.set(value.resourceId, dbRow(value));
  }
  async connect() {
    return {
      query: async (sql: string, values: unknown[] = []) => {
        if (sql === "BEGIN" || sql === "BEGIN READ ONLY" || sql === "COMMIT" || sql === "ROLLBACK" || sql.includes("set_config('statement_timeout'")) {
          this.calls.push({ sql, values });
          return { rows: [] };
        }
        return this.query(sql, values);
      },
      release: () => undefined,
    };
  }
  async query(sql: string, values: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    this.calls.push({ sql, values });
    if (sql.includes("INSERT INTO gfs_blob_manifests") && sql.includes("'staged'")) {
      this.manifests.set(String(values[0]), "staged"); return { rows: [] };
    }
    if (sql.includes("UPDATE gfs_blob_manifests") && sql.includes("state = 'committed'")) {
      if (this.failCommitManifests) throw new Error("manifest commit failed");
      const keys = values[1] as string[];
      for (const key of keys) this.manifests.set(key, "committed");
      return { rows: keys.map(blob_key => ({ blob_key })) };
    }
    if (sql.includes("DELETE FROM gfs_blob_manifests") && sql.includes("state = 'committed'")) {
      const keys = values[1] as string[];
      for (const key of keys) this.manifests.delete(key);
      return { rows: keys.map(blob_key => ({ blob_key })) };
    }
    if (sql.includes("UPDATE gfs_blob_manifests")) { this.manifests.set(String(values[0]), "deleting"); return { rows: [] }; }
    if (sql.includes("DELETE FROM gfs_blob_manifests")) { this.manifests.delete(String(values[0])); return { rows: [] }; }
    if (sql.includes("pg_advisory_xact_lock") || (sql.includes("FOR UPDATE") && sql.includes("SELECT resource_id"))) return { rows: [] };
    if (sql.includes("WITH RECURSIVE copy_recheck")) return { rows: this.subtree(String(values[1]), String(values[0])) };
    if (sql.includes("resource_id = ANY($2::uuid[])")) {
      if (this.failResourceLookup) throw new Error("database unavailable");
      return { rows: (values[1] as string[]).map(id => this.resources.get(id)).filter(Boolean) as Record<string, unknown>[] };
    }
    if (sql.includes("parent_resource_id = $2") && sql.includes("deleted_at IS NULL")) {
      return { rows: [...this.resources.values()].filter(row => row.drive === values[0] && row.parent_resource_id === values[1] && row.deleted_at == null && row.name === values[2])
        .map(row => ({ resource_id: row.resource_id, name: row.name })) };
    }
    if (sql.includes("INSERT INTO gfs_resources")) return this.insert(sql, values);
    if (sql.includes("INSERT INTO gfs_audit")) return { rows: [] };
    throw new Error(`unexpected query: ${sql}`);
  }
  private subtree(root: string, drive: string): Record<string, unknown>[] {
    const start = this.resources.get(root);
    if (!start || start.drive !== drive) return [];
    const output: Record<string, unknown>[] = [];
    const children = new Map<string, Record<string, unknown>[]>();
    for (const candidate of this.resources.values()) {
      if (candidate.drive !== drive || candidate.parent_resource_id == null) continue;
      const parentId = String(candidate.parent_resource_id);
      const siblings = children.get(parentId) ?? [];
      siblings.push(candidate);
      children.set(parentId, siblings);
    }
    const queue: Array<{ row: Record<string, unknown>; depth: number; visited: Set<string>; under: boolean }> = [
      { row: start, depth: 0, visited: new Set([root]), under: false },
    ];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const currentId = String(current.row.resource_id);
      const decorated = { ...current.row, depth: current.depth, cycle: false, under_tombstone: current.under };
      if (current.depth === 0 || current.row.deleted_at == null) output.push(decorated);
      for (const child of children.get(currentId) ?? []) {
        const childId = String(child.resource_id);
        const cycle = current.visited.has(childId);
        const under = current.under || child.deleted_at != null;
        if (cycle) {
          if (child.deleted_at == null) output.push({ ...child, depth: current.depth + 1, cycle: true, under_tombstone: under });
        } else {
          queue.push({ row: child, depth: current.depth + 1, visited: new Set([...current.visited, childId]), under });
        }
      }
    }
    return output;
  }
  private insert(sql: string, values: unknown[]): { rows: Record<string, unknown>[] } {
    if (this.failInsert) throw this.failInsert;
    const rows: Record<string, unknown>[] = [];
    const inserted = sql.includes("jsonb_to_recordset")
      ? JSON.parse(String(values[0])) as Record<string, unknown>[]
      : Array.from({ length: values.length / 10 }, (_, index) => {
        const offset = index * 10;
        return { resource_id: values[offset], drive: values[offset + 1], parent_resource_id: values[offset + 2],
          name: values[offset + 3], kind: values[offset + 4], path_cache: values[offset + 5], bytes: values[offset + 6],
          blob_key: values[offset + 7], content_sha256: values[offset + 8], version: values[offset + 9] };
      });
    for (const value of inserted) {
      const row = {
        ...value,
        bytes: Number(value.bytes),
        deleted_at: null,
        updated_at: new Date("2026-01-01T00:00:00.000Z"),
      };
      this.resources.set(String(row.resource_id), row); rows.push(row);
    }
    return { rows };
  }
}

export class CopyBlobs implements BlobWriter {
  capacity = 1024n;
  capacityCalls = 0;
  writes: string[] = [];
  reads: string[] = [];
  deletes: string[] = [];
  failWriteAt = 0;
  private readonly source = new Map<string, Buffer>([[FILE, hello], [UNICODE, accent]]);
  async availableBytes(): Promise<bigint> { this.capacityCalls += 1; return this.capacity; }
  async read(resourceId: string): Promise<Readable> { this.reads.push(resourceId); return Readable.from(this.source.get(resourceId) ?? Buffer.alloc(0)); }
  async writeImmutable(resourceId: string, generation: string, data: Readable | Buffer) {
    const chunks: Buffer[] = [];
    for await (const chunk of Buffer.isBuffer(data) ? Readable.from(data) : data) chunks.push(Buffer.from(chunk));
    if (this.failWriteAt === this.writes.length + 1) throw Object.assign(new Error("no space"), { code: "ENOSPC" });
    const value = Buffer.concat(chunks);
    const blobKey = `${resourceId.replaceAll("-", "")}/${generation}`;
    this.writes.push(blobKey);
    return { blobKey, bytes: value.length, contentSha256: createHash("sha256").update(value).digest("hex") };
  }
  async verify(): Promise<void> {}
  async deleteByKey(key: string): Promise<void> { this.deletes.push(key); }
  async deleteLegacyFlat(): Promise<void> {}
}

export class CopyAudit implements AuditSink {
  records: Array<{ event: AuditEvent; transactional: boolean }> = [];
  persisted: AuditEvent[] = [];
  failTransactional = false;
  failOutside = false;
  async record(event: AuditEvent, queryable?: Queryable, _budget?: DeadlineBudget): Promise<void> {
    this.records.push({ event, transactional: queryable !== undefined });
    if (queryable && this.failTransactional) throw new Error("success audit failed");
    if (!queryable && this.failOutside) throw new Error("failure audit failed");
    if (queryable) await queryable.query("INSERT INTO gfs_audit (record_type) VALUES ('mutation_outcome')");
    this.persisted.push(event);
  }
}

export function copyFixture(options: {
  ambiguity?: "full" | "zero" | "subset";
  inspectUnavailable?: boolean;
  nodes?: CopySnapshotNode[];
  maxObjects?: number;
  abortOnAmbiguity?: boolean;
} = {}) {
  const nodes = options.nodes ?? sourceNodes();
  const dest = destination();
  const db = new CopyDb(nodes, dest);
  const blobs = new CopyBlobs();
  const audit = new CopyAudit();
  const snapshot = (): Map<string, Record<string, unknown>> =>
    new Map([...db.resources].map(([key, value]) => [key, { ...value }]));
  let ambiguityThrown = false;
  const ambiguityAbort = new AbortController();
  const tx: Transactor = { transaction: async fn => {
    const before = snapshot();
    const manifests = new Map(db.manifests);
    let value: Awaited<ReturnType<typeof fn>>;
    try { value = await fn(db); } catch (error) {
      db.resources = before; db.manifests = manifests; throw error;
    }
    const inserted = [...db.resources.keys()].filter(key => !before.has(key));
    if (options.ambiguity && inserted.length > 0 && !ambiguityThrown) {
      ambiguityThrown = true;
      if (options.ambiguity === "zero") db.resources = before;
      if (options.ambiguity === "subset") for (const id of inserted.slice(1)) db.resources.delete(id);
      if (options.inspectUnavailable) db.failResourceLookup = true;
      if (options.abortOnAmbiguity) ambiguityAbort.abort();
      throw new CommitOutcomeUnknownError(new Error("commit response unavailable"));
    }
    return value;
  } };
  let id = 100;
  const next = () => `10000000-0000-4000-8000-${String(id++).padStart(12, "0")}`;
  const writes = new GfsWriteService(tx, blobs, new PgBlobStagingStore(db), {
    resourceId: next, generation: next, requestId: next,
  });
  const plan = preflightCopy({
    drive: "main", sourceResourceId: SOURCE, destinationParentId: DEST, ifMatch: 3,
    snapshot: nodes, destination: dest, maxObjects: options.maxObjects ?? 1000, maxBytes: 1024 * 1024,
    deadlineAtMs: 1000, nowMs: 0,
  });
  const input: CopyInput = {
    requestId: REQUEST, subject: "agent:test", audit, drive: "main", destinationParentId: DEST, plan, destination: dest,
    deadlineAtMs: 1000, now: () => 0, signal: options.abortOnAmbiguity ? ambiguityAbort.signal : undefined,
  };
  return { db, blobs, audit, writes, input, nodes, dest };
}
