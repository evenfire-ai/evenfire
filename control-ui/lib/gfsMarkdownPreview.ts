import {
  GFS_MARKDOWN_PREVIEW_EXTENSIONS,
  GFS_MARKDOWN_PREVIEW_MAX_BYTES,
} from '@constants/gfsMarkdownPreview'

export function isGfsMarkdownPreviewFile(fileName: string): boolean {
  const extension = fileName.split('.').pop()?.toLowerCase()
  return Boolean(
    extension &&
    extension !== fileName.toLowerCase() &&
    GFS_MARKDOWN_PREVIEW_EXTENSIONS.has(extension)
  )
}

export function assertGfsMarkdownPreviewSize(byteLength: number): void {
  if (byteLength > GFS_MARKDOWN_PREVIEW_MAX_BYTES) {
    throw new Error('Markdown previews are limited to 2 MB. Download the file to view it.')
  }
}
