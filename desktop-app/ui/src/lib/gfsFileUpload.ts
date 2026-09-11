import { GFS_FILE_UPLOAD_PROTOCOL_MAX_BYTES } from '@constants/gfsFileUpload'

export function assertGfsFileUploadSize(byteLength: number): void {
  if (
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0 ||
    byteLength > GFS_FILE_UPLOAD_PROTOCOL_MAX_BYTES
  ) {
    throw new Error('GFS uploads cannot exceed the 1 GiB Upload v2 protocol maximum.')
  }
}
