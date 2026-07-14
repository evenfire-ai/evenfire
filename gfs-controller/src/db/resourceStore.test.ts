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
  return {
    calls,
    async query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      const rows = responses[i++] ?? [];
      return { rows };
    },
  };
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
      deletedAt: null,
    });
    expect(typeof res?.bytes).toBe("number");
    // Parameterized: never string-interpolates the id.
    expect(db.calls[0].values).toEqual(["main", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"]);
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
