import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import jwt from "jsonwebtoken";
import { KeyConfigError, loadVerificationKey } from "./keys";
import { GfsAuthError, verifyGfsToken } from "./verify";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const otherPair = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const key = loadVerificationKey(publicKey);
const AUD = "gfs-controller";

function sign(
  payload: Record<string, unknown>,
  opts: { keyid?: string; audience?: string; issuer?: string; expiresIn?: number; signer?: string } = {}
): string {
  return jwt.sign(payload, opts.signer ?? privateKey, {
    algorithm: "RS256",
    keyid: opts.keyid ?? key.keyId,
    audience: opts.audience ?? AUD,
    issuer: opts.issuer ?? "control-api",
    expiresIn: opts.expiresIn ?? 300,
  });
}

function signWithLifetimeClaims(payload: Record<string, unknown>): string {
  return jwt.sign(payload, privateKey, {
    algorithm: "RS256",
    keyid: key.keyId,
    audience: AUD,
    issuer: "control-api",
    noTimestamp: true,
  });
}

const goodPayload = {
  sub: "user-1",
  drive: "main",
  scopes: ["gfs.read"],
  pathBindings: [{ path: "/org", permissions: ["read"] }],
};

const DESKTOP_USER_ID = "11111111-1111-4111-8111-111111111111";
const CONTROL_ADMIN_ID = "22222222-2222-4222-8222-222222222222";
const linkedAdminAuthority = {
  desktopUserId: DESKTOP_USER_ID,
  controlAdminId: CONTROL_ADMIN_ID,
  authoritySource: "linked-admin",
};

describe("loadVerificationKey", () => {
  it("FAILS CLOSED when the public key is absent", () => {
    expect(() => loadVerificationKey("")).toThrow(KeyConfigError);
    expect(() => loadVerificationKey("   ")).toThrow(KeyConfigError);
  });
});

