import { describe, expect, it } from "vitest";
import { AccessibleResourceStore } from "./accessibleStore";
import type { AuthzContext, Queryable } from "./permissionClient";

const RID_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const RID_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function db(rows: Record<string, unknown>[] = []): Queryable & { queries: string[]; values: unknown[][] } {
  const queries: string[] = [];
  const values: unknown[][] = [];
  return {
    queries,
    values,
    async query(text: string, params?: unknown[]) {
      queries.push(text);
      values.push(params ?? []);
      return { rows };
    },
  };
}

const operatorCtx: AuthzContext = {
  drive: "main",
  subjects: ["operator:"],
  isOperator: true,
  primarySubject: "admin-1",
};

const userCtx: AuthzContext = {
  drive: "main",
  subjects: ["user:user-1", "team:team-1"],
  isOperator: false,
  primarySubject: "user-1",
};

describe("AccessibleResourceStore", () => {
  it("lists all non-deleted resources for an intrinsic operator with full permissions", async () => {
    const storeDb = db([
      {
        resource_id: RID_A,
        drive: "main",
        parent_resource_id: null,
        name: "reports",
        kind: "directory",
        path_cache: "/reports",
        version: 1,
        bytes: 0,
        sources: ["operator"],
        permissions: ["read", "write", "delete", "manage_acl", "share"],
        covers_descendants: true,
      },
    ]);

    const page = await new AccessibleResourceStore(storeDb).list(operatorCtx, { limit: 1 });

    expect(storeDb.queries[0]).toContain("FROM gfs_resources r");
    expect(storeDb.queries[0]).not.toContain("gfs_grants");
    expect(storeDb.values[0]).toEqual(["main", null, null, 2]);
    expect(page.nextCursor).toBeNull();
    expect(page.items).toEqual([
      expect.objectContaining({
        resourceId: RID_A,
        rid: RID_A.replaceAll("-", ""),
        gfsUri: `gfs://main/${RID_A.replaceAll("-", "")}`,
        name: "reports",
        permissions: ["read", "write", "delete", "manage_acl", "share"],
        sources: ["operator"],
        coversDescendants: true,
      }),
    ]);
  });

  it("keeps non-operator discovery limited to explicit grants and shares", async () => {
    const storeDb = db([
      {
        resource_id: RID_B,
        drive: "main",
        parent_resource_id: RID_A,
        name: "shared.md",
        kind: "file",
        path_cache: "/reports/shared.md",
        version: 2,
        bytes: 12,
        permissions: ["read"],
        sources: ["grant"],
        covers_descendants: false,
      },
    ]);

    const page = await new AccessibleResourceStore(storeDb).list(userCtx, { limit: 10 });

    expect(storeDb.queries[0]).toContain("gfs_grants");
    expect(storeDb.queries[0]).toContain("gfs_shares");
    expect(storeDb.values[0]?.[1]).toEqual(["user", "team"]);
    expect(storeDb.values[0]?.[2]).toEqual(["user-1", "team-1"]);
    expect(page.items[0]).toMatchObject({
      resourceId: RID_B,
      permissions: ["read"],
      sources: ["grant"],
      coversDescendants: false,
    });
  });
});
