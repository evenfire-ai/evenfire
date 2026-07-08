import { describe, expect, it } from "vitest";
import { checkTokenCeiling } from "./tokenCeiling";
import type { GfsScope } from "../auth/verify";

const ALL_SCOPES: GfsScope[] = ["gfs.read", "gfs.write", "gfs.delete", "gfs.manage_acl", "gfs.share"];

describe("checkTokenCeiling — clause (a) capability ceiling", () => {
  it("denies when the op's scope bit is absent (read op, no gfs.read)", () => {
    const res = checkTokenCeiling({
      scopes: ["gfs.write"],
      pathBindings: [],
      op: "read",
      resourcePath: "/docs/x.txt",
    });
    expect(res).toEqual({ allowed: false, reason: "scope_not_in_token" });
  });

  it("maps each op to its gfs.* scope (delete needs gfs.delete, not gfs.write)", () => {
    expect(checkTokenCeiling({ scopes: ["gfs.write"], pathBindings: [], op: "delete", resourcePath: null }).allowed).toBe(
      false
    );
    expect(checkTokenCeiling({ scopes: ["gfs.delete"], pathBindings: [], op: "delete", resourcePath: null }).allowed).toBe(
      true
    );
  });
});

describe("checkTokenCeiling — clause (b) empty pathBindings pass-through", () => {
  it("passes an unscoped token (empty pathBindings) — the store then governs", () => {
    // This is the P1 case: control-api mints pathBindings: [] deliberately.
    const res = checkTokenCeiling({
      scopes: ALL_SCOPES,
      pathBindings: [],
      op: "read",
      resourcePath: null, // unknown path is irrelevant when there is no narrowing
    });
    expect(res).toEqual({ allowed: true, reason: "ok" });
  });
});

describe("checkTokenCeiling — clause (b) path-scoped binding", () => {
  it("allows when a binding is ON the resource path and carries the op", () => {
    const res = checkTokenCeiling({
      scopes: ALL_SCOPES,
      pathBindings: [{ path: "/org/eng/scratch/report.pdf", permissions: ["read", "write"] }],
      op: "read",
      resourcePath: "/org/eng/scratch/report.pdf",
    });
    expect(res).toEqual({ allowed: true, reason: "ok" });
  });

  it("allows when a binding is on an ANCESTOR directory of the resource", () => {
    const res = checkTokenCeiling({
      scopes: ALL_SCOPES,
      pathBindings: [{ path: "/org/eng", permissions: ["read"] }],
      op: "read",
      resourcePath: "/org/eng/scratch/report.pdf",
    });
    expect(res.allowed).toBe(true);
  });

  it("root binding '/' covers any resource", () => {
    const res = checkTokenCeiling({
      scopes: ALL_SCOPES,
      pathBindings: [{ path: "/", permissions: ["read"] }],
      op: "read",
      resourcePath: "/anything/deep/file.txt",
    });
    expect(res.allowed).toBe(true);
  });

  it("denies when the binding carries a DIFFERENT permission than the op", () => {
    const res = checkTokenCeiling({
      scopes: ALL_SCOPES,
      pathBindings: [{ path: "/org/eng", permissions: ["read"] }],
      op: "write",
      resourcePath: "/org/eng/scratch/report.pdf",
    });
    expect(res).toEqual({ allowed: false, reason: "no_path_binding_covers" });
  });

  it("denies a sibling-prefix that is NOT a segment ancestor ('/doc' vs '/docs/x')", () => {
    const res = checkTokenCeiling({
      scopes: ALL_SCOPES,
      pathBindings: [{ path: "/doc", permissions: ["read"] }],
      op: "read",
      resourcePath: "/docs/x.txt",
    });
    expect(res).toEqual({ allowed: false, reason: "no_path_binding_covers" });
  });

  it("treats a trailing slash on the binding as equivalent ('/org/eng/' covers child)", () => {
    const res = checkTokenCeiling({
      scopes: ALL_SCOPES,
      pathBindings: [{ path: "/org/eng/", permissions: ["read"] }],
      op: "read",
      resourcePath: "/org/eng/file.txt",
    });
    expect(res.allowed).toBe(true);
  });

  it("fails closed when a narrowing token is present but the resource path is unknown", () => {
    const res = checkTokenCeiling({
      scopes: ALL_SCOPES,
      pathBindings: [{ path: "/org/eng", permissions: ["read"] }],
      op: "read",
      resourcePath: null,
    });
    expect(res).toEqual({ allowed: false, reason: "resource_path_unknown" });
  });
});
