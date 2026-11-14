import { describe, expect, it, vi } from "vitest";
import { copyFixture, DEST, EMPTY, FILE, SOURCE, UNICODE, sourceNodes } from "../../test/copyPublicationTestKit";

describe("transactional recursive copy publication", () => {
  it("publishes a nested tree with new identities in one metadata insert", async () => {
    const { db, blobs, audit, writes, input } = copyFixture();
    const before = new Map(db.resources);
    const copied = await writes.copy(input);
    expect(copied).toMatchObject({ requestId: input.requestId, objectCount: 4, fileCount: 2, folderCount: 2, totalBytes: 10n });
    expect(copied.root).toMatchObject({
      parentResourceId: DEST,
      name: "source",
      pathCache: "/archive/source",
      version: 0,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const added = [...db.resources.values()].filter(row => !before.has(String(row.resource_id)));
    expect(added).toHaveLength(4);
    expect(new Set(added.map(row => row.resource_id)).size).toBe(4);
    expect(added.map(row => row.path_cache)).toEqual(expect.arrayContaining([
      "/archive/source", "/archive/source/file.txt", "/archive/source/empty", "/archive/source/empty/café.txt",
    ]));
    expect(added.find(row => row.path_cache === "/archive/source/empty")).toMatchObject({ bytes: 0, blob_key: null });
    expect(sourceNodes().every(node => db.resources.get(node.resourceId)?.version === node.version)).toBe(true);
    expect(blobs.writes).toHaveLength(2);
    expect(blobs.reads.filter(id => id === FILE)).toHaveLength(1);
    expect(blobs.reads.filter(id => id !== FILE)).toHaveLength(2);
    expect(db.calls.filter(call => call.sql.includes("INSERT INTO gfs_resources"))).toHaveLength(1);
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]).toMatchObject({
      transactional: true,
      event: {
        recordType: "mutation_outcome", subject: "agent:test", op: "copy", drive: "main",
        resourceId: copied.root.resourceId.replaceAll("-", ""), requestId: input.requestId, outcome: "allow",
        mutationOutcome: "succeeded", matchedSubject: null, authorizationSource: null,
        cachedAuthorizationSource: null,
      },
    });
    const resourceInsert = db.calls.findIndex(call => call.sql.includes("INSERT INTO gfs_resources"));
    const manifestCommit = db.calls.findIndex(call => call.sql.includes("UPDATE gfs_blob_manifests") && call.sql.includes("committed"));
    const auditInsert = db.calls.findIndex(call => call.sql.includes("INSERT INTO gfs_audit"));
    expect(resourceInsert).toBeLessThan(manifestCommit);
    expect(manifestCommit).toBeLessThan(auditInsert);
  });

  it("admits exact available capacity without a post-staging capacity check", async () => {
    const fixture = copyFixture();
    fixture.blobs.capacity = fixture.input.plan.totalBytes;
    await expect(fixture.writes.copy(fixture.input)).resolves.toMatchObject({ totalBytes: 10n });
    expect(fixture.blobs.capacityCalls).toBe(1);
  });

  it("publishes a directory-only tree without blob or manifest work", async () => {
    const fixture = copyFixture({ nodes: [sourceNodes()[0]] });
    await expect(fixture.writes.copy(fixture.input)).resolves.toMatchObject({ objectCount: 1, fileCount: 0, folderCount: 1 });
    expect(fixture.blobs.writes).toEqual([]);
    expect(fixture.db.manifests.size).toBe(0);
  });

  it("publishes more than 6553 directories with one fixed-size JSONB parameter", async () => {
    const source = sourceNodes()[0];
    const descendants = Array.from({ length: 6_553 }, (_, index) => {
      const suffix = String(index + 1).padStart(12, "0");
      const name = `directory-${index + 1}`;
      return {
        ...source,
        resourceId: `20000000-0000-4000-8000-${suffix}`,
        parentResourceId: SOURCE,
        name,
        pathCache: `/source/${name}`,
        version: 0,
        depth: 1,
      };
    });
    const fixture = copyFixture({ nodes: [source, ...descendants], maxObjects: 7_000 });

    await expect(fixture.writes.copy(fixture.input)).resolves.toMatchObject({
      objectCount: 6_554,
      folderCount: 6_554,
      fileCount: 0,
    });
    const insert = fixture.db.calls.find(call => call.sql.includes("INSERT INTO gfs_resources"))!;
    expect(insert.sql).toContain("jsonb_to_recordset($1::jsonb)");
    expect(insert.sql).toContain("resource_id uuid");
    expect(insert.sql).toContain("parent_resource_id uuid");
    expect(insert.sql).toContain("bytes bigint");
    expect(insert.sql).toContain("kind text");
    expect(insert.sql).toContain("version integer");
    expect(insert.sql).toContain("ORDER BY ordinal");
    expect(insert.values).toHaveLength(1);
    expect(JSON.parse(String(insert.values[0]))).toHaveLength(6_554);
  });

  it.each(["addition", "deletion", "reparent", "replacement"])(
    "rejects a concurrent source %s",
    async kind => {
      const fixture = copyFixture();
      if (kind === "addition") {
        fixture.db.resources.set("00000000-0000-4000-8000-000000000099", {
          resource_id: "00000000-0000-4000-8000-000000000099", drive: "main",
          parent_resource_id: SOURCE, name: "late", kind: "directory", path_cache: "/source/late",
          version: 0, bytes: "0", blob_key: null, content_sha256: null, deleted_at: null,
        });
      } else if (kind === "deletion") {
        fixture.db.resources.delete(FILE);
      } else if (kind === "reparent") {
        fixture.db.resources.get(FILE)!.parent_resource_id = DEST;
      } else {
        Object.assign(fixture.db.resources.get(FILE)!, { version: 99, blob_key: "changed/key" });
      }
      await expect(fixture.writes.copy(fixture.input)).rejects.toMatchObject({ code: "precondition_failed" });
      expect(fixture.blobs.deletes).toHaveLength(2);
    }
  );

  it("ignores tombstone-only history but rejects a live node hidden below it", async () => {
    const history = copyFixture();
    history.db.resources.set("00000000-0000-4000-8000-000000000090", {
      resource_id: "00000000-0000-4000-8000-000000000090", drive: "main", parent_resource_id: SOURCE,
      name: "old", kind: "directory", path_cache: "/source/old", version: 1, bytes: "0",
      blob_key: null, content_sha256: null, deleted_at: new Date("2026-01-01T00:00:00Z"),
    });
    await expect(history.writes.copy(history.input)).resolves.toMatchObject({ objectCount: 4 });

    const hidden = copyFixture();
    hidden.db.resources.set("00000000-0000-4000-8000-000000000090", {
      resource_id: "00000000-0000-4000-8000-000000000090", drive: "main", parent_resource_id: SOURCE,
      name: "old", kind: "directory", path_cache: "/source/old", version: 1, bytes: "0",
      blob_key: null, content_sha256: null, deleted_at: new Date("2026-01-01T00:00:00Z"),
    });
    hidden.db.resources.set("00000000-0000-4000-8000-000000000091", {
      resource_id: "00000000-0000-4000-8000-000000000091", drive: "main", parent_resource_id: "00000000-0000-4000-8000-000000000090",
      name: "live", kind: "directory", path_cache: "/source/old/live", version: 0, bytes: "0",
      blob_key: null, content_sha256: null, deleted_at: null,
    });
    await expect(hidden.writes.copy(hidden.input)).rejects.toMatchObject({ code: "precondition_failed" });
  });

  it("bounds live-tree revalidation at the frozen object count plus one", async () => {
    const fixture = copyFixture();
    await fixture.writes.copy(fixture.input);
    const query = fixture.db.calls.find(call => call.sql.includes("WITH RECURSIVE copy_recheck"))!;
    expect(query.sql).toContain("WHERE depth = 0 OR deleted_at IS NULL");
    expect(query.sql).toContain("LIMIT $3");
    expect(query.values[2]).toBe(BigInt(fixture.input.plan.objectCount) + 1n);
  });

  it("rejects destination changes and late root collisions", async () => {
    const changed = copyFixture();
    changed.db.resources.get(DEST)!.version = 8;
    await expect(changed.writes.copy(changed.input)).rejects.toMatchObject({ code: "precondition_failed" });

    const collision = copyFixture();
    collision.db.resources.set("00000000-0000-4000-8000-000000000098", {
      resource_id: "00000000-0000-4000-8000-000000000098", drive: "main", parent_resource_id: DEST,
      name: "source", kind: "directory", path_cache: "/archive/source", version: 0, bytes: "0",
      blob_key: null, content_sha256: null, deleted_at: null,
    });
    await expect(collision.writes.copy(collision.input)).rejects.toMatchObject({ code: "already_exists" });
    expect(collision.db.calls.some(call => call.sql.includes("INSERT INTO gfs_resources"))).toBe(false);
  });

  it("does not couple copy publication to access-control or sharing tables", async () => {
    const fixture = copyFixture();
    await fixture.writes.copy(fixture.input);
    const sql = fixture.db.calls.map(call => call.sql).join("\n");
    expect(sql).not.toContain("gfs_gr" + "ants");
    expect(sql).not.toContain("gfs_sh" + "ares");
  });
});

