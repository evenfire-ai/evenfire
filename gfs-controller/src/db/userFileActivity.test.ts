import { describe, expect, it, vi } from "vitest";
import { recordAgentFileActivity, recordUserFileActivity } from "./userFileActivity";

const HOST = "host:1st:mcp-host/chatllm";
const RUN = "11111111-1111-4111-8111-111111111111";
const RID = "22222222-2222-4222-8222-222222222222";

describe("recordAgentFileActivity", () => {
  it("issues exactly one autocommit query and never checks a client out of the pool", async () => {
    const query = vi.fn(async () => ({ rows: [{ gfs_record_agent_file_activity: "recorded" }] }));
    const pool = {
      query,
      // If the recorder ever took this path the read would run in a transaction
      // the content read does not have.
      connect: vi.fn(),
    };

    await expect(
      recordAgentFileActivity(pool, HOST, RUN, [RID]),
    ).resolves.toBe("recorded");

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toBe(
      "SELECT public.gfs_record_agent_file_activity($1, $2::uuid, $3::uuid[])",
    );
    expect(query.mock.calls[0]?.[1]).toEqual([HOST, RUN, [RID]]);
    expect(pool.connect).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => /^(BEGIN|COMMIT|ROLLBACK)/i.test(String(sql)))).toBe(
      false,
    );
  });

  it.each([
    "no_binding",
    "host_mismatch",
    "excluded_origin",
    "binding_without_namespace",
  ] as const)("passes %s through unchanged", async status => {
    const query = vi.fn(async () => ({ rows: [{ gfs_record_agent_file_activity: status }] }));
    await expect(recordAgentFileActivity({ query }, HOST, RUN, [RID])).resolves.toBe(status);
  });

  it("throws on a status the database does not define instead of guessing", async () => {
    const query = vi.fn(async () => ({ rows: [{ gfs_record_agent_file_activity: "maybe" }] }));
    await expect(recordAgentFileActivity({ query }, HOST, RUN, [RID])).rejects.toThrow(
      /unknown status: maybe/,
    );

    const empty = vi.fn(async () => ({ rows: [] }));
    await expect(recordAgentFileActivity({ query: empty }, HOST, RUN, [RID])).rejects.toThrow(
      /unknown status/,
    );
  });
});

describe("recordUserFileActivity", () => {
  it("calls the user function with the actor and the ids on the transaction client", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await recordUserFileActivity({ query }, "33333333-3333-4333-8333-333333333333", [RID]);

    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      "SELECT gfs_record_user_file_activity($1::uuid, $2::uuid[])",
      ["33333333-3333-4333-8333-333333333333", [RID]],
    );
  });
});
