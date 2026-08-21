'use client'

import { useEffect, useState } from 'react'
import { IconImage } from '@components/Sidebar/icons'
import { GFS_FILE_THUMBNAIL_MAX_BYTES } from '@constants/gfsFileThumbnail'
import { gfsFetchFileBlob } from '@lib/api'
import { gfsImagePreviewMimeType } from '@lib/gfsImagePreview'
import type { GfsFileThumbnailProps } from './types'

/**
 * Tiny row-level thumbnail. Pulls the image blob through the existing
 * GFS proxy path, builds an object URL, and renders it inside the
 * row's existing 1.5rem icon slot. Falls back to the inline image
 * glyph when the row is over-budget or the blob fetch/load fails.
 */
export function GfsFileThumbnail({
  byteLength,
  fileName,
  rid,
}: GfsFileThumbnailProps): React.JSX.Element {
  const shouldSkip = byteLength > GFS_FILE_THUMBNAIL_MAX_BYTES
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(shouldSkip)

  useEffect(() => {
    if (shouldSkip) {
      setFailed(true)
      setSrc(null)
      return
    }
    let cancelled = false
    let objectUrl: string | null = null

    async function load(): Promise<void> {
      try {
        const fetched = await gfsFetchFileBlob(rid)
        if (cancelled) return
        if (fetched.size > GFS_FILE_THUMBNAIL_MAX_BYTES) {
          setFailed(true)
          return
        }
        // SVG (and other image) previews render through <img>, which
        // only paints the data when the object URL's blob carries the
        // right MIME type. The proxy may return application/octet-stream
        // for SVG bodies, so wrap with the type the image preview
        // modal already computes.
        const mimeType = gfsImagePreviewMimeType(fileName) ?? fetched.type
        objectUrl = URL.createObjectURL(
          mimeType && mimeType !== fetched.type ? new Blob([fetched], { type: mimeType }) : fetched
        )
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
      className="cu-gfs-file-thumbnail"
      decoding="async"
      loading="lazy"
      src={src}
    />
  )
}

export type { GfsFileThumbnailProps } from './types'
