/**
 * Authoritative, main-process ceiling for any GFS preview download (100 MiB).
 *
 * The renderer is the untrusted side: it may ask for a finer per-type limit
 * (e.g. 10 MiB for an image, 2 MiB for markdown), but it can never raise the
 * cap above this value. 100 MiB is the largest of the per-type preview limits
 * (video — GFS_VIDEO_PREVIEW_MAX_BYTES in the renderer constants); no legitimate
 * preview needs more, so a request exceeding it is a renderer bug or a tampered
 * payload and is rejected at the IPC boundary. If a per-type limit is ever
 * raised past this, raise this ceiling too or main will reject that preview.
 *
 * Kept in this dependency-free leaf module (not in boundedDownload.ts, which
 * pulls in the HTTP client graph) so the IPC layer can import the ceiling
 * without dragging that graph into its module evaluation.
 */
export const GFS_PREVIEW_MAX_BYTES = 100 * 1024 * 1024
