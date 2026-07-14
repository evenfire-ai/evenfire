import { describe, expect, it } from "vitest";
import { assertIfMatch, MoveError, normalizeName, planMove } from "./move.js";

/**
 * P2-S05 — move/rename validation (spec §Move, rename, delete). rename → write
 * on the resource; move → write+delete on source parent + write on dest parent;
 * never crosses drive; stale If-Match → precondition_failed.
 */

const R = "res-1";
const SRC_PARENT = "src-parent";
const DEST_PARENT = "dest-parent";

describe("normalizeName", () => {
  it("accepts a normal name and NFC-normalizes it", () => {
    expect(normalizeName("Report.md")).toBe("Report.md");
    expect(normalizeName("My Report.md")).toBe("My Report.md"); // spaces valid
    // é as decomposed e + combining accent → composed form
    expect(normalizeName("café")).toBe("café");
  });

  it("rejects empty, dot, dotdot, slash and over-long names", () => {
    const notThrown: string[] = [];
    for (const bad of ["", ".", "..", "a/b", "x".repeat(256)]) {
      try {
        normalizeName(bad);
        notThrown.push(JSON.stringify(bad.length > 20 ? `len${bad.length}` : bad));
      } catch {
        /* expected */
      }
    }
    expect(notThrown).toEqual([]);
  });
});

describe("assertIfMatch", () => {
  it("passes when no If-Match is given or it matches", () => {
    expect(() => assertIfMatch(3)).not.toThrow();
    expect(() => assertIfMatch(3, 3)).not.toThrow();
  });
  it("throws precondition_failed on a stale If-Match", () => {
    expect(() => assertIfMatch(4, 3)).toThrow(MoveError);
    try {
      assertIfMatch(4, 3);
    } catch (e) {
      expect((e as MoveError).code).toBe("precondition_failed");
    }
  });
});

describe("planMove — rename", () => {
  it("requires write on the resource and bumps version", () => {
    const plan = planMove({
      resourceId: R,
      sourceDrive: "main",
      sourceParentId: SRC_PARENT,
      currentVersion: 2,
      newName: "renamed.md",
    });
    expect(plan.kind).toBe("rename");
    expect(plan.name).toBe("renamed.md");
    expect(plan.checks).toEqual([{ resourceId: R, op: "write" }]);
    expect(plan.nextVersion).toBe(3);
  });
});

describe("planMove — move", () => {
  it("requires write+delete on source parent and write on dest parent", () => {
    const plan = planMove({
      resourceId: R,
      sourceDrive: "main",
      sourceParentId: SRC_PARENT,
      currentVersion: 0,
      newParentId: DEST_PARENT,
      destDrive: "main",
    });
    expect(plan.kind).toBe("move");
    expect(plan.newParentId).toBe(DEST_PARENT);
    expect(plan.checks).toEqual([
      { resourceId: SRC_PARENT, op: "write" },
      { resourceId: SRC_PARENT, op: "delete" },
      { resourceId: DEST_PARENT, op: "write" },
    ]);
  });

  it("forbids a cross-drive move (cross_boundary)", () => {
    expect(() =>
      planMove({
        resourceId: R,
        sourceDrive: "main",
        sourceParentId: SRC_PARENT,
        currentVersion: 0,
        newParentId: DEST_PARENT,
        destDrive: "other",
      })
    ).toThrow(/cross/i);
  });

  it("forbids moving the drive root", () => {
    expect(() =>
      planMove({
        resourceId: R,
        sourceDrive: "main",
        sourceParentId: null,
        currentVersion: 0,
        newParentId: DEST_PARENT,
        destDrive: "main",
      })
    ).toThrow(MoveError);
  });

  it("requires destDrive for a move (fail-closed, no cross-drive slip-through)", () => {
    expect(() =>
      planMove({
        resourceId: R,
        sourceDrive: "main",
        sourceParentId: SRC_PARENT,
        currentVersion: 0,
        newParentId: DEST_PARENT,
        // destDrive omitted
      })
    ).toThrow(MoveError);
  });

  it("forbids moving a resource into itself (cycle)", () => {
    expect(() =>
      planMove({
        resourceId: R,
        sourceDrive: "main",
        sourceParentId: SRC_PARENT,
        currentVersion: 0,
        newParentId: R,
        destDrive: "main",
      })
    ).toThrow(/subtree/i);
  });

  it("forbids moving a resource into its own descendant (cycle)", () => {
    expect(() =>
      planMove({
        resourceId: R,
        sourceDrive: "main",
        sourceParentId: SRC_PARENT,
        currentVersion: 0,
        newParentId: DEST_PARENT,
        destDrive: "main",
        destAncestors: [DEST_PARENT, R], // R is an ancestor of the destination
      })
    ).toThrow(/subtree/i);
  });
});

describe("planMove — combined + guards", () => {
  it("supports rename+move with all checks", () => {
    const plan = planMove({
      resourceId: R,
      sourceDrive: "main",
      sourceParentId: SRC_PARENT,
      currentVersion: 1,
      newName: "x.md",
      newParentId: DEST_PARENT,
      destDrive: "main",
    });
    expect(plan.kind).toBe("rename+move");
    expect(plan.checks).toContainEqual({ resourceId: R, op: "write" });
    expect(plan.checks).toContainEqual({ resourceId: DEST_PARENT, op: "write" });
  });

  it("rejects a no-op request (neither rename nor move)", () => {
    expect(() =>
      planMove({ resourceId: R, sourceDrive: "main", sourceParentId: SRC_PARENT, currentVersion: 0 })
    ).toThrow(MoveError);
  });

  it("rejects a stale If-Match before doing anything", () => {
    expect(() =>
      planMove({
        resourceId: R,
        sourceDrive: "main",
        sourceParentId: SRC_PARENT,
        currentVersion: 5,
        newName: "x.md",
        ifMatch: 4,
      })
    ).toThrow(MoveError);
  });
});
