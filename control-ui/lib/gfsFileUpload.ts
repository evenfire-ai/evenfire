import { GFS_FILE_UPLOAD_MAX_BYTES, GFS_FILE_UPLOAD_MAX_MEGABYTES } from '@constants/gfsFileUpload'

export function assertGfsFileUploadSize(byteLength: number): void {
  if (byteLength > GFS_FILE_UPLOAD_MAX_BYTES) {
    throw new Error(`GFS uploads are limited to ${GFS_FILE_UPLOAD_MAX_MEGABYTES} MB per file.`)
  }
}
