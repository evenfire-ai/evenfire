// Raw-file upload cap. base64 inflates this ×1.34 on the wire, so 16MiB → ~22.4MB
// body, which must stay under gfsc's GFS_MAX_WRITE_BODY_BYTES (24MiB, set via the
// host-context-controller gfsc template). Raise all three in step.
export const GFS_FILE_UPLOAD_MAX_BYTES = 16 * 1024 * 1024
export const GFS_FILE_UPLOAD_MAX_MEGABYTES = 16
