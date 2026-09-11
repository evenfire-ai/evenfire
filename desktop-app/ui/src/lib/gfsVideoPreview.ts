import {
  GFS_VIDEO_PREVIEW_MAX_BYTES,
  GFS_VIDEO_PREVIEW_MIME_TYPES,
} from '@constants/gfsVideoPreview'

export function gfsVideoPreviewMimeType(fileName: string): string | null {
  const extension = fileName.split('.').pop()?.toLowerCase()
  if (!extension || extension === fileName.toLowerCase()) return null
  return GFS_VIDEO_PREVIEW_MIME_TYPES[extension] ?? null
}

export function assertGfsVideoPreviewSize(byteLength: number): void {
  if (byteLength > GFS_VIDEO_PREVIEW_MAX_BYTES) {
    throw new Error(
      'Video previews are limited to 100 MB. Download the file to watch the full video.'
    )
  }
}
