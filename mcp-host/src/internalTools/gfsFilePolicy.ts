const MIB = 1024 * 1024

export const GFS_HOST_ACTIVE_DOWNLOADS = 2

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
   * statfs at every admission.
   */
  storagePercent: configuredGfsInteger(
    'MCP_HOST_GFS_DOWNLOAD_STORAGE_PERCENT',
    process.env.MCP_HOST_GFS_DOWNLOAD_STORAGE_PERCENT,
    85,
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
