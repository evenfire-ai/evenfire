import { useEffect, useId, useRef, useState } from 'react'
import { StatusBanner } from '@components/Common'
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
        assertGfsVideoPreviewSize(byteLength)
        const { bytes } = await window.clerum.gfs.download(gfsUri)
        assertGfsVideoPreviewSize(bytes.byteLength)
        if (!active) return
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: mimeType }))
        setPreviewUrl(objectUrl)
      } catch (error) {
        if (!active) return
        onDownloadErrorRef.current?.(error)
        setPreviewError(error instanceof Error ? error.message : 'Could not load the video preview')
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
