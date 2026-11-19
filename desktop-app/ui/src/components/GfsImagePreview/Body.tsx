import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { StatusBanner } from '@components/Common'
import { GFS_IMAGE_PREVIEW_MAX_BYTES } from '@constants/gfsImagePreview'
import { GFS_PREVIEW_UPDATE_FAILED_MESSAGE } from '@constants/gfsPreview'
import { useInPlaceObjectUrl } from '@hooks/useInPlaceObjectUrl'
import { estimateBase64DecodedLength } from '@lib/base64Size'
import { describeGfsReadError, isGfsSessionAuthorityFailure } from '@lib/gfsGrantErrors'
import { assertGfsImagePreviewSize } from '@lib/gfsImagePreview'
import { copyImageBlobToClipboard } from '@lib/imageClipboard'
import type { GfsImagePreviewBodyProps } from './types'

/**
 * De-modalized image preview body (spec 18 §3.B.2). Owns the byte fetch (by
 * `gfsUri`), the size-guard, the copy-to-clipboard, and the rendered `<img>` +
 * loading/error states. It renders NO portal, backdrop, `aria-modal`, or Escape
 * handling — that chrome belongs to the caller. Fails closed: any download error
 * both surfaces the reason in the body and is routed to `onDownloadError`.
 */
export function GfsImagePreviewBody({
  byteLength,
  contentVersion,
  fileName,
  gfsUri,
  dataBase64,
  mimeType,
  onDownloadError,
  onCopyContentReady,
  titleId,
  titleActions,
  permissionProgress,
  headerActions,
  headingLevel = 3,
}: GfsImagePreviewBodyProps) {
  const generatedTitleId = useId()
  const headingId = titleId ?? generatedTitleId
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [updateError, setUpdateError] = useState<string | null>(null)
  const mountedRef = useRef(true)
  const source = gfsUri ?? dataBase64 ?? null
  const {
    url: previewUrl,
    blob: sourceBlob,
    publish,
    discard,
    hasContentFor,
  } = useInPlaceObjectUrl(source)
  const onDownloadErrorRef = useRef(onDownloadError)
  const HeadingTag = `h${headingLevel}` as const

  useEffect(() => {
    onDownloadErrorRef.current = onDownloadError
  }, [onDownloadError])

  useEffect(() => {
    let active = true

    const loadPreview = async () => {
      try {
        // Exactly one source is allowed (see GfsImagePreviewSource). Reject
        // both missing and ambiguous sources before reading either one.
        if ((dataBase64 === undefined) === (gfsUri === undefined)) {
          throw new Error('Image preview requires exactly one source')
        }
        // The listed size is a skip HINT (fail fast without a round-trip); the
        // download itself is independently bounded so a wrong listed size cannot
        // materialize an oversized payload.
        assertGfsImagePreviewSize(byteLength)
        let bytes: ArrayBuffer
        if (dataBase64 !== undefined) {
          // Inline source (chat image attachments): the bytes already sit on
          // the attachment, so decode locally instead of a GFS round-trip.
          // Still guard the DECODED length — a lying `byteLength` hint must
          // not materialize an oversized blob.
          assertGfsImagePreviewSize(estimateBase64DecodedLength(dataBase64))
          bytes = decodeBase64ToArrayBuffer(dataBase64)
          assertGfsImagePreviewSize(bytes.byteLength)
        } else {
          const downloaded = await window.clerum.gfs.downloadPreview(
            // Non-null by the source guard above (dataBase64 is absent → gfsUri
            // is present).
            gfsUri!,
            GFS_IMAGE_PREVIEW_MAX_BYTES
          )
          bytes = downloaded.bytes
          assertGfsImagePreviewSize(bytes.byteLength)
        }
        if (!active) return
        // Non-null by the source guard above.
        publish(source!, new Blob([bytes], { type: mimeType }))
        setPreviewError(null)
        setUpdateError(null)
      } catch (error) {
        if (!active) return
        onDownloadErrorRef.current?.(error)
        // Through the shared read-plane presenter, not raw. `downloadPreview`
        // crosses Electron IPC, so a rejection arrives as
        // "Error invoking remote method 'gfs:downloadPreview': Error: 429 …" —
        // our own process boundary plus a bare status line, put in front of the
        // user in a banner. The presenter strips the wrapper and gives a rate
        // limit the same words the Files page uses; the size guards above and
        // the download ceiling keep theirs, because it passes every other
        // verdict through untouched.
        const message =
          error instanceof Error
            ? describeGfsReadError(error).message
            : 'Could not load the image preview'
        const rawMessage = error instanceof Error ? error.message : String(error)
        // A rejected session fails closed even mid-reload: bytes fetched under it
        // must not stay on screen. A per-resource 403/404 instead keeps the
        // version already shown — losing access to this one file is decided by
        // the authoritative resolve, which remounts this body.
        if (isGfsSessionAuthorityFailure(rawMessage, 'operation')) {
          discard()
          setUpdateError(null)
          setPreviewError(message)
        } else if (hasContentFor(source)) setUpdateError(message)
        else setPreviewError(message)
      }
    }

    void loadPreview()
    return () => {
      active = false
    }
  }, [byteLength, contentVersion, gfsUri, dataBase64, mimeType, discard, hasContentFor, publish])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const copyImageToClipboard = useCallback(async (): Promise<boolean> => {
    if (!sourceBlob || !mountedRef.current || previewError) return false
    try {
      const copied = await copyImageBlobToClipboard(sourceBlob, () => mountedRef.current)
      return copied && mountedRef.current
    } catch {
      return false
    }
  }, [previewError, sourceBlob])

  useEffect(() => {
    onCopyContentReady?.(sourceBlob && !previewError ? copyImageToClipboard : null)
    return () => onCopyContentReady?.(null)
  }, [copyImageToClipboard, onCopyContentReady, previewError, sourceBlob])

  return (
    <>
      <header className="da-gfs-image-preview-dialog__header">
        <div className="da-gfs-image-preview-dialog__header-main da-gfs-preview-title-row">
          <HeadingTag className="da-gfs-preview-title" id={headingId}>
            {fileName}
          </HeadingTag>
          {titleActions}
          {permissionProgress}
        </div>
        <div className="da-gfs-image-preview-dialog__header-actions">{headerActions}</div>
      </header>
      <div className="da-gfs-image-preview-dialog__body">
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
          <div className="da-gfs-image-preview-dialog__loading" role="status">
            Loading image preview…
          </div>
        ) : null}
        {previewUrl && !previewError ? (
          <img
            alt={`Preview of ${fileName}`}
            className="da-gfs-image-preview-dialog__image"
            onError={() => setPreviewError('This image could not be displayed')}
            src={previewUrl}
          />
        ) : null}
      </div>
    </>
  )
}

function decodeBase64ToArrayBuffer(dataBase64: string): ArrayBuffer {
  const binary = window.atob(dataBase64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes.buffer
}
