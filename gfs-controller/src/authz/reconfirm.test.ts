import { describe, expect, it, vi } from "vitest";
import type { AuthorizationRequest, AuthzContext } from "./permissionClient";
import { permissionEpochMoved, stillAuthorized, subjectsStillHeld } from "./reconfirm";

const USER_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TEAM_1 = "11111111-1111-4111-8111-111111111111";
const TEAM_2 = "22222222-2222-4222-8222-222222222222";
const SOURCE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DESTINATION = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function context(subjects: string[]): AuthzContext {
  return {
    drive: "main",
    subjects,
    isOperator: false,
    primarySubject: USER_ID,
    desktopUserId: USER_ID,
    authoritySource: "user-session",
    requestId: "request-1",
  };
}

const DECIDED = context([`user:${USER_ID}`, `team:${TEAM_1}`]);
const REQUESTS: AuthorizationRequest[] = [
  { resourceId: SOURCE, op: "read" },
  { resourceId: DESTINATION, op: "write" },
];

function within(allowed: boolean | boolean[]) {
  return vi.fn(async (_db: unknown, _ctx: AuthzContext, requests: readonly AuthorizationRequest[]) =>
    requests.map((_, index) => ({ allowed: Array.isArray(allowed) ? allowed[index] : allowed }))
  );
}

const STABLE = { generation: 4, bypassed: false };

describe("subjectsStillHeld", () => {
  it("is true for equal sets", () => {
    expect(subjectsStillHeld(["user:u", "team:a"], ["team:a", "user:u"])).toBe(true);
  });
  it("is true when the current set is a superset", () => {
    expect(subjectsStillHeld(["user:u"], ["user:u", "team:a"])).toBe(true);
  });
  it("is false when one decided key is missing", () => {
    expect(subjectsStillHeld(["user:u", "team:a"], ["user:u"])).toBe(false);
  });
  it("is true for an empty decided set", () => {
    expect(subjectsStillHeld([], ["user:u"])).toBe(true);
  });
  it("is true with duplicates in the current set", () => {
    expect(subjectsStillHeld(["user:u"], ["user:u", "user:u"])).toBe(true);
  });
});

describe("permissionEpochMoved", () => {
  it("is false only for the same generation with neither snapshot bypassed", () => {
    expect(permissionEpochMoved(STABLE, { ...STABLE })).toBe(false);
    expect(permissionEpochMoved(STABLE, { generation: 5, bypassed: false })).toBe(true);
    expect(permissionEpochMoved({ ...STABLE, bypassed: true }, STABLE)).toBe(true);
    expect(permissionEpochMoved(STABLE, { ...STABLE, bypassed: true })).toBe(true);
  });
});

describe("stillAuthorized", () => {
  const client = { query: vi.fn() };

  it("keeps an allow with no re-decision while every decided subject is held", async () => {
    const authorizeWithin = within(false);
    await expect(stillAuthorized(client, {
      decided: { subjects: DECIDED.subjects, allowed: true },
      current: context([`user:${USER_ID}`, `team:${TEAM_1}`, `team:${TEAM_2}`]),
      requests: REQUESTS, epochMoved: false, authorizeWithin,
    })).resolves.toEqual({ allowed: true });
    expect(authorizeWithin).not.toHaveBeenCalled();
  });

  it("re-decides a lost subject with the current subjects and allows on overlap", async () => {
    const authorizeWithin = within(true);
    const current = context([`user:${USER_ID}`]);
    await expect(stillAuthorized(client, {
      decided: { subjects: DECIDED.subjects, allowed: true },
      current, requests: REQUESTS, epochMoved: false, authorizeWithin,
    })).resolves.toEqual({ allowed: true });
    expect(authorizeWithin).toHaveBeenCalledTimes(1);
    expect(authorizeWithin).toHaveBeenCalledWith(client, current, REQUESTS);
  });

  it("returns the first denied request when the re-decision denies", async () => {
    const authorizeWithin = within([true, false]);
    await expect(stillAuthorized(client, {
      decided: { subjects: DECIDED.subjects, allowed: true },
      current: context([`user:${USER_ID}`]), requests: REQUESTS, epochMoved: false, authorizeWithin,
    })).resolves.toEqual({ allowed: false, denied: REQUESTS[1] });
    expect(authorizeWithin).toHaveBeenCalledTimes(1);
  });

  it("re-decides held subjects when the epoch moved", async () => {
    const authorizeWithin = within(true);
    await expect(stillAuthorized(client, {
      decided: { subjects: DECIDED.subjects, allowed: true },
      current: DECIDED, requests: REQUESTS, epochMoved: true, authorizeWithin,
    })).resolves.toEqual({ allowed: true });
    expect(authorizeWithin).toHaveBeenCalledTimes(1);
  });

  it("keeps a denial with no re-decision when nothing was gained", async () => {
    const authorizeWithin = within(true);
    await expect(stillAuthorized(client, {
      decided: { subjects: DECIDED.subjects, allowed: false },
      current: context([`user:${USER_ID}`]), requests: [REQUESTS[1]], epochMoved: false, authorizeWithin,
    })).resolves.toEqual({ allowed: false, denied: REQUESTS[1] });
    expect(authorizeWithin).not.toHaveBeenCalled();
  });

  it("re-decides a denial when a subject was gained", async () => {
    const authorizeWithin = within(true);
    await expect(stillAuthorized(client, {
      decided: { subjects: DECIDED.subjects, allowed: false },
      current: context([...DECIDED.subjects, `team:${TEAM_2}`]), requests: [REQUESTS[1]], epochMoved: false,
      authorizeWithin,
    })).resolves.toEqual({ allowed: true });
    expect(authorizeWithin).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty request list instead of allowing vacuously", async () => {
    const authorizeWithin = within(true);
    await expect(stillAuthorized(client, {
      decided: { subjects: [], allowed: true },
      current: DECIDED, requests: [], epochMoved: true, authorizeWithin,
    })).rejects.toMatchObject({ code: "internal" });
    expect(authorizeWithin).not.toHaveBeenCalled();
  });
});
