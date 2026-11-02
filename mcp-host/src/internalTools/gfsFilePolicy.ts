const MIB = 1024 * 1024

export const GFS_HOST_ACTIVE_DOWNLOADS = 2

/**
 * gfsc's default bound on a JSON write request body (`DEFAULT_MAX_WRITE_BODY_BYTES`,
 * gfs-controller/src/api/serve.ts). It bounds the whole body, so base64 content
 * leaves about three quarters of it for the file. A deployment may raise it
 * with `GFS_MAX_WRITE_BODY_BYTES`, which the Host cannot see, so the Host
 * checks against this floor; gfsc remains the authority and answers 413.
 */
export const GFS_JSON_WRITE_MAX_BODY_BYTES = 16 * MIB

/**
 * Retained-storage variables of the fixed quota model, removed in #1028 when
 * the budget became a share of the workspace volume. A deployment that still
 * sets one is warned about at store startup, never failed.
 */
export const REMOVED_GFS_STORAGE_VARIABLES = Object.freeze([
  'MCP_HOST_GFS_DOWNLOAD_STORAGE_BYTES',
  'MCP_HOST_GFS_CALLER_DOWNLOAD_STORAGE_BYTES',
  'MCP_HOST_GFS_CALLER_DOWNLOAD_MAX_FILES',
] as const)

export function configuredGfsInteger(
  name: string,
  raw: string | undefined,
  fallback: number,
  maximum: number
): number {
  if (raw === undefined) return fallback
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`${name} must be a positive decimal integer`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value > maximum)
    throw new Error(`${name} must be no greater than ${maximum}`)
  return value
}

/** Generic GFS transfer policy, independent of visual model delivery. */
export const GFS_FILE_LIMITS = Object.freeze({
  maxFileBytes: configuredGfsInteger(
    'MCP_HOST_GFS_MAX_FILE_BYTES',
    process.env.MCP_HOST_GFS_MAX_FILE_BYTES,
    16 * MIB,
    200 * MIB
  ),
  inlineTextBytes: 8 * 1024,
  metadataBytes: 64 * 1024,
  errorBytes: 8 * 1024,
  /**
   * Share of the volume holding the Host root that retained downloads may
   * occupy: `floor(volumeTotalBytes * storagePercent / 100)`, measured with
   * statfs at every admission. The default 70 plus the store's 15% free-space
   * floor leaves 15% of the volume that the cache never fills, so on a volume
   * with a 5% root reservation the budget, not the floor, is the cache's limit.
   */
  storagePercent: configuredGfsInteger(
    'MCP_HOST_GFS_DOWNLOAD_STORAGE_PERCENT',
    process.env.MCP_HOST_GFS_DOWNLOAD_STORAGE_PERCENT,
    70,
    100
  ),
  callerActiveDownloads: configuredGfsInteger(
    'MCP_HOST_GFS_CALLER_DOWNLOAD_CONCURRENCY',
    process.env.MCP_HOST_GFS_CALLER_DOWNLOAD_CONCURRENCY,
    1,
    GFS_HOST_ACTIVE_DOWNLOADS
  ),
  retentionMs:
    configuredGfsInteger(
      'MCP_HOST_GFS_DOWNLOAD_TTL_HOURS',
      process.env.MCP_HOST_GFS_DOWNLOAD_TTL_HOURS,
      168,
      8760
    ) *
    60 *
    60 *
    1000,
})
