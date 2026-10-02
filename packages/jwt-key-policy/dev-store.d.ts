export type DevJwtSlot = 'rpc' | 'session' | 'admin'

export interface DevSigningMaterial {
  readonly privatePem: string
  readonly publicPem: string
  readonly fingerprint: string
}

export interface DevVerifierMaterial {
  readonly publicPem: string
  readonly fingerprint: string
}

export type DevKeyStoreReason =
  | 'invalid_slot'
  | 'relative_store_path'
  | 'unsupported_platform'
  | 'invalid_directory'
  | 'symbolic_link'
  | 'directory_owner_mismatch'
  | 'insecure_directory'
  | 'not_regular_file'
  | 'file_owner_mismatch'
  | 'insecure_file'
  | 'material_too_large'
  | 'missing_material'
  | 'orphan_public'
  | 'public_identity_mismatch'
  | 'temporary_collision'
  | 'incomplete_write'

/** Safe boundary error. Native filesystem failures retain their errno/code. */
export class DevKeyStoreError extends Error {
  readonly code: 'ERR_JWT_DEV_STORE'
  readonly reason: DevKeyStoreReason
  readonly source: string
  constructor(source: string, reason: DevKeyStoreReason)
}

/** Blank overrides select serviceRoot/.dev-keys; nonblank overrides must be absolute. */
export function resolveDevKeyStoreDir(serviceRoot: string, override?: string): string

/**
 * Same-euid cooperating processes and trusted ancestors are required.
 * No final identity is replaced or automatically repaired. Files are read
 * through validated descriptors with a 64 KiB bound. Final-directory symlinks
 * are rejected after lexical normalization; trusted ancestor symlinks remain
 * allowed. Publication is atomic between processes, without an fsync promise.
 */
export function loadOrCreateDevSigningMaterial(
  slot: DevJwtSlot,
  absoluteStore: string
): DevSigningMaterial

/** Reads public material only; never creates a directory, key, or private-file read. */
export function readDevVerifierMaterial(
  slot: DevJwtSlot,
  absoluteStore: string
): DevVerifierMaterial
