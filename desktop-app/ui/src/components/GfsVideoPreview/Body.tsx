import { useEffect, useId, useRef, useState } from 'react'
import { StatusBanner } from '@components/Common'
import { GFS_VIDEO_PREVIEW_MAX_BYTES } from '@constants/gfsVideoPreview'
import { describeGfsReadError } from '@lib/gfsGrantErrors'
import { assertGfsVideoPreviewSize } from '@lib/gfsVideoPreview'
import type { GfsVideoPreviewBodyProps } from './types'

/**
 * De-modalized video preview body (spec 18 §3.B.2). Owns the byte fetch (by
 * `gfsUri`), the size-guard, and the rendered `<video>` + loading/error states.
 * Renders no modal chrome. Fails closed: a download error both shows the reason
 * and is routed to `onDownloadError`.
 */
export function GfsVideoPreviewBody({
  byteLength,
  fileName,
  gfsUri,
  mimeType,
  onDownloadError,
  titleId,
  headerActions,
  headingLevel = 3,
}: GfsVideoPreviewBodyProps) {
  const generatedTitleId = useId()
  const headingId = titleId ?? generatedTitleId
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const onDownloadErrorRef = useRef(onDownloadError)
  const HeadingTag = `h${headingLevel}` as const

  useEffect(() => {
    onDownloadErrorRef.current = onDownloadError
  }, [onDownloadError])

  useEffect(() => {
    let active = true
    let objectUrl: string | null = null

    const loadPreview = async () => {
      try {
        // The listed size is a skip HINT (fail fast without a round-trip); the
        // download itself is independently bounded so a wrong listed size cannot
        // materialize an oversized payload.
        assertGfsVideoPreviewSize(byteLength)
        const { bytes } = await window.clerum.gfs.downloadPreview(
          gfsUri,
          GFS_VIDEO_PREVIEW_MAX_BYTES
        )
        assertGfsVideoPreviewSize(bytes.byteLength)
        if (!active) return
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: mimeType }))
        setPreviewUrl(objectUrl)
      } catch (error) {
        if (!active) return
        onDownloadErrorRef.current?.(error)
        // Through the shared read-plane presenter, not raw — see the note in
        // `GfsImagePreview/Body.tsx`. A 429 crossing Electron IPC otherwise
        // reaches the banner as "Error invoking remote method
        // 'gfs:downloadPreview': Error: 429 …"; every other verdict, including
        // the size guard and the download ceiling, passes through untouched.
        setPreviewError(
          error instanceof Error
            ? describeGfsReadError(error).message
            : 'Could not load the video preview'
        )
      }
    }

    void loadPreview()
    return () => {
      active = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [byteLength, gfsUri, mimeType])

  return (
    <>
      <header className="da-gfs-video-preview-dialog__header">
        <HeadingTag className="da-gfs-preview-title" id={headingId}>
          {fileName}
        </HeadingTag>
        {headerActions}
      </header>
      <div className="da-gfs-video-preview-dialog__body">
        {previewError ? <StatusBanner tone="error" text={previewError} /> : null}
        {!previewError && !previewUrl ? (
          <div className="da-gfs-video-preview-dialog__loading" role="status">
            Loading video preview…
          </div>
        ) : null}
        {previewUrl && !previewError ? (
          <video
            aria-label={`Video preview of ${fileName}`}
            className="da-gfs-video-preview-dialog__video"
            controls
            onError={() => setPreviewError('This video could not be played by your browser')}
            preload="metadata"
            src={previewUrl}
          />
        ) : null}
      </div>
    </>
  )
}
