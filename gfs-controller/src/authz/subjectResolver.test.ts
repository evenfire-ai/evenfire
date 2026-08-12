import { describe, expect, it } from "vitest";
import { SubjectsDb, resolveAuthzContext } from "./subjectResolver";

/**
 * Fake permission store routed by SQL substring. The security projection is
 * explicit: tests must provide active user/admin generations and, for linked
 * authority, the current active lineage row. Any other query throws.
 */
function fakeDb(opts: {
  operators?: Set<string>;
  teamsByUser?: Record<string, string[]>;
  users?: Record<string, { lifecycle_state?: string; lifecycle_version?: number | string }>;
  links?: Array<{
    user_id: string;
    control_admin_id: string;
    lineage_id: string;
    generation: number | string;
  }>;
}): SubjectsDb & {
  calls: string[];
} {
  const operators = opts.operators ?? new Set<string>();
  const teamsByUser = opts.teamsByUser ?? {};
  const users = opts.users ?? {};
  const links = opts.links ?? [];
  const calls: string[] = [];
  return {
    calls,
    async query(text: string, values?: unknown[]) {
      calls.push(text);
      if (text.includes("gfs_desktop_operator_links")) {
        const [userId, adminId] = values ?? [];
        return {
          rows: links.filter(
            (link) => link.user_id === String(userId) && link.control_admin_id === String(adminId)
          ),
        };
      }
      if (text.includes("FROM users")) {
        const id = String(values?.[0]);
        const user = users[id];
        return { rows: user ? [{ id, ...user }] : [] };
      }
      if (text.includes("control_admin_users")) {
        const id = String(values?.[0]);
        return {
          rows: operators.has(id) ? [{ id, status: "active", session_version: 1 }] : [],
        };
      }
      if (text.includes("team_members")) {
        const id = String(values?.[0]);
        return { rows: (teamsByUser[id] ?? []).map((t) => ({ team_id: t })) };
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };
}

describe("resolveAuthzContext (spec §Subjects — check-time resolution)", () => {
  it("resolves a 1st-party host sub to itself, no operator, no group query", async () => {
    const db = fakeDb({});
    const ctx = await resolveAuthzContext(
      db,
      { sub: "host:1st:mcp-host/standalone", drive: "main" },
      "req-1"
    );
    expect(ctx).toEqual({
      drive: "main",
      subjects: ["host:1st:mcp-host/standalone"],
      isOperator: false,
      primarySubject: "host:1st:mcp-host/standalone",
      requestId: "req-1",
    });
    // A host never touches the operator/team queries (deny-by-default for groups).
    expect(db.calls).toEqual([]);
  });

  it("resolves a 3rd-party recipe host sub to itself", async () => {
    const db = fakeDb({});
    const ctx = await resolveAuthzContext(db, { sub: "host:3rd:recipes/notify", drive: "main" });
    expect(ctx.subjects).toEqual(["host:3rd:recipes/notify"]);
    expect(ctx.isOperator).toBe(false);
    expect(db.calls).toEqual([]);
  });

  it("rejects legacy or malformed host subjects instead of treating them as users", async () => {
    const db = fakeDb({});
    await expect(
      resolveAuthzContext(db, { sub: "host:1st:chatllm", drive: "main", authGeneration: 1 })
    ).rejects.toThrow("user principal must be a UUID");
  });

  it("grants intrinsic operator authority when sub is in control_admin_users", async () => {
    const opId = "11111111-1111-1111-1111-111111111111";
    const db = fakeDb({ operators: new Set([opId]) });
    const ctx = await resolveAuthzContext(db, {
      sub: opId,
      drive: "main",
      principalType: "control-admin",
      authGeneration: 1,
    });
    expect(ctx.isOperator).toBe(true);
    expect(ctx.subjects).toEqual(["operator:"]);
    expect(ctx.primarySubject).toBe(opId);
    // Resolution stops at the operator probe — no team lookup needed.
    expect(db.calls.some((q) => q.includes("team_members"))).toBe(false);
  });

  it("keeps an unmarked colliding UUID on the conservative user path", async () => {
    const collidingId = "88888888-8888-4888-8888-888888888888";
    const db = fakeDb({
      operators: new Set([collidingId]),
      users: { [collidingId]: { lifecycle_state: "active", lifecycle_version: 1 } },
    });
    const ctx = await resolveAuthzContext(db, {
      sub: collidingId,
      drive: "main",
      authGeneration: 1,
    });
    expect(ctx.isOperator).toBe(false);
    expect(ctx.subjects).toEqual([`user:${collidingId}`]);
    expect(db.calls.some((query) => query.includes("control_admin_users"))).toBe(false);
  });

  it("never elevates a signed user principal whose UUID also exists in the admin table", async () => {
    const collidingId = "99999999-9999-4999-8999-999999999999";
    const db = fakeDb({
      operators: new Set([collidingId]),
      teamsByUser: { [collidingId]: ["team-user"] },
      users: { [collidingId]: { lifecycle_state: "active", lifecycle_version: 1 } },
    });

    const ctx = await resolveAuthzContext(db, {
      sub: collidingId,
      drive: "main",
      principalType: "user",
      authGeneration: 1,
    });

    expect(ctx.isOperator).toBe(false);
    expect(ctx.subjects).toEqual([`user:${collidingId}`, "team:team-user"]);
    expect(ctx.authoritySource).toBe("user-session");
    expect(db.calls.some((query) => query.includes("control_admin_users"))).toBe(false);
  });

  it("preserves linked Desktop actor, effective admin, source, token subject, and request id", async () => {
    const desktopUserId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const controlAdminId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const db = fakeDb({
      operators: new Set([controlAdminId]),
      users: { [desktopUserId]: { lifecycle_state: "active", lifecycle_version: 1 } },
      links: [
        {
          user_id: desktopUserId,
          control_admin_id: controlAdminId,
          lineage_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          generation: 1,
        },
      ],
    });

    const ctx = await resolveAuthzContext(
      db,
      {
        sub: controlAdminId,
        drive: "main",
        brokeredAuthority: {
          desktopUserId,
          controlAdminId,
          authoritySource: "linked-admin",
          linkLineageId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          linkGeneration: 1,
          desktopUserGeneration: 1,
        },
        authGeneration: 1,
      },
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
    );

    expect(ctx).toEqual({
      drive: "main",
      subjects: ["operator:"],
      isOperator: true,
      primarySubject: controlAdminId,
      effectiveControlAdminId: controlAdminId,
      desktopUserId,
      authoritySource: "linked-admin",
      requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    });
  });

  it("accepts PostgreSQL text generations for users and active linked-admin rows", async () => {
    const desktopUserId = "abababab-abab-4aba-8aba-abababababab";
    const controlAdminId = "bcbcbcbc-bcbc-4bcb-8bcb-bcbcbcbcbcbc";
    const db = fakeDb({
      operators: new Set([controlAdminId]),
      users: { [desktopUserId]: { lifecycle_state: "active", lifecycle_version: "1" } },
      links: [
        {
          user_id: desktopUserId,
          control_admin_id: controlAdminId,
          lineage_id: "cdcdcdcd-cdcd-4cdc-8dcd-cdcdcdcdcdcd",
          generation: "1",
        },
      ],
    });

    await expect(
      resolveAuthzContext(db, {
        sub: controlAdminId,
        drive: "main",
        authGeneration: 1,
        principalType: "control-admin",
        brokeredAuthority: {
          desktopUserId,
          controlAdminId,
          authoritySource: "linked-admin",
          linkLineageId: "cdcdcdcd-cdcd-4cdc-8dcd-cdcdcdcdcdcd",
          linkGeneration: 1,
          desktopUserGeneration: 1,
        },
      })
    ).resolves.toMatchObject({
      isOperator: true,
      desktopUserId,
      effectiveControlAdminId: controlAdminId,
    });
  });

  it("accepts uppercase UUID casing in linked-admin claims and canonicalizes the subject", async () => {
    const controlAdminId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const desktopUserId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const db = fakeDb({
      operators: new Set([controlAdminId]),
      users: { [desktopUserId]: { lifecycle_state: "active", lifecycle_version: 1 } },
      links: [
        {
          user_id: desktopUserId,
          control_admin_id: controlAdminId,
          lineage_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          generation: 1,
        },
      ],
    });

    const ctx = await resolveAuthzContext(db, {
      sub: controlAdminId.toUpperCase(),
      drive: "main",
      brokeredAuthority: {
        desktopUserId: desktopUserId.toUpperCase(),
        controlAdminId: controlAdminId.toUpperCase(),
        authoritySource: "linked-admin",
        linkLineageId: "CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC",
        linkGeneration: 1,
        desktopUserGeneration: 1,
      },
      authGeneration: 1,
    });

    expect(ctx.primarySubject).toBe(controlAdminId);
    expect(ctx.effectiveControlAdminId).toBe(controlAdminId);
    expect(ctx.desktopUserId).toBe(desktopUserId);
  });

  it("fails closed when a signed linked-admin claim names an inactive or missing admin", async () => {
    const controlAdminId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const db = fakeDb({});

    await expect(
      resolveAuthzContext(db, {
        sub: controlAdminId,
        drive: "main",
        brokeredAuthority: {
          desktopUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          controlAdminId,
          authoritySource: "linked-admin",
          linkLineageId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          linkGeneration: 1,
          desktopUserGeneration: 1,
        },
        authGeneration: 1,
      })
    ).rejects.toThrow("linked admin is not active");
    expect(db.calls.some((q) => q.includes("team_members"))).toBe(false);
  });

  it("resolves a user to itself plus its ACTIVE team memberships", async () => {
    const userId = "22222222-2222-2222-2222-222222222222";
    const db = fakeDb({
      teamsByUser: { [userId]: ["team-a", "team-b"] },
      users: { [userId]: { lifecycle_state: "active", lifecycle_version: 1 } },
    });
    const ctx = await resolveAuthzContext(db, { sub: userId, drive: "main", authGeneration: 1 });
    expect(ctx.isOperator).toBe(false);
    expect(new Set(ctx.subjects)).toEqual(
      new Set([`user:${userId}`, "team:team-a", "team:team-b"])
    );
    expect(ctx.primarySubject).toBe(userId);
  });

  it("resolves a teamless user to only its own subject key", async () => {
    const userId = "33333333-3333-3333-3333-333333333333";
    const db = fakeDb({ users: { [userId]: { lifecycle_state: "active", lifecycle_version: 1 } } });
    const ctx = await resolveAuthzContext(db, { sub: userId, drive: "main", authGeneration: 1 });
    expect(ctx.subjects).toEqual([`user:${userId}`]);
    expect(ctx.desktopUserId).toBe(userId);
    expect(ctx.authoritySource).toBe("user-session");
    expect(ctx.effectiveControlAdminId).toBeUndefined();
  });

  it("denies an ordinary bearer immediately after the user lifecycle becomes retired", async () => {
    const userId = "55555555-5555-4555-8555-555555555555";
    const db = fakeDb({
      teamsByUser: { [userId]: ["team-still-present"] },
      users: { [userId]: { lifecycle_state: "retired", lifecycle_version: 2 } },
    });

    await expect(
      resolveAuthzContext(db, { sub: userId, drive: "main", authGeneration: 1 })
    ).rejects.toThrow("user is retired or token generation is stale");
    expect(db.calls.some((query) => query.includes("team_members"))).toBe(false);
  });

  it("denies a stale ordinary bearer after lifecycle generation changes", async () => {
    const userId = "66666666-6666-4666-8666-666666666666";
    const db = fakeDb({
      users: { [userId]: { lifecycle_state: "active", lifecycle_version: 3 } },
    });

    await expect(
      resolveAuthzContext(db, { sub: userId, drive: "main", authGeneration: 2 })
    ).rejects.toThrow("user is retired or token generation is stale");
  });

  it("denies a linked-admin bearer after the active link generation is revoked", async () => {
    const desktopUserId = "77777777-7777-4777-8777-777777777777";
    const controlAdminId = "88888888-8888-4888-8888-888888888888";
    const db = fakeDb({
      operators: new Set([controlAdminId]),
      users: { [desktopUserId]: { lifecycle_state: "active", lifecycle_version: 1 } },
      links: [],
    });

    await expect(
      resolveAuthzContext(db, {
        sub: controlAdminId,
        drive: "main",
        authGeneration: 1,
        principalType: "control-admin",
        brokeredAuthority: {
          desktopUserId,
          controlAdminId,
          authoritySource: "linked-admin",
          linkLineageId: "99999999-9999-4999-8999-999999999999",
          linkGeneration: 1,
          desktopUserGeneration: 1,
        },
      })
    ).rejects.toThrow("linked Desktop operator generation is not active");
  });

  it("denies a linked-admin bearer when the Desktop user is retired even if the admin remains active", async () => {
    const desktopUserId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const controlAdminId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const db = fakeDb({
      operators: new Set([controlAdminId]),
      users: { [desktopUserId]: { lifecycle_state: "retired", lifecycle_version: 2 } },
      links: [
        {
          user_id: desktopUserId,
          control_admin_id: controlAdminId,
          lineage_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          generation: 1,
        },
      ],
    });

    await expect(
      resolveAuthzContext(db, {
        sub: controlAdminId,
        drive: "main",
        authGeneration: 1,
        principalType: "control-admin",
        brokeredAuthority: {
          desktopUserId,
          controlAdminId,
          authoritySource: "linked-admin",
          linkLineageId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          linkGeneration: 1,
          desktopUserGeneration: 1,
        },
      })
    ).rejects.toThrow("linked Desktop user is retired or stale");
  });

  it("propagates a store error (fail-closed — never a silent allow)", async () => {
    const db: SubjectsDb = {
      async query() {
        throw new Error("permission store down");
      },
    };
    await expect(
      resolveAuthzContext(db, {
        sub: "44444444-4444-4444-4444-444444444444",
        drive: "main",
        authGeneration: 1,
      })
    ).rejects.toThrow("permission store down");
  });
});
