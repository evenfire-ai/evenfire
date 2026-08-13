// Kept in parity with the web control-ui cap (control-ui/app/constants/gfsFileUpload.ts).
// base64 inflates ×1.34 → 16MiB raw ≈ 22.4MB body, under gfsc's 24MiB write cap.
export const GFS_FILE_UPLOAD_MAX_BYTES = 16 * 1024 * 1024
export const GFS_FILE_UPLOAD_MAX_MEGABYTES = 16
