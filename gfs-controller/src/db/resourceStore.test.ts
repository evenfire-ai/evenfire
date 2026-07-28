import { describe, expect, it } from "vitest";
import { PgResourceStore, Queryable } from "./resourceStore";

/**
 * A fake Queryable that records every (text, values) pair and replays a canned
 * rows[] per call. A test that issues an unexpected number of queries fails loud
 * (the script asserts exact call shapes, not "at least").
 */
function fakeDb(responses: Array<Record<string, unknown>[]>): Queryable & {
  calls: Array<{ text: string; values: unknown[] }>;
} {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  let i = 0;
  const db: Queryable & { calls: Array<{ text: string; values: unknown[] }> } = {
    calls,
    async query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      const rows = responses[i++] ?? [];
      return { rows };
    },
  };
  db.connect = async () => ({
    query: async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      if (text === "BEGIN READ ONLY" || text === "COMMIT" || text === "ROLLBACK" || text.includes("set_config('statement_timeout'")) return { rows: [] };
      const rows = responses[i++] ?? [];
      return { rows };
    },
    release: () => undefined,
  });
  return db;
}

/** A representative `gfs_resources` row as node-postgres returns it (raw pg types). */
function pgRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    resource_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    drive: "main",
    parent_resource_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    name: "report.pdf",
    kind: "file",
    path_cache: "/docs/report.pdf",
    version: 3,
    bytes: "1048576", // BIGINT → string from node-postgres
    blob_key: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/11111111-1111-4111-8111-111111111111",
    content_sha256: "b".repeat(64),
    deleted_at: null,
    ...over,
  };
}

