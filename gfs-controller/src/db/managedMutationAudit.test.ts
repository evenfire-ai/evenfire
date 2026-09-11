import { describe, expect, it, vi } from "vitest";
import type { AuditSink } from "../authz/audit";
import { recordManagedMutation } from "./managedMutationAudit";

describe("recordManagedMutation actor correlation", () => {
  it("persists linked authority on the mutation row with the same request id", async () => {
    const record = vi.fn<AuditSink["record"]>().mockResolvedValue(undefined);
    const desktopUserId = "11111111-1111-4111-8111-111111111111";
    const controlAdminId = "22222222-2222-4222-8222-222222222222";
    const requestId = "33333333-3333-4333-8333-333333333333";

    await recordManagedMutation(
      {
        subject: controlAdminId,
        requestId,
        audit: { record },
        actorOnBehalfOf: controlAdminId,
        desktopUserId,
        authoritySource: "linked-admin",
      },
      { op: "create", resourceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", drive: "main" },
      "succeeded"
    );

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: controlAdminId,
        actorOnBehalfOf: controlAdminId,
        desktopUserId,
        authoritySource: "linked-admin",
        requestId,
        op: "create",
        outcome: "allow",
        recordType: "mutation_outcome",
        mutationOutcome: "succeeded",
      }),
      undefined
    );
  });

  it("persists ordinary Desktop authority with no effective admin", async () => {
    const record = vi.fn<AuditSink["record"]>().mockResolvedValue(undefined);
    const desktopUserId = "11111111-1111-4111-8111-111111111111";

    await recordManagedMutation(
      {
        subject: desktopUserId,
        requestId: "33333333-3333-4333-8333-333333333333",
        audit: { record },
        actorOnBehalfOf: null,
        desktopUserId,
        authoritySource: "user-session",
      },
      { op: "replace", resourceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", drive: "main" },
      "failed",
      "precondition_failed"
    );

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: desktopUserId,
        actorOnBehalfOf: null,
        desktopUserId,
        authoritySource: "user-session",
        recordType: "mutation_outcome",
        mutationOutcome: "failed",
      }),
      undefined
    );
  });
});
