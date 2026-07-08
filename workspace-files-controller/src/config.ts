/**
 * Runtime configuration for workspace-files-controller, sourced entirely from
 * env. The HCC sharedFileSystemReconciler injects every variable below into
 * the per-SFS Deployment.
 */

function getEnv(key: string, fallback?: string): string {
  const v = process.env[key]
  if (v === undefined || v === '') {
    if (fallback === undefined) throw new Error(`Required env var ${key} is missing`)
    return fallback
  }
  return v
}

function getEnvInt(key: string, fallback: number): number {
  const v = process.env[key]
  if (!v) return fallback
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? n : fallback
}

export interface Config {
  port: number
  /** Absolute on-disk path of the mounted SharedFileSystem PVC. */
  mountPath: string
  /** SharedFileSystem identity — the JWT's `sharedFileSystem` claim must match. */
  sharedFileSystemName: string
  sharedFileSystemNamespace: string
  /** PEM-encoded RSA public key used to verify browsing JWTs. */
  jwtPublicKey: string
  /** Required JWT issuer claim. */
  jwtIssuer: string
  /** Required JWT audience claim. */
  jwtAudience: string
  /** Per-file upload cap (bytes). */
  maxUploadBytes: number
  /** Max entries returned by a single directory listing. */
  maxListEntries: number
  /** Max path depth (segments) accepted from clients. */
  maxPathDepth: number
}

export function loadConfig(): Config {
  return {
    port: getEnvInt('WSF_PORT', 8086),
    mountPath: getEnv('WSF_MOUNT_PATH', '/workspace'),
    sharedFileSystemName: getEnv('WSF_SHARED_FILESYSTEM_NAME'),
    sharedFileSystemNamespace: getEnv('WSF_SHARED_FILESYSTEM_NAMESPACE'),
    jwtPublicKey: getEnv('WSF_JWT_PUBLIC_KEY'),
    jwtIssuer: getEnv('WSF_JWT_ISSUER', 'control-api'),
    jwtAudience: getEnv('WSF_JWT_AUDIENCE', 'workspace-files-controller'),
    maxUploadBytes: getEnvInt('WSF_MAX_UPLOAD_BYTES', 100 * 1024 * 1024),
    maxListEntries: getEnvInt('WSF_MAX_LIST_ENTRIES', 5000),
    maxPathDepth: getEnvInt('WSF_MAX_PATH_DEPTH', 32),
  }
}
