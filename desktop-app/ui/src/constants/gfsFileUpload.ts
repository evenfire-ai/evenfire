// Product hard ceiling. Upload v2 sends indexed binary parts, so the 200 MiB
// file limit is independent of the 8 MiB preferred / 16 MiB hard part limit.
export const GFS_FILE_UPLOAD_MAX_BYTES = 200 * 1024 * 1024
export const GFS_FILE_UPLOAD_MAX_MEGABYTES = 200
export const GFS_FILE_UPLOAD_PREFERRED_PART_BYTES = 8 * 1024 * 1024
export const GFS_FILE_UPLOAD_MAX_PART_BYTES = 16 * 1024 * 1024
export const GFS_FILE_UPLOAD_DEFAULT_CONCURRENCY = 4
export const GFS_FILE_UPLOAD_FALLBACK_CONCURRENCY = 2
