const MIB = 1024 * 1024

export const GFS_HOST_RETAINED_FILES = 64
export const GFS_HOST_ACTIVE_DOWNLOADS = 2

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

function requiredGfsInteger(name: string, raw: string | undefined, fallback: number): number {
  return configuredGfsInteger(name, raw, fallback, Number.MAX_SAFE_INTEGER)
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
  storageBytes: requiredGfsInteger(
    'MCP_HOST_GFS_DOWNLOAD_STORAGE_BYTES',
    process.env.MCP_HOST_GFS_DOWNLOAD_STORAGE_BYTES,
    1024 * MIB
  ),
  callerStorageBytes: requiredGfsInteger(
    'MCP_HOST_GFS_CALLER_DOWNLOAD_STORAGE_BYTES',
    process.env.MCP_HOST_GFS_CALLER_DOWNLOAD_STORAGE_BYTES,
    256 * MIB
  ),
  callerRetainedFiles: configuredGfsInteger(
    'MCP_HOST_GFS_CALLER_DOWNLOAD_MAX_FILES',
    process.env.MCP_HOST_GFS_CALLER_DOWNLOAD_MAX_FILES,
    8,
    GFS_HOST_RETAINED_FILES
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

if (GFS_FILE_LIMITS.maxFileBytes > GFS_FILE_LIMITS.callerStorageBytes)
  throw new Error('MCP_HOST_GFS_MAX_FILE_BYTES must fit within the caller retained-storage budget')

if (GFS_FILE_LIMITS.callerStorageBytes > GFS_FILE_LIMITS.storageBytes)
  throw new Error(
    'MCP_HOST_GFS_CALLER_DOWNLOAD_STORAGE_BYTES must not exceed the Host aggregate retained-storage budget'
  )

if (GFS_FILE_LIMITS.callerStorageBytes * 2 > GFS_FILE_LIMITS.storageBytes)
  throw new Error(
    'MCP_HOST_GFS_CALLER_DOWNLOAD_STORAGE_BYTES must leave aggregate storage for another caller'
  )
