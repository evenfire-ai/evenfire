import jwt from "jsonwebtoken";
import { VerificationKey } from "./keys";

export type GfsScope =
  | "gfs.read"
  | "gfs.write"
  | "gfs.delete"
  | "gfs.manage_acl"
  | "gfs.share";

const VALID_SCOPES = new Set<string>([
  "gfs.read",
  "gfs.write",
  "gfs.delete",
  "gfs.manage_acl",
  "gfs.share",
]);

export interface GfsPathBinding {
  path: string;
  permissions: string[];
}

export interface GfsVerifiedClaims {
  sub: string;
  drive: string;
  scopes: GfsScope[];
  pathBindings: GfsPathBinding[];
  iat: number;
  exp: number;
}

export class GfsAuthError extends Error {
  readonly code = "unauthorized";
  constructor(message: string) {
    super(message);
    this.name = "GfsAuthError";
  }
}

export interface VerifyOptions {
  key: VerificationKey;
  audience: string;
  issuer?: string;
}

function parsePathBindings(raw: unknown): GfsPathBinding[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new GfsAuthError("pathBindings must be an array");
  return raw.map((entry, i) => {
    const e = entry as { path?: unknown; permissions?: unknown };
    if (typeof e.path !== "string") {
      throw new GfsAuthError(`pathBindings[${i}].path must be a string`);
    }
    if (!Array.isArray(e.permissions) || e.permissions.some((p) => typeof p !== "string")) {
      throw new GfsAuthError(`pathBindings[${i}].permissions must be a string[]`);
    }
    return { path: normalizePathBindingPath(e.path, i), permissions: e.permissions as string[] };
  });
}

function normalizePathBindingPath(path: string, index: number): string {
  if (path.length === 0 || path.trim() !== path) {
    throw new GfsAuthError(`pathBindings[${index}].path must be a canonical absolute path`);
  }
  if (!path.startsWith("/")) {
    throw new GfsAuthError(`pathBindings[${index}].path must be absolute`);
  }
  if (path !== "/" && /^\/+$/.test(path)) {
    throw new GfsAuthError(`pathBindings[${index}].path must not be slash-only`);
  }

  const normalized = path.length > 1 ? path.replace(/\/+$/, "") : path;
  if (normalized === "/") return normalized;

  const segments = normalized.slice(1).split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new GfsAuthError(`pathBindings[${index}].path contains an invalid segment`);
  }
  return normalized;
}

/**
 * Verify a gfs access token. Checks, in order: the `kid` matches the key gfsc
 * holds, then the RS256 signature, audience, issuer, and expiry, then the claim
 * shape. FAIL CLOSED — every failure throws GfsAuthError (→ 401); a token is
 * never trusted on a partial check.
 *
 * The token is only an UPPER BOUND on authority. The permission store is the
 * source of truth and is re-checked on every op (P1-S08); these verified
 * scopes/pathBindings never, by themselves, grant access.
 */
export function verifyGfsToken(token: string, opts: VerifyOptions): GfsVerifiedClaims {
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || typeof decoded === "string") {
    throw new GfsAuthError("malformed token");
  }
  if (decoded.header.kid !== opts.key.keyId) {
    throw new GfsAuthError("token kid does not match the configured signing key");
  }

  let payload: jwt.JwtPayload;
  try {
    const verified = jwt.verify(token, opts.key.publicKey, {
      algorithms: ["RS256"],
      audience: opts.audience,
      issuer: opts.issuer ?? "control-api",
    });
    if (typeof verified === "string") throw new GfsAuthError("unexpected string payload");
    payload = verified;
  } catch (err) {
    if (err instanceof GfsAuthError) throw err;
    throw new GfsAuthError(err instanceof Error ? err.message : "token verification failed");
  }

  const record = payload as Record<string, unknown>;
  const sub = record.sub;
  const drive = record.drive;
  const rawScopes = record.scopes;
  const iat = record.iat;
  const exp = record.exp;

  if (typeof sub !== "string" || sub.length === 0) throw new GfsAuthError("missing sub");
  if (typeof drive !== "string" || drive.length === 0) throw new GfsAuthError("missing drive");
  if (!Array.isArray(rawScopes)) throw new GfsAuthError("missing scopes");
  if (!Number.isSafeInteger(iat)) throw new GfsAuthError("missing or invalid iat");
  if (!Number.isSafeInteger(exp)) throw new GfsAuthError("missing or invalid exp");
  const issuedAt = iat as number;
  const expiresAt = exp as number;
  if (expiresAt <= issuedAt) throw new GfsAuthError("token exp must be after iat");

  const scopes: GfsScope[] = [];
  for (const scope of rawScopes) {
    if (typeof scope !== "string" || !VALID_SCOPES.has(scope)) {
      throw new GfsAuthError(`invalid scope: ${String(scope)}`);
    }
    scopes.push(scope as GfsScope);
  }

  return {
    sub,
    drive,
    scopes,
    pathBindings: parsePathBindings(record.pathBindings),
    iat: issuedAt,
    exp: expiresAt,
  };
}
