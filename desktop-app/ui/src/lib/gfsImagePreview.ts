import {
  GFS_IMAGE_PREVIEW_MAX_BYTES,
  GFS_IMAGE_PREVIEW_MIME_TYPES,
} from '@constants/gfsImagePreview'

export function gfsImagePreviewMimeType(fileName: string): string | null {
  const extension = fileName.split('.').pop()?.toLowerCase()
  if (!extension || extension === fileName.toLowerCase()) return null
  return GFS_IMAGE_PREVIEW_MIME_TYPES[extension] ?? null
}

export function assertGfsImagePreviewSize(byteLength: number): void {
  if (byteLength > GFS_IMAGE_PREVIEW_MAX_BYTES) {
    throw new Error('Image previews are limited to 10 MB. Download the file to view it.')
  }
}
