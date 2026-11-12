/**
 * Main-side ceiling for an optionally bounded 'gfs:download'. The renderer is
 * untrusted: it may request a per-download bound up to this size (the
 * folder-zip walk derives one from its remaining byte budget), but never a
 * larger one. Requests without a bound keep the save-to-disk path's uncapped
 * semantics.
 */
export const GFS_DOWNLOAD_MAX_BYTES_CEILING = 2 * 1024 * 1024 * 1024
