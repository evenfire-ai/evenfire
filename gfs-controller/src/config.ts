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
import {
  GFS_UPLOAD_V2_DEFAULT_CONCURRENCY,
  GFS_UPLOAD_V2_FALLBACK_CONCURRENCY,
  GFS_UPLOAD_V2_INSTABILITY_FAILURE_THRESHOLD,
  GFS_UPLOAD_V2_MAX_PART_BYTES,
  GFS_UPLOAD_V2_MIN_PART_BYTES,
  GFS_UPLOAD_V2_PART_TIMEOUT_MS,
  GFS_UPLOAD_V2_FINALIZE_TIMEOUT_MS,
  GFS_UPLOAD_V2_STALE_PART_LEASE_MS,
  GFS_UPLOAD_V2_PREFERRED_PART_BYTES,
  GFS_UPLOAD_V2_PRODUCT_MAX_BYTES,
  GFS_UPLOAD_V2_PROTOCOL_MAX_BYTES,
  GFS_UPLOAD_V2_SESSION_TTL_SECONDS,
} from './upload/protocol'

export interface GfsUploadConfig {
  /** Product policy; never raised by changing the protocol ceiling alone. */
  productMaxFileBytes: number
  /** Arithmetic/test ceiling; not a public capability. */
  protocolMaxFileBytes: number
  preferredPartBytes: number
  maxPartBytes: number
  maxPartCount: number
  maxConcurrentPartsPerSession: number
  maxConcurrentPartStreamsGlobal: number
  maxActivePerSubject: number
  maxActiveGlobal: number
  maxConcurrentFinalizations: number
  minFreeBytes: number
  instabilityFailureThreshold: number
  fallbackConcurrency: number
  sessionTtlSeconds: number
  partTimeoutMs: number
  finalizeTimeoutMs: number
  stalePartLeaseMs: number
  receiptRetentionSeconds: number
  enabled: boolean
}

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
  uploadV2: GfsUploadConfig
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

function strictBoolean(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name]
  if (raw === undefined) return defaultValue
  if (raw === 'true') return true
  if (raw === 'false') return false
  throw new Error(`[gfsc] ${name} must be exactly 'true' or 'false', got: ${JSON.stringify(raw)}`)
}

function uploadInteger(name: string, defaultValue: number, min: number, max: number): number {
  const raw = process.env[name]
  if (raw === undefined) return defaultValue
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(`[gfsc] ${name} must be an integer from ${min} through ${max}, got: ${JSON.stringify(raw)}`)
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`[gfsc] ${name} must be an integer from ${min} through ${max}, got: ${raw}`)
  }
  return value
}

function uploadDurationMs(name: string, defaultValue: number, max: number): number {
  const raw = process.env[name]
  if (raw === undefined) return defaultValue
  if (!/^[0-9]+$/.test(raw)) throw new Error(`[gfsc] ${name} must be a positive integer number of milliseconds`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new Error(`[gfsc] ${name} must be a positive integer number of milliseconds`)
  }
  return value
}

function uploadDurationMsWithAlias(
  canonicalName: string,
  aliasName: string,
  defaultValue: number,
  max: number,
  aliasMultiplier: number,
): number {
  const canonicalRaw = process.env[canonicalName]
  const aliasRaw = process.env[aliasName]
  const canonical = canonicalRaw === undefined
    ? undefined
    : uploadDurationMs(canonicalName, defaultValue, max)
  const alias = aliasRaw === undefined
    ? undefined
    : uploadInteger(aliasName, Math.round(defaultValue / aliasMultiplier), 1, Math.floor(max / aliasMultiplier)) * aliasMultiplier
  if (canonical !== undefined && alias !== undefined && canonical !== alias) {
    throw new Error(`[gfsc] ${canonicalName} and deprecated ${aliasName} must match`)
  }
  return canonical ?? alias ?? defaultValue
}

