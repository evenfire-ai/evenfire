import { describe, expect, it } from "vitest";
import { appendRow, type AuditRow, verifyChain } from "./chain.js";

/**
 * P4-S02 — append-only hash-chained audit. A valid chain verifies; any in-band
 * edit, deletion, or reorder breaks verification. Denials chain like mutations.
 */

function buildChain(): AuditRow[] {
  const r1 = appendRow(null, { subject: "user:a", op: "grant.put", gfsUri: "gfs://main/x", outcome: "allowed" });
  const r2 = appendRow(r1, { subject: "host:1st:mcp-host/standalone", op: "gfs_read", gfsUri: "gfs://main/y", outcome: "denied" });
  const r3 = appendRow(r2, { subject: "user:a", op: "resource.move", gfsUri: "gfs://main/x", outcome: "allowed" });
  return [r1, r2, r3];
}

describe("audit chain", () => {
  it("builds a monotonic, linked chain", () => {
    const [r1, r2, r3] = buildChain();
    expect(r1.sequenceNo).toBe(1);
    expect(r1.prevHash).toBeNull();
    expect(r2.sequenceNo).toBe(2);
    expect(r2.prevHash).toBe(r1.rowHash);
    expect(r3.prevHash).toBe(r2.rowHash);
    // denials are recorded in the chain like any other row.
    expect(r2.outcome).toBe("denied");
  });

  it("verifies a pristine chain", () => {
    expect(verifyChain(buildChain())).toEqual({ valid: true });
  });

  it("detects an in-band content edit (row_hash_mismatch)", () => {
    const chain = buildChain();
    chain[1] = { ...chain[1], outcome: "allowed" }; // flip a denial to allowed
    const v = verifyChain(chain);
    expect(v.valid).toBe(false);
    expect(v.reason).toBe("row_hash_mismatch");
    expect(v.brokenAt).toBe(2);
  });

  it("detects a deleted row (prev_hash / sequence break)", () => {
    const chain = buildChain();
    const tampered = [chain[0], chain[2]]; // drop row 2
    const v = verifyChain(tampered);
    expect(v.valid).toBe(false);
    // row 3 now appears at the wrong sequence position relative to row 1.
    expect(["sequence_gap_or_reorder", "prev_hash_mismatch"]).toContain(v.reason);
  });

  it("detects a reorder", () => {
    const [r1, r2, r3] = buildChain();
    const v = verifyChain([r1, r3, r2]);
    expect(v.valid).toBe(false);
  });
});
