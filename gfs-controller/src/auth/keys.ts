import { createHash, createPublicKey } from "node:crypto";

export class KeyConfigError extends Error {
  readonly code = "unauthorized";
  constructor(message: string) {
    super(message);
    this.name = "KeyConfigError";
  }
}

/**
 * RFC 7638 JWK thumbprint of an RS256 public key. This MUST match the `kid`
 * that the control-api signer (`control-api/src/auth/gfsToken.ts`) stamps on
 * every gfs token, so gfsc can tie a token to the exact key it holds. The open
 * core uses one platform keypair; per-tenant, kid-selected keys are P6.
 */
export function keyThumbprint(publicKeyPem: string): string {
  const jwk = createPublicKey(publicKeyPem).export({ format: "jwk" }) as {
    kty: string;
    n: string;
    e: string;
  };
  // RFC 7638: required members only, lexicographic order, no whitespace.
  const canonical = JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n });
  return createHash("sha256").update(canonical).digest("base64url");
}

export interface VerificationKey {
  publicKey: string;
  keyId: string;
}

/**
 * Load the single platform verification key from config (ConfigMap-provided).
 * FAIL CLOSED: gfsc cannot verify any token without it, so an absent or
 * malformed key is a hard error — gfsc must not start serving authorized reads.
 */
export function loadVerificationKey(publicKeyPem: string): VerificationKey {
  if (!publicKeyPem || publicKeyPem.trim() === "") {
    throw new KeyConfigError("gfsc public verification key is not configured");
  }
  try {
    return { publicKey: publicKeyPem, keyId: keyThumbprint(publicKeyPem) };
  } catch (err) {
    throw new KeyConfigError(
      `invalid gfsc public verification key: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