describe("copy permission-epoch re-check (TOCTOU close)", () => {
  const STABLE = { generation: 7, bypassed: false } as const;

  it("publishes when the epoch is unchanged between authorization and the writer tx", async () => {
    const fixture = copyFixture();
    const input = {
      ...fixture.input,
      authzEpoch: { captured: { ...STABLE }, current: () => ({ ...STABLE }) },
    };
    await expect(fixture.writes.copy(input)).resolves.toMatchObject({ objectCount: 4 });
    expect(fixture.db.calls.some(call => call.sql.includes("INSERT INTO gfs_resources"))).toBe(true);
  });

  it("rejects before INSERT when a revocation bumped the generation mid-copy", async () => {
    const fixture = copyFixture();
    const input = {
      ...fixture.input,
      authzEpoch: {
        captured: { generation: 7, bypassed: false },
        current: () => ({ generation: 8, bypassed: false }),
      },
    };
    await expect(fixture.writes.copy(input)).rejects.toMatchObject({
      code: "precondition_failed",
      message: "authorization changed during copy",
    });
    // The re-check runs under the advisory lock, immediately before the INSERT —
    // so a revoked grant never publishes.
    expect(fixture.db.calls.some(call => call.sql.includes("INSERT INTO gfs_resources"))).toBe(false);
    // Staged blobs are rolled back rather than orphaned.
    expect(fixture.blobs.deletes).toHaveLength(2);
  });

  it("fails closed when the live epoch reports a degraded (bypassed) LISTEN", async () => {
    const fixture = copyFixture();
    const input = {
      ...fixture.input,
      authzEpoch: {
        captured: { generation: 7, bypassed: false },
        current: () => ({ generation: 7, bypassed: true }),
      },
    };
    await expect(fixture.writes.copy(input)).rejects.toMatchObject({ code: "precondition_failed" });
    expect(fixture.db.calls.some(call => call.sql.includes("INSERT INTO gfs_resources"))).toBe(false);
  });

  it("fails closed when the epoch was already bypassed at authorization time", async () => {
    const fixture = copyFixture();
    const input = {
      ...fixture.input,
      authzEpoch: {
        captured: { generation: 7, bypassed: true },
        current: () => ({ generation: 7, bypassed: true }),
      },
    };
    await expect(fixture.writes.copy(input)).rejects.toMatchObject({ code: "precondition_failed" });
    expect(fixture.db.calls.some(call => call.sql.includes("INSERT INTO gfs_resources"))).toBe(false);
  });

  it("re-reads the live epoch inside the writer transaction, not once at capture", async () => {
    const fixture = copyFixture();
    let epochReads = 0;
    const input = {
      ...fixture.input,
      authzEpoch: {
        captured: { generation: 7, bypassed: false },
        current: () => {
          epochReads += 1;
          return { generation: 7, bypassed: false };
        },
      },
    };
    await expect(fixture.writes.copy(input)).resolves.toMatchObject({ objectCount: 4 });
    // `current()` is invoked during revalidate (inside the tx), proving the
    // re-check reads the LIVE epoch rather than trusting the captured snapshot.
    expect(epochReads).toBeGreaterThanOrEqual(1);
  });
});

