import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { GfsError } from "./errors";
import {
  BlobReader,
  clampLimit,
  decodeCursor,
  downloadResource,
  encodeCursor,
  GfsResource,
  listChildren,
  MAX_LIMIT,
  ResourceStore,
  statResource,
  toView,
} from "./read";

function rid(n: number): string {
  return n.toString(16).padStart(32, "0");
}

function resource(partial: Partial<GfsResource> & { resourceId: string; name: string }): GfsResource {
  return {
    drive: "main",
    parentResourceId: null,
    kind: "file",
    pathCache: null,
    version: 0,
    bytes: 0,
    deletedAt: null,
    ...partial,
  };
}

class FakeStore implements ResourceStore {
  private byId = new Map<string, GfsResource>();
  add(r: GfsResource): this {
    this.byId.set(r.resourceId, r);
    return this;
  }
  async getResource(drive: string, resourceId: string): Promise<GfsResource | null> {
    const r = this.byId.get(resourceId);
    return r && r.drive === drive ? r : null;
  }
  async listChildren(
    drive: string,
    parentResourceId: string,
    opts: { limit: number; afterName?: string; afterId?: string }
  ): Promise<GfsResource[]> {
    const all = [...this.byId.values()]
      .filter((r) => r.drive === drive && r.parentResourceId === parentResourceId && !r.deletedAt)
      .sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : a.resourceId < b.resourceId ? -1 : 1
      );
    const rows =
      opts.afterName === undefined
        ? all
        : all.filter(
            (r) =>
              r.name > opts.afterName! ||
              (r.name === opts.afterName && r.resourceId > (opts.afterId ?? ""))
          );
    return rows.slice(0, opts.limit);
  }
}

const PARENT = rid(1);
const blobs: BlobReader = {
  read: async (id) => Readable.from([Buffer.from(`bytes:${id}`)]),
};

function dirStore(): FakeStore {
  return new FakeStore().add(resource({ resourceId: PARENT, name: "root", kind: "directory" }));
}

describe("clampLimit", () => {
  it("defaults, floors, and caps at MAX_LIMIT", () => {
    expect(clampLimit(undefined)).toBe(100);
    expect(clampLimit(0)).toBe(100);
    expect(clampLimit(-5)).toBe(100);
    expect(clampLimit("25")).toBe(25);
    expect(clampLimit(10_000)).toBe(MAX_LIMIT);
  });
});

describe("cursor", () => {
  it("round-trips and rejects garbage with path_invalid", () => {
    const r = resource({ resourceId: rid(7), name: "file-7" });
    expect(decodeCursor(encodeCursor(r))).toEqual({ n: "file-7", i: rid(7) });
    expect(() => decodeCursor("@@@not-base64-json@@@")).toThrow(GfsError);
  });
});

describe("listChildren pagination", () => {
  it("walks every child exactly once across pages without a count(*)", async () => {
    const store = dirStore();
    const names = ["a", "b", "c", "d", "e"];
    names.forEach((name, idx) =>
      store.add(resource({ resourceId: rid(100 + idx), name, parentResourceId: PARENT }))
    );

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = await listChildren(store, "main", PARENT, { limit: 2, cursor });
      seen.push(...page.items.map((i) => i.name));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(names);
  });

  it("excludes tombstoned children", async () => {
    const store = dirStore()
      .add(resource({ resourceId: rid(200), name: "live", parentResourceId: PARENT }))
      .add(
        resource({
          resourceId: rid(201),
          name: "dead",
          parentResourceId: PARENT,
          deletedAt: "2026-01-01T00:00:00Z",
        })
      );
    const page = await listChildren(store, "main", PARENT, {});
    expect(page.items.map((i) => i.name)).toEqual(["live"]);
  });

  it("not_found on absent parent, gone on tombstone, not_a_directory on a file", async () => {
    const store = dirStore()
      .add(resource({ resourceId: rid(2), name: "file", kind: "file" }))
      .add(
        resource({
          resourceId: rid(3),
          name: "dead-dir",
          kind: "directory",
          deletedAt: "2026-01-01T00:00:00Z",
        })
      );
    await expect(listChildren(store, "main", rid(999), {})).rejects.toMatchObject({ code: "not_found" });
    await expect(listChildren(store, "main", rid(3), {})).rejects.toMatchObject({
      code: "gone",
      reason: "resource_deleted",
    });
    await expect(listChildren(store, "main", rid(2), {})).rejects.toMatchObject({
      code: "not_a_directory",
    });
  });

  it("rejects an invalid parent id with path_invalid before hitting the store", async () => {
    await expect(listChildren(dirStore(), "main", "../escape", {})).rejects.toMatchObject({
      code: "path_invalid",
    });
  });
});

describe("statResource", () => {
  it("returns a view with the canonical gfs:// URI", async () => {
    const store = dirStore().add(resource({ resourceId: rid(2), name: "doc.md", bytes: 12 }));
    const view = await statResource(store, "main", rid(2));
    expect(view.gfsUri).toBe(`gfs://main/${rid(2)}`);
    expect(view.bytes).toBe(12);
  });

  it("not_found / gone are surfaced fail-loud", async () => {
    const store = dirStore().add(
      resource({ resourceId: rid(4), name: "x", deletedAt: "2026-01-01T00:00:00Z" })
    );
    await expect(statResource(store, "main", rid(404))).rejects.toMatchObject({ code: "not_found" });
    await expect(statResource(store, "main", rid(4))).rejects.toMatchObject({ code: "gone" });
  });
});

describe("downloadResource", () => {
  it("streams the file bytes", async () => {
    const store = dirStore().add(resource({ resourceId: rid(5), name: "f", kind: "file" }));
    const { stream, resource: view } = await downloadResource(store, blobs, "main", rid(5));
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe(`bytes:${rid(5)}`);
    expect(view.kind).toBe("file");
  });

  it("is_a_directory when targeting a folder", async () => {
    const store = dirStore().add(resource({ resourceId: rid(6), name: "d", kind: "directory" }));
    await expect(downloadResource(store, blobs, "main", rid(6))).rejects.toMatchObject({
      code: "is_a_directory",
    });
  });

  it("internal when metadata exists but the blob is missing (inconsistency, not silent empty)", async () => {
    const store = dirStore().add(resource({ resourceId: rid(8), name: "f", kind: "file" }));
    const missingBlobs: BlobReader = {
      read: async () => {
        throw Object.assign(new Error("blob not found"), { code: "not_found" });
      },
    };
    await expect(downloadResource(store, missingBlobs, "main", rid(8))).rejects.toMatchObject({
      code: "internal",
    });
  });
});

describe("toView", () => {
  it("derives rid + gfsUri and exposes pathCache as path", () => {
    const view = toView(resource({ resourceId: rid(9), name: "n", pathCache: "/org/n", bytes: 3 }));
    expect(view.rid).toBe(rid(9));
    expect(view.gfsUri).toBe(`gfs://main/${rid(9)}`);
    expect(view.path).toBe("/org/n");
  });
});
