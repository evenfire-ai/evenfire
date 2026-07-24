/**
 * gfs-controller (gfsc) configuration.
 *
 * Required values FAIL LOUD in production — there is no silent default that
 * would let gfsc start against a misconfigured deployment. Dev mode relaxes the
 * requirements for local runs and unit tests only.
 *
 * gfsc mounts the drive PVC (writer RW, readers RO) and serves a brokered HTTP
 * file API; every other actor reaches the drive over this API, never by
 * mounting the volume. The Postgres connection points at the permission store,
 * which is the source of truth for authorization (re-checked on every op).
 */
export interface GfsConfig {
  port: number
  /** Path where the drive PVC is mounted (writer RW, readers RO). */
  storageMountPath: string
  /** 'writer' mounts the volume RW (single replica); 'reader' mounts it RO. */
  storageRole: 'writer' | 'reader'
  /** Postgres connection string for the permission store (source of truth). */
  pgConnectionString: string
  /** Expected `aud` on inbound gfs access tokens. */
  tokenAudience: string
  /** RS256 public key (PEM) used to verify gfs access tokens (wired in P1-S06). */
  publicKey: string
  /** Drive this gfsc serves — a cluster singleton named 'main' in the open core. */
  driveName: string
  /**
   * TTL (ms) for the short-lived authorization decision cache. Bounded so that
   * even with NO invalidation signal a revocation takes effect within this
   * window; the LISTEN/NOTIFY fan-out makes revocation immediate in the healthy
   * path. A tuning knob, not a fail-loud requirement (has a safe default).
   */
  decisionCacheTtlMs: number
  /**
   * Cadence (ms) of the fresh-connection credential probe inside readiness
   * (issue #775): at most one NEW database connection per interval verifies
   * that the DSN still authenticates and the role keeps its grants — the pool
   * alone cannot see a rotated password. Tuning knob with a safe default;
   * garbage values fail loud.
   */
  credentialProbeIntervalMs: number
  blobCleanupSafetyWindowMs: number
  blobCleanupIntervalMs: number
  blobCleanupBatchSize: number
  /** Maximum source objects admitted by one synchronous Copy request. */
  syncCopyMaxObjects: number
  /** Maximum observed source bytes admitted by one synchronous Copy request. */
  syncCopyMaxBytes: number
  /** End-to-end deadline for one synchronous Copy request. */
  syncCopyTimeoutMs: number
  /** Maximum live subtree objects admitted by one synchronous rename request. */
  syncRenameMaxObjects: number
  /** End-to-end deadline for one synchronous rename request. */
  syncRenameTimeoutMs: number
  devMode: boolean
}

function required(name: string, devMode: boolean, devDefault?: string): string {
  const value = process.env[name]
  if (value !== undefined && value !== '') return value
  if (devMode && devDefault !== undefined) return devDefault
  throw new Error(`[gfsc] required environment variable ${name} is not set`)
}

function tuningMs(name: string, defaultMs: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return defaultMs
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`[gfsc] ${name} must be a positive number of milliseconds, got: ${raw}`)
  }
  return value
}

function positiveInteger(name: string, defaultValue: number, maximum: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return defaultValue
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`[gfsc] ${name} must be an integer between 1 and ${maximum}, got: ${raw}`)
  }
  return value
}

/**
 * Copy admission limits intentionally have no compiled product ceiling. Only
 * an absent variable selects the documented default; an explicitly empty or
 * non-canonical positive decimal fails startup instead of falling back.
 */
function syncCopyPositiveInteger(name: string, defaultValue: number): number {
  const raw = process.env[name]
  if (raw === undefined) return defaultValue
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`[gfsc] ${name} must be a positive safe integer, got: ${JSON.stringify(raw)}`)
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) {
    throw new Error(`[gfsc] ${name} must be a positive safe integer, got: ${JSON.stringify(raw)}`)
  }
  return value
}

function storageRole(): GfsConfig['storageRole'] {
  const value = process.env.GFS_STORAGE_ROLE
  if (value === 'reader' || value === 'writer') return value
  throw new Error(`[gfsc] GFS_STORAGE_ROLE must be explicitly set to 'reader' or 'writer', got: ${JSON.stringify(value)}`)
}

export function loadConfig(): GfsConfig {
  const devMode = process.env.GFS_DEV_MODE === 'true'
  return {
    port: Number(process.env.GFS_PORT || 8087),
    storageMountPath: required('GFS_STORAGE_PATH', devMode, '/tmp/gfs-data'),
    storageRole: storageRole(),
    pgConnectionString: required('GFS_PG_CONNECTION_STRING', devMode, ''),
    tokenAudience: process.env.GFS_TOKEN_AUDIENCE || 'gfs-controller',
    publicKey: process.env.GFS_JWT_PUBLIC_KEY || '',
    driveName: process.env.GFS_DRIVE_NAME || 'main',
    decisionCacheTtlMs: Number(process.env.GFS_DECISION_CACHE_TTL_MS || 5000),
    credentialProbeIntervalMs: tuningMs('GFS_CREDENTIAL_PROBE_INTERVAL_MS', 60000),
    blobCleanupSafetyWindowMs: positiveInteger(
      'GFS_BLOB_CLEANUP_SAFETY_WINDOW_MS',
      3600000,
      31536000000
    ),
    blobCleanupIntervalMs: positiveInteger(
      'GFS_BLOB_CLEANUP_INTERVAL_MS',
      60000,
      2147483647
    ),
    blobCleanupBatchSize: positiveInteger('GFS_BLOB_CLEANUP_BATCH_SIZE', 100, 10000),
    syncCopyMaxObjects: syncCopyPositiveInteger('GFS_SYNC_COPY_MAX_OBJECTS', 1000),
    syncCopyMaxBytes: syncCopyPositiveInteger('GFS_SYNC_COPY_MAX_BYTES', 1073741824),
    syncCopyTimeoutMs: syncCopyPositiveInteger('GFS_SYNC_COPY_TIMEOUT_MS', 30000),
    syncRenameMaxObjects: syncCopyPositiveInteger('GFS_SYNC_RENAME_MAX_OBJECTS', 1000),
    syncRenameTimeoutMs: syncCopyPositiveInteger('GFS_SYNC_RENAME_TIMEOUT_MS', 30000),
    devMode,
  }
}