describe("PgResourceStore.getResource", () => {
  it("maps a live row, coercing BIGINT bytes (string) → number", async () => {
    const db = fakeDb([[pgRow()]]);
    const store = new PgResourceStore(db);

    const res = await store.getResource("main", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");

    expect(res).toEqual({
      resourceId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      drive: "main",
      parentResourceId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      name: "report.pdf",
      kind: "file",
      pathCache: "/docs/report.pdf",
      version: 3,
      bytes: 1048576,
      blobKey: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/11111111-1111-4111-8111-111111111111",
      contentSha256: "b".repeat(64),
      deletedAt: null,
    });
    expect(typeof res?.bytes).toBe("number");
    // Parameterized: never string-interpolates the id.
    expect(db.calls[0].values).toEqual(["main", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"]);
  });

  it("maps legacy rows with no generation pointer without inventing one", async () => {
    const db = fakeDb([[pgRow({ blob_key: null, content_sha256: null })]]);
    const resource = await new PgResourceStore(db).getResource(
      "main",
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    );
    expect(resource).toMatchObject({ blobKey: null, contentSha256: null });
  });

  it("RETURNS a tombstoned row (deletedAt set) — requireLive maps it to 410, not 404", async () => {
    const deletedAt = new Date("2026-06-01T12:00:00.000Z");
    const db = fakeDb([[pgRow({ deleted_at: deletedAt })]]);
    const store = new PgResourceStore(db);

    const res = await store.getResource("main", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");

    // TIMESTAMPTZ (Date) → ISO string, never dropped.
    expect(res?.deletedAt).toBe("2026-06-01T12:00:00.000Z");
  });

  it("accepts the public 32-hex rid form and queries Postgres with the UUID form", async () => {
    const db = fakeDb([[pgRow()]]);
    const store = new PgResourceStore(db);

    await store.getResource("main", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

    expect(db.calls[0].values).toEqual(["main", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"]);
  });

  it("maps a directory with a null parent (root) and null path_cache", async () => {
    const db = fakeDb([[pgRow({ kind: "directory", parent_resource_id: null, path_cache: null })]]);
    const store = new PgResourceStore(db);

    const res = await store.getResource("main", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");

    expect(res?.kind).toBe("directory");
    expect(res?.parentResourceId).toBeNull();
    expect(res?.pathCache).toBeNull();
  });

  it("returns null when no row matches (caller maps to 404)", async () => {
    const db = fakeDb([[]]);
    const store = new PgResourceStore(db);

    expect(await store.getResource("main", "dddddddd-dddd-dddd-dddd-dddddddddddd")).toBeNull();
  });
});

describe("PgResourceStore.listChildren", () => {
  it("passes null cursor params on the first page and maps every row", async () => {
    const db = fakeDb([[pgRow({ name: "a.txt" }), pgRow({ name: "b.txt", resource_id: "cccccccc-cccc-cccc-cccc-cccccccccccc" })]]);
    const store = new PgResourceStore(db);

    const rows = await store.listChildren("main", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", { limit: 50 });

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.name)).toEqual(["a.txt", "b.txt"]);
    // [drive, parent, afterName=null, afterId=null, limit]
    expect(db.calls[0].values).toEqual([
      "main",
      "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      null,
      null,
      50,
    ]);
    // Tombstone exclusion + stable order are enforced in SQL, not in JS.
    expect(db.calls[0].text).toContain("deleted_at IS NULL");
    expect(db.calls[0].text).toContain("ORDER BY name ASC, resource_id ASC");
  });

  it("forwards the (afterName, afterId) cursor for a follow-up page", async () => {
    const db = fakeDb([[]]);
    const store = new PgResourceStore(db);

    await store.listChildren("main", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", {
      limit: 10,
      afterName: "m.txt",
      afterId: "dddddddd-dddd-dddd-dddd-dddddddddddd",
    });

    expect(db.calls[0].values).toEqual([
      "main",
      "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      "m.txt",
      "dddddddd-dddd-dddd-dddd-dddddddddddd",
      10,
    ]);
  });

  it("accepts rid values for parent and cursor ids and queries Postgres with UUIDs", async () => {
    const db = fakeDb([[]]);
    const store = new PgResourceStore(db);

    await store.listChildren("main", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", {
      limit: 10,
      afterName: "m.txt",
      afterId: "dddddddddddddddddddddddddddddddd",
    });

    expect(db.calls[0].values).toEqual([
      "main",
      "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      "m.txt",
      "dddddddd-dddd-dddd-dddd-dddddddddddd",
      10,
    ]);
  });

  it("returns an empty array for an empty directory (no rows, no throw)", async () => {
    const db = fakeDb([[]]);
    const store = new PgResourceStore(db);

    expect(
      await store.listChildren("main", "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", { limit: 100 })
    ).toEqual([]);
  });
});

describe("PgResourceStore copy snapshots", () => {
  it("loads only the two direct admission rows and applies the remaining SQL timeout", async () => {
    const db = fakeDb([[
      pgRow({ record_type: "source", depth: 0, cycle: false, under_tombstone: false }),
      pgRow({ record_type: "destination", resource_id: "cccccccc-cccc-cccc-cccc-cccccccccccc", kind: "directory", depth: 0, cycle: false, under_tombstone: false }),
    ]]);
    const controller = new AbortController();
    const admission = await new PgResourceStore(db).loadCopyAdmission(
      "main", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "cccccccccccccccccccccccccccccccc",
      { deadlineAtMs: 5000, now: () => 1250, signal: controller.signal }
    );
    expect(admission.sourceRoot?.resourceId).toBe("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    expect(admission.destinationParent?.resourceId).toBe("cccccccc-cccc-cccc-cccc-cccccccccccc");
    expect(db.calls.map(call => call.text)).toEqual([
      "BEGIN READ ONLY", "SELECT set_config('statement_timeout', $1, true)", expect.stringContaining("WITH admission AS"), "COMMIT",
    ]);
    expect(db.calls[1].values).toEqual(["3750"]);
    expect(db.calls[2].values).toEqual([
      "main", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "cccccccc-cccc-cccc-cccc-cccccccccccc",
    ]);
    expect(db.calls[2].text).not.toContain("RECURSIVE");
  });

  it("fails before querying when the copy query budget is exhausted", async () => {
    const db = fakeDb([]);
    await expect(new PgResourceStore(db).loadCopyAdmission(
      "main", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "cccccccccccccccccccccccccccccccc",
      { deadlineAtMs: 100, now: () => 100 }
    )).rejects.toMatchObject({ code: "precondition_failed" });
    expect(db.calls).toEqual([]);
  });

  it("loads a recursive source snapshot in one query, preserving BIGINT bytes and cycle rows", async () => {
    const db = fakeDb([[
      pgRow({ depth: 0, cycle: false, bytes: "9007199254740991" }),
      pgRow({ resource_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", depth: 1, cycle: true, bytes: "0" }),
    ]]);
    const store = new PgResourceStore(db);

    const rows = await store.loadCopySnapshot("main", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 1001n);

    expect(db.calls).toHaveLength(1);
    expect(db.calls[0].values).toEqual(["main", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", 1001n]);
    expect(db.calls[0].text).toContain("WITH RECURSIVE source_tree");
    expect(db.calls[0].text).toContain("child.resource_id = ANY(parent.visited) AS cycle");
    expect(db.calls[0].text).not.toContain("child.drive = parent.drive");
    expect(db.calls[0].text).toContain("WHERE NOT parent.cycle");
    expect(db.calls[0].text).toContain("parent.under_tombstone OR child.deleted_at IS NOT NULL AS under_tombstone");
    expect(db.calls[0].text).toContain("WHERE depth = 0 OR deleted_at IS NULL");
    expect(db.calls[0].text).not.toContain("r.deleted_at IS NULL");
    expect(db.calls[0].text).not.toContain("ORDER BY depth ASC, resource_id ASC");
    expect(db.calls[0].text).toContain("LIMIT $3");
    expect(rows[0].bytes).toBe(9007199254740991n);
    expect(rows[0].pathCache).toBe("/docs/report.pdf");
    expect(rows[1].cycle).toBe(true);
  });

  it("keeps the source root observable but excludes historical tombstoned descendants", async () => {
    const db = fakeDb([[pgRow({ depth: 0, cycle: false, kind: "directory", bytes: "0" })]]);
    const rows = await new PgResourceStore(db).loadCopySnapshot("main", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", 1001n);
    expect(rows).toHaveLength(1);
    expect(db.calls[0].text).toContain("WHERE r.drive = $1 AND r.resource_id = $2");
    expect(db.calls[0].text).toContain("WHERE depth = 0 OR deleted_at IS NULL");
  });

  it("loads destination ancestry and children in one consistent query", async () => {
    const db = fakeDb([[
      pgRow({ record_type: "ancestor", resource_id: "cccccccc-cccc-cccc-cccc-cccccccccccc", kind: "directory", depth: 0, cycle: false, bytes: "0" }),
      pgRow({ record_type: "child", resource_id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", name: "existing", depth: 0, cycle: false }),
    ]]);
    const store = new PgResourceStore(db);

    const result = await store.loadCopyDestination("main", "cccccccccccccccccccccccccccccccc", "existing");

    expect(db.calls).toHaveLength(1);
    expect(db.calls[0].values).toEqual(["main", "cccccccc-cccc-cccc-cccc-cccccccccccc", "existing"]);
    expect(db.calls[0].text).toContain("WITH RECURSIVE destination_ancestors");
    expect(db.calls[0].text).toContain("parent.resource_id = ANY(child.visited) AS cycle");
    expect(db.calls[0].text).not.toContain("parent.drive = child.drive");
    expect(db.calls[0].text).toContain("'child' AS record_type");
    expect(db.calls[0].text).toContain("child.deleted_at IS NULL");
    expect(db.calls[0].text).toContain("child.name = $3");
    expect(result.ancestors[0]).toMatchObject({ resourceId: "cccccccc-cccc-cccc-cccc-cccccccccccc", bytes: 0n });
    expect(result.liveChildren).toEqual([{ resourceId: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", name: "existing" }]);
  });

  it("returns empty bounded snapshots when source and destination do not exist", async () => {
    const db = fakeDb([[], []]);
    const store = new PgResourceStore(db);
    const missing = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    expect(await store.loadCopySnapshot("main", missing, 1001n)).toEqual([]);
    expect(await store.loadCopyDestination("main", missing, "missing")).toEqual({ ancestors: [], liveChildren: [] });
    expect(db.calls).toHaveLength(2);
  });
});
