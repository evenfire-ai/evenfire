import { describe, expect, it } from "vitest";
import { toResponse } from "./envelope";
import { GfsError } from "./errors";

describe("database error envelopes", () => {
  it("maps only the governed-root check and leaves other checks internal", () => {
    expect(toResponse({ code: "23514", constraint: "gfs_governed_root_immutable" })).toEqual({
      status: 409,
      body: { ok: false, error: { code: "governed_root_immutable", message: "governed root is immutable" } },
    });
    expect(toResponse({ code: "23514", constraint: "some_other_check" })).toEqual({
      status: 500,
      body: { ok: false, error: { code: "internal", message: "internal server error" } },
    });
    expect(toResponse({ code: "23505", constraint: "gfs_governed_root_immutable" }).status).toBe(500);
    expect(toResponse(new GfsError("not_found", "missing")).status).toBe(404);
  });
});