function uploadIntegerWithAlias(
  canonicalName: string,
  aliasName: string,
  defaultValue: number,
  min: number,
  max: number,
): number {
  const canonicalRaw = process.env[canonicalName]
  const aliasRaw = process.env[aliasName]
  // Report a conflicting pair before validating the individual range. This
  // keeps the deprecated alias contract explicit even when one side is just
  // outside the canonical range (for example, an old 199 MiB value).
  if (canonicalRaw !== undefined && aliasRaw !== undefined) {
    const canonicalNumber = Number(canonicalRaw)
    const aliasNumber = Number(aliasRaw)
    if (Number.isFinite(canonicalNumber) && Number.isFinite(aliasNumber) && canonicalNumber !== aliasNumber) {
      throw new Error(`[gfsc] ${canonicalName} and deprecated ${aliasName} must match`)
    }
  }
  const canonical = process.env[canonicalName] === undefined
    ? undefined
    : uploadInteger(canonicalName, defaultValue, min, max)
  const alias = process.env[aliasName] === undefined
    ? undefined
    : uploadInteger(aliasName, defaultValue, min, max)
  if (canonical !== undefined && alias !== undefined && canonical !== alias) {
    throw new Error(`[gfsc] ${canonicalName} and deprecated ${aliasName} must match`)
  }
  return canonical ?? alias ?? defaultValue
}