describe("verifyGfsToken", () => {
  it("accepts a well-formed token and returns the claims", () => {
    const claims = verifyGfsToken(sign(goodPayload), { key, audience: AUD });
    expect(claims.sub).toBe("user-1");
    expect(claims.drive).toBe("main");
    expect(claims.scopes).toEqual(["gfs.read"]);
    expect(claims.pathBindings).toEqual([{ path: "/org", permissions: ["read"] }]);
    expect(claims.exp - claims.iat).toBe(300);
  });

  it("REJECTS a token signed by a different key (bad signature)", () => {
    const token = sign(goodPayload, { signer: otherPair.privateKey });
    expect(() => verifyGfsToken(token, { key, audience: AUD })).toThrow(GfsAuthError);
  });

  it("REJECTS the wrong audience", () => {
    const token = sign(goodPayload, { audience: "rpc-proxy" });
    expect(() => verifyGfsToken(token, { key, audience: AUD })).toThrow(GfsAuthError);
  });

  it("REJECTS the wrong issuer", () => {
    const token = sign(goodPayload, { issuer: "someone-else" });
    expect(() => verifyGfsToken(token, { key, audience: AUD })).toThrow(GfsAuthError);
  });

  it("REJECTS an expired token", () => {
    const token = sign(goodPayload, { expiresIn: -10 });
    expect(() => verifyGfsToken(token, { key, audience: AUD })).toThrow(GfsAuthError);
  });

  it("REJECTS a token whose kid does not match the configured key", () => {
    const token = sign(goodPayload, { keyid: "not-the-thumbprint" });
    expect(() => verifyGfsToken(token, { key, audience: AUD })).toThrow(
      /kid does not match/
    );
  });

  it("REJECTS a token missing kid entirely", () => {
    const token = jwt.sign(goodPayload, privateKey, {
      algorithm: "RS256",
      audience: AUD,
      issuer: "control-api",
      expiresIn: 300,
    });
    expect(() => verifyGfsToken(token, { key, audience: AUD })).toThrow(GfsAuthError);
  });

  it("REJECTS an unknown scope (no privilege smuggling)", () => {
    const token = sign({ ...goodPayload, scopes: ["gfs.read", "gfs.superuser"] });
    expect(() => verifyGfsToken(token, { key, audience: AUD })).toThrow(/invalid scope/);
  });

  it("REJECTS missing sub / drive / scopes", () => {
    expect(() => verifyGfsToken(sign({ drive: "main", scopes: [] }), { key, audience: AUD })).toThrow(
      GfsAuthError
    );
    expect(() => verifyGfsToken(sign({ sub: "u", scopes: [] }), { key, audience: AUD })).toThrow(
      GfsAuthError
    );
    expect(() => verifyGfsToken(sign({ sub: "u", drive: "main" }), { key, audience: AUD })).toThrow(
      GfsAuthError
    );
  });

  it("REJECTS malformed pathBindings", () => {
    const token = sign({ ...goodPayload, pathBindings: [{ path: 42, permissions: ["read"] }] });
    expect(() => verifyGfsToken(token, { key, audience: AUD })).toThrow(GfsAuthError);
  });

  it("REJECTS a garbage token string", () => {
    expect(() => verifyGfsToken("not-a-jwt", { key, audience: AUD })).toThrow(GfsAuthError);
  });

  it("accepts a complete signed linked-admin broker claim without conflating token subject and actor", () => {
    const claims = verifyGfsToken(
      sign({
        ...goodPayload,
        sub: CONTROL_ADMIN_ID,
        principalType: "control-admin",
        brokeredAuthority: linkedAdminAuthority,
      }),
      { key, audience: AUD }
    );

    expect(claims.sub).toBe(CONTROL_ADMIN_ID);
    expect(claims.brokeredAuthority).toEqual(linkedAdminAuthority);
  });

  it.each([
    { desktopUserId: DESKTOP_USER_ID, controlAdminId: CONTROL_ADMIN_ID },
    { ...linkedAdminAuthority, authoritySource: "user-session" },
    { ...linkedAdminAuthority, desktopUserId: "not-a-uuid" },
    { ...linkedAdminAuthority, controlAdminId: "not-a-uuid" },
  ])("rejects malformed brokered authority metadata: %j", brokeredAuthority => {
    const token = sign({ ...goodPayload, sub: CONTROL_ADMIN_ID, brokeredAuthority });
    expect(() => verifyGfsToken(token, { key, audience: AUD })).toThrow(GfsAuthError);
  });

  it("rejects broker metadata whose effective admin differs from the signed token subject", () => {
    const token = sign({
      ...goodPayload,
      sub: DESKTOP_USER_ID,
      principalType: "control-admin",
      brokeredAuthority: linkedAdminAuthority,
    });
    expect(() => verifyGfsToken(token, { key, audience: AUD })).toThrow(GfsAuthError);
  });

  it("rejects broker metadata without explicit control-admin provenance", () => {
    const token = sign({
      ...goodPayload,
      sub: CONTROL_ADMIN_ID,
      brokeredAuthority: linkedAdminAuthority,
    });
    expect(() => verifyGfsToken(token, { key, audience: AUD })).toThrow(
      /requires control-admin principalType/
    );
  });

  it("accepts the signed user principal marker and rejects unknown markers", () => {
    expect(
      verifyGfsToken(sign({ ...goodPayload, principalType: "user" }), { key, audience: AUD })
        .principalType
    ).toBe("user");
    expect(() =>
      verifyGfsToken(sign({ ...goodPayload, principalType: "operator" }), { key, audience: AUD })
    ).toThrow(/invalid principalType/);
  });
});

describe("verifyGfsToken lifetime claim requirements", () => {
  it("REJECTS a signed sample with no expiration", () => {
    const sample = signWithLifetimeClaims(goodPayload);
    expect(() => verifyGfsToken(sample, { key, audience: AUD })).toThrow(GfsAuthError);
  });

  it("REJECTS a signed sample with no issuance time", () => {
    const sample = signWithLifetimeClaims({
      ...goodPayload,
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    expect(() => verifyGfsToken(sample, { key, audience: AUD })).toThrow(GfsAuthError);
  });

  it("REJECTS a signed sample whose lifetime is not positive", () => {
    const now = Math.floor(Date.now() / 1000);
    const sample = signWithLifetimeClaims({ ...goodPayload, iat: now, exp: now });
    expect(() => verifyGfsToken(sample, { key, audience: AUD })).toThrow(GfsAuthError);
  });
});

describe("verifyGfsToken path binding requirements", () => {
  it("normalizes one trailing slash", () => {
    const claims = verifyGfsToken(
      sign({ ...goodPayload, pathBindings: [{ path: "/org/eng/", permissions: ["read"] }] }),
      { key, audience: AUD }
    );
    expect(claims.pathBindings).toEqual([{ path: "/org/eng", permissions: ["read"] }]);
  });

  it.each(["", "org/eng", "////", "/org//eng", "/org/../secret"])(
    "REJECTS path binding %s",
    (path) => {
      const sample = sign({ ...goodPayload, pathBindings: [{ path, permissions: ["read"] }] });
      expect(() => verifyGfsToken(sample, { key, audience: AUD })).toThrow(GfsAuthError);
    }
  );
});
