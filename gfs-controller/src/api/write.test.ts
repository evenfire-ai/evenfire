import { describe, expect, it } from "vitest";
import { planWrite, WriteError } from "./write.js";

/**
 * P4-S01 — gfs write planning. create→write on parent; replace→write; delete→
 * delete (destructive bit, agents default-denied via the permission check);
 * agent writes require If-Match; stale If-Match → precondition_failed.
 */

const R = "res-1";
const PARENT = "parent-1";

describe("planWrite — required permission per op", () => {
  it("create requires write on the destination parent", () => {
    const plan = planWrite({ op: "create", parentId: PARENT, isAgent: false });
    expect(plan.checks).toEqual([{ resourceId: PARENT, op: "write" }]);
  });

  it("replace requires write on the resource", () => {
    const plan = planWrite({ op: "replace", resourceId: R, isAgent: false });
    expect(plan.checks).toEqual([{ resourceId: R, op: "write" }]);
  });

  it("delete requires the (destructive) delete bit on the resource", () => {
    const plan = planWrite({ op: "delete", resourceId: R, isAgent: false });
    expect(plan.checks).toEqual([{ resourceId: R, op: "delete" }]);
  });
});

describe("planWrite — agent If-Match requirement", () => {
  it("rejects an agent replace without If-Match", () => {
    expect(() => planWrite({ op: "replace", resourceId: R, isAgent: true })).toThrow(WriteError);
    try {
      planWrite({ op: "replace", resourceId: R, isAgent: true });
    } catch (e) {
      expect((e as WriteError).code).toBe("if_match_required");
    }
  });

  it("rejects an agent delete without If-Match", () => {
    expect(() => planWrite({ op: "delete", resourceId: R, isAgent: true })).toThrow(/If-Match/i);
  });

  it("allows an agent replace WITH a matching If-Match", () => {
    const plan = planWrite({ op: "replace", resourceId: R, isAgent: true, currentVersion: 3, ifMatch: 3 });
    expect(plan.requiresIfMatch).toBe(true);
    expect(plan.checks).toEqual([{ resourceId: R, op: "write" }]);
  });

  it("does NOT require If-Match for a human (non-agent) write", () => {
    expect(() => planWrite({ op: "replace", resourceId: R, isAgent: false })).not.toThrow();
  });

  it("create never requires If-Match (no prior version)", () => {
    expect(() => planWrite({ op: "create", parentId: PARENT, isAgent: true })).not.toThrow();
  });
});

describe("planWrite — concurrency + guards", () => {
  it("a stale If-Match is precondition_failed", () => {
    try {
      planWrite({ op: "replace", resourceId: R, isAgent: true, currentVersion: 5, ifMatch: 4 });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as WriteError).code).toBe("precondition_failed");
    }
  });

  it("rejects create without a parent, replace/delete without a resourceId", () => {
    expect(() => planWrite({ op: "create", isAgent: false })).toThrow(WriteError);
    expect(() => planWrite({ op: "replace", isAgent: false })).toThrow(WriteError);
    expect(() => planWrite({ op: "delete", isAgent: false })).toThrow(WriteError);
  });
});
