/** Immutable SHA-256 SPKI identities of historically committed signing keys. */
export declare const HISTORICAL_PUBLIC_KEY_FINGERPRINTS: readonly string[]
export declare const MAX_PEM_MATERIAL_BYTES: 65536

export type JwtKeyMaterialReason =
  | 'invalid_type'
  | 'material_too_large'
  | 'invalid_pem'
  | 'multiple_pem_objects'
  | 'unsupported_pem_type'
  | 'encrypted_private_key'
  | 'wrong_key_role'
  | 'non_rsa_key'
  | 'undersized_rsa_key'
  | 'banned_identity'

export declare class JwtKeyMaterialError extends Error {
  readonly code: 'ERR_JWT_KEY_INVALID' | 'ERR_JWT_KEY_BANNED'
  readonly reason: JwtKeyMaterialReason
  /** Safe caller-supplied diagnostic label, never cryptographic material. */
  readonly source: string
  constructor(source: string, reason: JwtKeyMaterialReason)
}

export interface SigningMaterial {
  privatePem: string
  publicPem: string
  fingerprint: string
}
export interface VerifierMaterial {
  publicPem: string
  fingerprint: string
}
export interface JwtFingerprintOptions {
  /** Additional denied identities; the historical default cannot be disabled. */
  fingerprints?: Iterable<string>
}
export interface JwtVerifierOptions extends JwtFingerprintOptions {
  /** Environment inputs retain legacy private-key carriers; public stores forbid them. */
  origin?: 'environment' | 'store'
}

/** Normalize literal and escaped LF/CRLF/CR within the 64 KiB material bound. */
export declare function normalizePem(raw: string): string
export declare function parseSigningMaterial(
  raw: string,
  source: string,
  options?: JwtFingerprintOptions
): SigningMaterial
export declare function parseVerifierMaterial(
  raw: string,
  source: string,
  options?: JwtVerifierOptions
): VerifierMaterial
/** Canonical identity metadata; this helper intentionally does not apply the denylist. */
export declare function publicKeyPemFingerprint(pem: string): string
export declare function isBannedSigningKeyPem(pem: string, fingerprints?: Iterable<string>): boolean
export declare function isBannedPublicKeyPem(pem: string, fingerprints?: Iterable<string>): boolean
