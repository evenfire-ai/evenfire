import { useEffect, useState } from 'react'
import { IconImage } from '@components/SidebarNav/icons'
import { GFS_FILE_THUMBNAIL_MAX_BYTES } from '@constants/gfsFileThumbnail'
import { getCachedGfsBlob, setCachedGfsBlob } from '@lib/gfsBlobCache'
import { gfsImagePreviewMimeType } from '@lib/gfsImagePreview'
import type { GfsFileThumbnailProps } from './types'

/**
 * Tiny row-level thumbnail. Pulls the image blob through the existing
 * GFS download path, builds an object URL, and renders it inside the
 * row's existing icon slot. Falls back to the inline image glyph when
 * the row is over-budget or the blob fetch/load fails.
 *
 * The blob URL is published to the shared GfsBlobCache so the image
 * preview modal can open instantly if the user clicks the row.
 */
export function GfsFileThumbnail({ byteLength, fileName, rid }: GfsFileThumbnailProps) {
  const shouldSkip = byteLength > GFS_FILE_THUMBNAIL_MAX_BYTES
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(shouldSkip)

  useEffect(() => {
    if (shouldSkip) {
      setFailed(true)
      setSrc(null)
      return
    }
    const cached = getCachedGfsBlob(rid)
    if (cached) {
      setSrc(cached.blobUrl)
      return
    }
    let cancelled = false
    let objectUrl: string | null = null

    const load = async () => {
      try {
        const { bytes } = await window.clerum.gfs.download(rid)
        if (cancelled) return
        if (bytes.byteLength > GFS_FILE_THUMBNAIL_MAX_BYTES) {
          setFailed(true)
          return
        }
        // SVG thumbnails need image/svg+xml on the object URL, but the
        // download IPC can hand us application/octet-stream. Wrap the
        // bytes with the type the preview modal already computes so the
        // <img> can actually paint the SVG.
        const mimeType = gfsImagePreviewMimeType(fileName)
        const blob = mimeType !== null ? new Blob([bytes], { type: mimeType }) : new Blob([bytes])
        objectUrl = URL.createObjectURL(blob)
        setCachedGfsBlob(rid, { blobUrl: objectUrl, mimeType: blob.type })
        setSrc(objectUrl)
      } catch {
        if (!cancelled) setFailed(true)
      }
    }

    void load()
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [fileName, rid, shouldSkip])

  if (failed || !src) {
    return <IconImage />
  }

  return (
    <img
      alt={`Thumbnail of ${fileName}`}
      className="da-gfs-file-thumbnail"
      decoding="async"
      loading="lazy"
      src={src}
    />
  )
}

export type { GfsFileThumbnailProps } from './types'
