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
  devMode: boolean
}

function required(name: string, devMode: boolean, devDefault?: string): string {
  const value = process.env[name]
  if (value !== undefined && value !== '') return value
  if (devMode && devDefault !== undefined) return devDefault
  throw new Error(`[gfsc] required environment variable ${name} is not set`)
}

export function loadConfig(): GfsConfig {
  const devMode = process.env.GFS_DEV_MODE === 'true'
  const storageRole = process.env.GFS_STORAGE_ROLE === 'reader' ? 'reader' : 'writer'
  return {
    port: Number(process.env.GFS_PORT || 8087),
    storageMountPath: required('GFS_STORAGE_PATH', devMode, '/tmp/gfs-data'),
    storageRole,
    pgConnectionString: required('GFS_PG_CONNECTION_STRING', devMode, ''),
    tokenAudience: process.env.GFS_TOKEN_AUDIENCE || 'gfs-controller',
    publicKey: process.env.GFS_JWT_PUBLIC_KEY || '',
    driveName: process.env.GFS_DRIVE_NAME || 'main',
    decisionCacheTtlMs: Number(process.env.GFS_DECISION_CACHE_TTL_MS || 5000),
    devMode,
  }
}
