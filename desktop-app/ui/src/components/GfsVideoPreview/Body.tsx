import { useEffect, useId, useRef, useState } from 'react'
import { StatusBanner } from '@components/Common'
import { GFS_PREVIEW_UPDATE_FAILED_MESSAGE } from '@constants/gfsPreview'
import { GFS_VIDEO_PREVIEW_MAX_BYTES } from '@constants/gfsVideoPreview'
import { useInPlaceObjectUrl } from '@hooks/useInPlaceObjectUrl'
import { describeGfsReadError, isGfsSessionAuthorityFailure } from '@lib/gfsGrantErrors'
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
  contentVersion,
  fileName,
  gfsUri,
  mimeType,
  onDownloadError,
  titleId,
  titleActions,
  permissionProgress,
  headerActions,
  headingLevel = 3,
}: GfsVideoPreviewBodyProps) {
  const generatedTitleId = useId()
  const headingId = titleId ?? generatedTitleId
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [updateError, setUpdateError] = useState<string | null>(null)
  const { url: previewUrl, publish, discard, hasContentFor } = useInPlaceObjectUrl(gfsUri)
  const onDownloadErrorRef = useRef(onDownloadError)
  const HeadingTag = `h${headingLevel}` as const

  useEffect(() => {
    onDownloadErrorRef.current = onDownloadError
  }, [onDownloadError])

  useEffect(() => {
    let active = true

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
        publish(gfsUri, new Blob([bytes], { type: mimeType }))
        setPreviewError(null)
        setUpdateError(null)
      } catch (error) {
        if (!active) return
        onDownloadErrorRef.current?.(error)
        // Through the shared read-plane presenter, not raw — see the note in
        // `GfsImagePreview/Body.tsx`. A 429 crossing Electron IPC otherwise
        // reaches the banner as "Error invoking remote method
        // 'gfs:downloadPreview': Error: 429 …"; every other verdict, including
        // the size guard and the download ceiling, passes through untouched.
        const message =
          error instanceof Error
            ? describeGfsReadError(error).message
            : 'Could not load the video preview'
        const rawMessage = error instanceof Error ? error.message : String(error)
        // A rejected session fails closed even mid-reload: bytes fetched under it
        // must not stay on screen. A per-resource 403/404 instead keeps the
        // version already shown — losing access to this one file is decided by
        // the authoritative resolve, which remounts this body.
        if (isGfsSessionAuthorityFailure(rawMessage, 'operation')) {
          discard()
          setUpdateError(null)
          setPreviewError(message)
        } else if (hasContentFor(gfsUri)) setUpdateError(message)
        else setPreviewError(message)
      }
    }

    void loadPreview()
    return () => {
      active = false
    }
  }, [byteLength, contentVersion, gfsUri, mimeType, discard, hasContentFor, publish])

  return (
    <>
      <header className="da-gfs-video-preview-dialog__header">
        <div className="da-gfs-preview-title-row">
          <HeadingTag className="da-gfs-preview-title" id={headingId}>
            {fileName}
          </HeadingTag>
          {titleActions}
          {permissionProgress}
        </div>
        {headerActions}
      </header>
      <div className="da-gfs-video-preview-dialog__body">
        {previewError ? <StatusBanner tone="error" text={previewError} /> : null}
        {updateError && previewUrl && !previewError ? (
          <div role="status">
            <StatusBanner
              tone="warn"
              text={`${GFS_PREVIEW_UPDATE_FAILED_MESSAGE} ${updateError}`}
            />
          </div>
        ) : null}
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
