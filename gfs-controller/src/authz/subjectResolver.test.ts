import { describe, expect, it } from "vitest";
import { resolveAuthzContext, SubjectsDb } from "./subjectResolver";

/**
 * Fake permission store routed by SQL substring. `operators` is the set of ids
 * that control_admin_users reports as active; `teamsByUser` maps a user id to
 * its active team memberships. Any other query throws — a resolver that issues
 * an unexpected query fails loud here.
 */
function fakeDb(opts: { operators?: Set<string>; teamsByUser?: Record<string, string[]> }): SubjectsDb & {
  calls: string[];
} {
  const operators = opts.operators ?? new Set<string>();
  const teamsByUser = opts.teamsByUser ?? {};
  const calls: string[] = [];
  return {
    calls,
    async query(text: string, values?: unknown[]) {
      calls.push(text);
      if (text.includes("control_admin_users")) {
        const id = String(values?.[0]);
        return { rows: operators.has(id) ? [{ "?column?": 1 }] : [] };
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
    const ctx = await resolveAuthzContext(db, { sub: "host:1st:mcp-host/standalone", drive: "main" }, "req-1");
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

  it("rejects legacy or malformed host subjects into the normal user path", async () => {
    const db = fakeDb({});
    const ctx = await resolveAuthzContext(db, { sub: "host:1st:chatllm", drive: "main" });
    expect(ctx.subjects).toEqual(["user:host:1st:chatllm"]);
    expect(db.calls.some((q) => q.includes("team_members"))).toBe(true);
  });

  it("grants intrinsic operator authority when sub is in control_admin_users", async () => {
    const opId = "11111111-1111-1111-1111-111111111111";
    const db = fakeDb({ operators: new Set([opId]) });
    const ctx = await resolveAuthzContext(db, {
      sub: opId,
      drive: "main",
      principalType: "control-admin",
    });
    expect(ctx.isOperator).toBe(true);
    expect(ctx.subjects).toEqual(["operator:"]);
    expect(ctx.primarySubject).toBe(opId);
    // Resolution stops at the operator probe — no team lookup needed.
    expect(db.calls.some((q) => q.includes("team_members"))).toBe(false);
  });

  it("keeps an unmarked colliding UUID on the conservative user path", async () => {
    const collidingId = "88888888-8888-4888-8888-888888888888";
    const db = fakeDb({ operators: new Set([collidingId]) });
    const ctx = await resolveAuthzContext(db, { sub: collidingId, drive: "main" });
    expect(ctx.isOperator).toBe(false);
    expect(ctx.subjects).toEqual([`user:${collidingId}`]);
    expect(db.calls.some(query => query.includes("control_admin_users"))).toBe(false);
  });

  it("never elevates a signed user principal whose UUID also exists in the admin table", async () => {
    const collidingId = "99999999-9999-4999-8999-999999999999";
    const db = fakeDb({
      operators: new Set([collidingId]),
      teamsByUser: { [collidingId]: ["team-user"] },
    });

    const ctx = await resolveAuthzContext(db, {
      sub: collidingId,
      drive: "main",
      principalType: "user",
    });

    expect(ctx.isOperator).toBe(false);
    expect(ctx.subjects).toEqual([`user:${collidingId}`, "team:team-user"]);
    expect(ctx.authoritySource).toBe("user-session");
    expect(db.calls.some(query => query.includes("control_admin_users"))).toBe(false);
  });

  it("preserves linked Desktop actor, effective admin, source, token subject, and request id", async () => {
    const desktopUserId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const controlAdminId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const db = fakeDb({ operators: new Set([controlAdminId]) });

    const ctx = await resolveAuthzContext(db, {
      sub: controlAdminId,
      drive: "main",
      brokeredAuthority: {
        desktopUserId,
        controlAdminId,
        authoritySource: "linked-admin",
      },
    }, "cccccccc-cccc-4ccc-8ccc-cccccccccccc");

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

  it("accepts uppercase UUID casing in linked-admin claims and canonicalizes the subject", async () => {
    const controlAdminId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const desktopUserId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const db = fakeDb({ operators: new Set([controlAdminId]) });

    const ctx = await resolveAuthzContext(db, {
      sub: controlAdminId.toUpperCase(),
      drive: "main",
      brokeredAuthority: {
        desktopUserId: desktopUserId.toUpperCase(),
        controlAdminId: controlAdminId.toUpperCase(),
        authoritySource: "linked-admin",
      },
    });

    expect(ctx.primarySubject).toBe(controlAdminId);
    expect(ctx.effectiveControlAdminId).toBe(controlAdminId);
    expect(ctx.desktopUserId).toBe(desktopUserId);
  });

  it("fails closed when a signed linked-admin claim names an inactive or missing admin", async () => {
    const controlAdminId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const db = fakeDb({});

    await expect(resolveAuthzContext(db, {
      sub: controlAdminId,
      drive: "main",
      brokeredAuthority: {
        desktopUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        controlAdminId,
        authoritySource: "linked-admin",
      },
    })).rejects.toThrow("linked admin is not active");
    expect(db.calls.some((q) => q.includes("team_members"))).toBe(false);
  });

  it("resolves a user to itself plus its ACTIVE team memberships", async () => {
    const userId = "22222222-2222-2222-2222-222222222222";
    const db = fakeDb({ teamsByUser: { [userId]: ["team-a", "team-b"] } });
    const ctx = await resolveAuthzContext(db, { sub: userId, drive: "main" });
    expect(ctx.isOperator).toBe(false);
    expect(new Set(ctx.subjects)).toEqual(new Set([`user:${userId}`, "team:team-a", "team:team-b"]));
    expect(ctx.primarySubject).toBe(userId);
  });

  it("resolves a teamless user to only its own subject key", async () => {
    const userId = "33333333-3333-3333-3333-333333333333";
    const db = fakeDb({});
    const ctx = await resolveAuthzContext(db, { sub: userId, drive: "main" });
    expect(ctx.subjects).toEqual([`user:${userId}`]);
    expect(ctx.desktopUserId).toBe(userId);
    expect(ctx.authoritySource).toBe("user-session");
    expect(ctx.effectiveControlAdminId).toBeUndefined();
  });

  it("propagates a store error (fail-closed — never a silent allow)", async () => {
    const db: SubjectsDb = {
      async query() {
        throw new Error("permission store down");
      },
    };
    await expect(resolveAuthzContext(db, { sub: "44444444-4444-4444-4444-444444444444", drive: "main" })).rejects.toThrow(
      "permission store down"
    );
  });
});
