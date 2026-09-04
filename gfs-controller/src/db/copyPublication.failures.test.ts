import { describe, expect, it, vi } from "vitest";
import { copyFixture } from "../../test/copyPublicationTestKit";

describe("copy rollback and ambiguous commit outcomes", () => {
  it.each([1, 2])("cleans completed candidates and retains file %s manifest when staging hits ENOSPC", async failWriteAt => {
    const fixture = copyFixture();
    fixture.blobs.failWriteAt = failWriteAt;
    await expect(fixture.writes.copy(fixture.input)).rejects.toMatchObject({ code: "ENOSPC" });
    expect(fixture.db.resources.size).toBe(6);
    expect([...fixture.db.manifests.values()]).toEqual(["staged"]);
    expect(fixture.blobs.deletes).toHaveLength(failWriteAt - 1);
  });

  it("fails capacity before allocating identities or staging a blob", async () => {
    const fixture = copyFixture();
    fixture.blobs.capacity = fixture.input.plan.totalBytes - 1n;
    await expect(fixture.writes.copy(fixture.input)).rejects.toMatchObject({ code: "payload_too_large" });
    expect(fixture.blobs.writes).toEqual([]);
    expect(fixture.db.manifests.size).toBe(0);
    expect(fixture.audit.records).toHaveLength(1);
    expect(fixture.audit.records[0]).toMatchObject({ transactional: false, event: {
      recordType: "mutation_outcome", resourceId: fixture.input.plan.nodes[0].resourceId.replaceAll("-", ""),
      outcome: "error", mutationOutcome: "failed", requestId: fixture.input.requestId,
    } });
  });

  it("audits a deadline failure that occurs before capacity and staging", async () => {
    const fixture = copyFixture();
    const audit = vi.spyOn(fixture.audit, "record");
    fixture.input.now = () => 1000;
    await expect(fixture.writes.copy(fixture.input)).rejects.toMatchObject({ code: "precondition_failed" });
    expect(fixture.blobs.capacityCalls).toBe(0);
    expect(fixture.audit.records).toHaveLength(1);
    expect(fixture.audit.records[0]).toMatchObject({ transactional: false, event: { mutationOutcome: "failed" } });
    expect(audit.mock.calls[0][2]).toMatchObject({ deadlineAtMs: expect.any(Number) });
  });

  it("propagates an append failure from the definitive failed-outcome audit", async () => {
    const fixture = copyFixture();
    fixture.blobs.capacity = 0n;
    fixture.audit.failOutside = true;
    await expect(fixture.writes.copy(fixture.input)).rejects.toThrow("failure audit failed");
  });

  it("rolls back and cleans every candidate on metadata or manifest publication failures", async () => {
    const metadata = copyFixture();
    metadata.db.failInsert = new Error("metadata failed");
    await expect(metadata.writes.copy(metadata.input)).rejects.toThrow("metadata failed");
    expect(metadata.blobs.deletes).toHaveLength(2);
    expect(metadata.db.manifests.size).toBe(0);

    const manifests = copyFixture();
    manifests.db.failCommitManifests = true;
    await expect(manifests.writes.copy(manifests.input)).rejects.toThrow("manifest commit failed");
    expect(manifests.db.resources.size).toBe(6);
    expect(manifests.blobs.deletes).toHaveLength(2);
  });

  it("rolls back a failed atomic success audit, cleans blobs, then records failure outside the transaction", async () => {
    const fixture = copyFixture();
    fixture.audit.failTransactional = true;
    await expect(fixture.writes.copy(fixture.input)).rejects.toThrow("success audit failed");
    expect(fixture.db.resources.size).toBe(6);
    expect(fixture.db.manifests.size).toBe(0);
    expect(fixture.blobs.deletes).toHaveLength(2);
    expect(fixture.audit.records).toHaveLength(2);
    expect(fixture.audit.records[0]).toMatchObject({ transactional: true, event: { mutationOutcome: "succeeded" } });
    expect(fixture.audit.records[1]).toMatchObject({ transactional: false, event: { mutationOutcome: "failed", outcome: "error" } });
  });

  it("maps a publication unique violation to already_exists and cleans candidates", async () => {
    const fixture = copyFixture();
    fixture.db.failInsert = Object.assign(new Error("duplicate"), { code: "23505" });
    await expect(fixture.writes.copy(fixture.input)).rejects.toMatchObject({ code: "already_exists" });
    expect(fixture.blobs.deletes).toHaveLength(2);
  });

  it("times out before commit, rolls back metadata and preserves unresolved candidates for reconciliation", async () => {
    const fixture = copyFixture();
    let calls = 0;
    fixture.input.now = () => (++calls > 8 ? 1000 : 0);
    await expect(fixture.writes.copy(fixture.input)).rejects.toMatchObject({ code: "precondition_failed" });
    expect(fixture.db.resources.size).toBe(6);
    expect(fixture.db.manifests.size).toBeGreaterThan(0);
  });

  it("treats an exact fully published ambiguous commit as success after the request is aborted", async () => {
    const fixture = copyFixture({ ambiguity: "full", abortOnAmbiguity: true });
    await expect(fixture.writes.copy(fixture.input)).resolves.toMatchObject({
      objectCount: 4,
      root: { updatedAt: "2026-01-01T00:00:00.000Z" },
    });
    expect(fixture.input.signal?.aborted).toBe(true);
    expect(fixture.db.manifests.size).toBe(0);
    expect(fixture.blobs.deletes).toEqual([]);
    expect(fixture.audit.records).toHaveLength(1);
    expect(fixture.audit.records[0]).toMatchObject({ transactional: true, event: { mutationOutcome: "succeeded" } });
  });

  it("cleans an exact-zero ambiguous rollback after the request is aborted", async () => {
    const zero = copyFixture({ ambiguity: "zero", abortOnAmbiguity: true });
    await expect(zero.writes.copy(zero.input)).rejects.toMatchObject({ name: "CommitOutcomeUnknownError" });
    expect(zero.input.signal?.aborted).toBe(true);
    expect(zero.db.manifests.size).toBe(0);
    expect(zero.blobs.deletes).toHaveLength(2);
    expect(zero.audit.records.map(record => record.event.mutationOutcome)).toEqual(["succeeded", "failed"]);
  });

  it("retains subset candidates without a definitive audit after the request is aborted", async () => {
    const subset = copyFixture({ ambiguity: "subset", abortOnAmbiguity: true });
    await expect(subset.writes.copy(subset.input)).rejects.toMatchObject({ name: "CommitOutcomeUnknownError" });
    expect(subset.input.signal?.aborted).toBe(true);
    expect(subset.db.manifests.size).toBe(2);
    expect(subset.blobs.deletes).toEqual([]);
    expect(subset.audit.records.filter(record => !record.transactional)).toEqual([]);
  });

  it("retains every candidate without a definitive audit when aborted inspection is unavailable", async () => {
    const fixture = copyFixture({ ambiguity: "full", inspectUnavailable: true, abortOnAmbiguity: true });
    await expect(fixture.writes.copy(fixture.input)).rejects.toMatchObject({ name: "CommitOutcomeUnknownError" });
    expect(fixture.input.signal?.aborted).toBe(true);
    expect(fixture.db.manifests.size).toBe(2);
    expect(fixture.blobs.deletes).toEqual([]);
    expect(fixture.audit.records.filter(record => !record.transactional)).toEqual([]);
  });
});
