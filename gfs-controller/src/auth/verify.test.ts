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