function uploadConfig(): GfsUploadConfig {
  const enabled = strictBoolean('GFS_UPLOAD_V2_ENABLED', false)
  const protocolMaxFileBytes = uploadInteger(
    'GFS_UPLOAD_PROTOCOL_MAX_FILE_BYTES',
    GFS_UPLOAD_V2_PROTOCOL_MAX_BYTES,
    GFS_UPLOAD_V2_PRODUCT_MAX_BYTES,
    GFS_UPLOAD_V2_PROTOCOL_MAX_BYTES
  )
  const productMaxFileBytes = uploadIntegerWithAlias(
    'GFS_UPLOAD_PRODUCT_MAX_FILE_BYTES',
    'GFS_UPLOAD_MAX_FILE_BYTES',
    GFS_UPLOAD_V2_PRODUCT_MAX_BYTES,
    GFS_UPLOAD_V2_PRODUCT_MAX_BYTES,
    GFS_UPLOAD_V2_PRODUCT_MAX_BYTES
  )
  const preferredPartBytes = uploadIntegerWithAlias(
    'GFS_UPLOAD_PREFERRED_CHUNK_BYTES',
    'GFS_UPLOAD_PREFERRED_PART_BYTES',
    GFS_UPLOAD_V2_PREFERRED_PART_BYTES,
    GFS_UPLOAD_V2_MIN_PART_BYTES,
    GFS_UPLOAD_V2_MAX_PART_BYTES
  )
  const maxPartBytes = uploadIntegerWithAlias(
    'GFS_UPLOAD_MAX_CHUNK_BYTES',
    'GFS_UPLOAD_MAX_PART_BYTES',
    GFS_UPLOAD_V2_MAX_PART_BYTES,
    GFS_UPLOAD_V2_MIN_PART_BYTES,
    GFS_UPLOAD_V2_MAX_PART_BYTES
  )
  if (preferredPartBytes > maxPartBytes) {
    throw new Error(
      `[gfsc] GFS_UPLOAD_PREFERRED_CHUNK_BYTES cannot exceed GFS_UPLOAD_MAX_CHUNK_BYTES (${preferredPartBytes} > ${maxPartBytes})`
    )
  }
  const minPartBytes = uploadInteger(
    'GFS_UPLOAD_MIN_PART_BYTES',
    GFS_UPLOAD_V2_MIN_PART_BYTES,
    GFS_UPLOAD_V2_MIN_PART_BYTES,
    maxPartBytes,
  )
  if (minPartBytes > maxPartBytes) {
    throw new Error(`[gfsc] GFS_UPLOAD_MIN_PART_BYTES cannot exceed GFS_UPLOAD_MAX_CHUNK_BYTES`)
  }
  if (preferredPartBytes < minPartBytes) {
    throw new Error(`[gfsc] GFS_UPLOAD_PREFERRED_CHUNK_BYTES cannot be below GFS_UPLOAD_MIN_PART_BYTES`)
  }
  const maxPartCount = uploadInteger('GFS_UPLOAD_MAX_PART_COUNT', 1024, 1, 1024)
  const maxConcurrentPartsPerSession = uploadInteger(
    'GFS_UPLOAD_MAX_CONCURRENT_PARTS_PER_SESSION',
    GFS_UPLOAD_V2_DEFAULT_CONCURRENCY,
    1,
    GFS_UPLOAD_V2_DEFAULT_CONCURRENCY
  )
  const fallbackConcurrency = uploadInteger(
    'GFS_UPLOAD_FALLBACK_CONCURRENCY',
    GFS_UPLOAD_V2_FALLBACK_CONCURRENCY,
    1,
    GFS_UPLOAD_V2_DEFAULT_CONCURRENCY
  )
  if (fallbackConcurrency >= maxConcurrentPartsPerSession) {
    throw new Error(
      `[gfsc] GFS_UPLOAD_FALLBACK_CONCURRENCY must be lower than GFS_UPLOAD_MAX_CONCURRENT_PARTS_PER_SESSION`
    )
  }
  const maxConcurrentPartStreamsGlobal = uploadInteger(
    'GFS_UPLOAD_MAX_CONCURRENT_PART_STREAMS_GLOBAL',
    16,
    1,
    1024
  )
  const maxActivePerSubject = uploadInteger('GFS_UPLOAD_MAX_ACTIVE_PER_SUBJECT', 2, 1, 100)
  const maxActiveGlobal = uploadInteger('GFS_UPLOAD_MAX_ACTIVE_GLOBAL', 8, 1, 1000)
  const maxConcurrentFinalizations = uploadInteger('GFS_UPLOAD_MAX_CONCURRENT_FINALIZATIONS', 1, 1, 100)
  const minFreeBytes = uploadInteger('GFS_UPLOAD_MIN_FREE_BYTES', 10 * 1024 * 1024 * 1024, 0, Number.MAX_SAFE_INTEGER)
  const instabilityFailureThreshold = uploadInteger(
    'GFS_UPLOAD_INSTABILITY_FAILURE_THRESHOLD',
    GFS_UPLOAD_V2_INSTABILITY_FAILURE_THRESHOLD,
    1,
    100
  )
  const sessionTtlMs = uploadDurationMsWithAlias(
    'GFS_UPLOAD_SESSION_TTL_MS',
    'GFS_UPLOAD_SESSION_TTL_SECONDS',
    GFS_UPLOAD_V2_SESSION_TTL_SECONDS * 1000,
    7 * 24 * 60 * 60 * 1000,
    1000,
  )
  const partTimeoutMs = uploadDurationMs('GFS_UPLOAD_PART_TIMEOUT_MS', GFS_UPLOAD_V2_PART_TIMEOUT_MS, 24 * 60 * 60 * 1000)
  const finalizeTimeoutMs = uploadDurationMs('GFS_UPLOAD_FINALIZE_TIMEOUT_MS', GFS_UPLOAD_V2_FINALIZE_TIMEOUT_MS, 24 * 60 * 60 * 1000)
  const stalePartLeaseMs = uploadDurationMs('GFS_UPLOAD_STALE_PART_LEASE_MS', GFS_UPLOAD_V2_STALE_PART_LEASE_MS, 24 * 60 * 60 * 1000)
  if (stalePartLeaseMs <= partTimeoutMs) {
    throw new Error(
      '[gfsc] GFS_UPLOAD_STALE_PART_LEASE_MS must be greater than GFS_UPLOAD_PART_TIMEOUT_MS'
    )
  }
  const receiptRetentionMs = uploadDurationMsWithAlias(
    'GFS_UPLOAD_COMPLETED_RECEIPT_TTL_MS',
    'GFS_UPLOAD_RECEIPT_RETENTION_SECONDS',
    24 * 60 * 60 * 1000,
    7 * 24 * 60 * 60 * 1000,
    1000,
  )
  return {
    productMaxFileBytes,
    protocolMaxFileBytes,
    preferredPartBytes,
    maxPartBytes,
    maxPartCount,
    maxConcurrentPartsPerSession,
    maxConcurrentPartStreamsGlobal,
    maxActivePerSubject,
    maxActiveGlobal,
    maxConcurrentFinalizations,
    minFreeBytes,
    instabilityFailureThreshold,
    fallbackConcurrency,
    sessionTtlSeconds: Math.floor(sessionTtlMs / 1000),
    partTimeoutMs,
    finalizeTimeoutMs,
    stalePartLeaseMs,
    receiptRetentionSeconds: Math.floor(receiptRetentionMs / 1000),
    enabled,
  }
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
    uploadV2: uploadConfig(),
    devMode,
  }
}