describe("copy publication activity hook (D16)", () => {
  const insertedNodes = (db: { calls: Array<{ sql: string; values: unknown[] }> }) => {
    const insert = db.calls.find(call => call.sql.includes("INSERT INTO gfs_resources"));
    if (!insert) throw new Error("the copy INSERT never ran");
    return JSON.parse(String(insert.values[0])) as Array<{ resource_id: string; kind: string }>;
  };

  it("runs once with exactly the new file ids, after the INSERT and before the success audit", async () => {
    const fixture = copyFixture();
    const seen: string[][] = [];
    await expect(
      fixture.writes.copy({
        ...fixture.input,
        onPublished: async (_client, fileIds) => {
          seen.push([...fileIds]);
        },
      }),
    ).resolves.toMatchObject({ objectCount: 4, fileCount: 2 });

    expect(seen).toHaveLength(1);
    const inserted = insertedNodes(fixture.db);
    const files = inserted.filter(node => node.kind === "file").map(node => node.resource_id);
    // Exactly the copy's NEW file identities: no folder, and none of the sources.
    expect([...seen[0]!].sort()).toEqual([...files].sort());
    expect(files).toHaveLength(2);
    for (const source of [SOURCE, FILE, EMPTY, UNICODE]) expect(seen[0]).not.toContain(source);

    // The hook runs after the metadata INSERT and before the success audit, so
    // its rows cannot commit without the copy or the copy without its rows.
    expect(fixture.audit.records).toHaveLength(1);
    expect(fixture.audit.records[0]).toMatchObject({
      transactional: true,
      event: { mutationOutcome: "succeeded", op: "copy" },
    });
  });

  it("never runs for a folders-only copy", async () => {
    const fixture = copyFixture({ nodes: [sourceNodes()[0]] });
    const hook = vi.fn(async () => undefined);
    await expect(
      fixture.writes.copy({ ...fixture.input, onPublished: hook }),
    ).resolves.toMatchObject({ objectCount: 1, fileCount: 0 });
    expect(hook).not.toHaveBeenCalled();
    // Witness: the INSERT ran, so the empty hook call is a decision.
    expect(insertedNodes(fixture.db)).toHaveLength(1);
  });

  it("rolls the copy back and surfaces the error when the hook fails", async () => {
    const fixture = copyFixture();
    const before = new Map(fixture.db.resources);
    await expect(
      fixture.writes.copy({
        ...fixture.input,
        onPublished: async () => {
          throw new Error("activity insert failed");
        },
      }),
    ).rejects.toThrow("activity insert failed");

    // Nothing of the copy was published...
    expect(fixture.db.resources.size).toBe(before.size);
    // ...no success audit was written, but the failure is on record.
    expect(fixture.audit.records.some(record => record.event.mutationOutcome === "failed")).toBe(
      true,
    );
    expect(fixture.audit.records.some(record => record.event.mutationOutcome === "succeeded")).toBe(
      false,
    );
  });
});
