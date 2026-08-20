'use client'

import { useEffect, useState } from 'react'
import { IconImage } from '@components/Sidebar/icons'
import { GFS_FILE_THUMBNAIL_MAX_BYTES } from '@constants/gfsFileThumbnail'
import { gfsFetchFileBlob } from '@lib/api'
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
        const blob = await gfsFetchFileBlob(rid)
        if (cancelled) return
        if (blob.size > GFS_FILE_THUMBNAIL_MAX_BYTES) {
          setFailed(true)
          return
        }
        objectUrl = URL.createObjectURL(blob)
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
  }, [rid, shouldSkip])

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
