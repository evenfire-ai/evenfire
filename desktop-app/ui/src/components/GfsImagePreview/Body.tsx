import { useEffect, useId, useRef, useState } from 'react'
import { Button, StatusBanner } from '@components/Common'
import { IconCopy } from '@components/SidebarNav/icons'
import { GFS_IMAGE_PREVIEW_MAX_BYTES } from '@constants/gfsImagePreview'
import { estimateBase64DecodedLength } from '@lib/base64Size'
import { describeGfsReadError } from '@lib/gfsGrantErrors'
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
  fileName,
  gfsUri,
  dataBase64,
  mimeType,
  onDownloadError,
  titleId,
  headerActions,
  headingLevel = 3,
}: GfsImagePreviewBodyProps) {
  const generatedTitleId = useId()
  const headingId = titleId ?? generatedTitleId
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [sourceBlob, setSourceBlob] = useState<Blob | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle')
  const copyResetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)
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
        const blob = new Blob([bytes], { type: mimeType })
        setSourceBlob(blob)
        objectUrl = URL.createObjectURL(blob)
        setPreviewUrl(objectUrl)
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
        setPreviewError(
          error instanceof Error
            ? describeGfsReadError(error).message
            : 'Could not load the image preview'
        )
      }
    }

    void loadPreview()
    return () => {
      active = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [byteLength, gfsUri, dataBase64, mimeType])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (copyResetTimeoutRef.current) clearTimeout(copyResetTimeoutRef.current)
    }
  }, [])

  function markCopyState(state: 'copied' | 'error'): boolean {
    if (!mountedRef.current) return false
    setCopyState(state)
    if (copyResetTimeoutRef.current) clearTimeout(copyResetTimeoutRef.current)
    copyResetTimeoutRef.current = setTimeout(() => {
      if (mountedRef.current) setCopyState('idle')
    }, 2000)
    return true
  }

  async function copyImageToClipboard(): Promise<void> {
    if (!sourceBlob || !mountedRef.current) return
    try {
      const copied = await copyImageBlobToClipboard(sourceBlob, () => mountedRef.current)
      if (copied && mountedRef.current) markCopyState('copied')
    } catch {
      if (mountedRef.current) markCopyState('error')
    }
  }

  return (
    <>
      <header className="da-gfs-image-preview-dialog__header">
        <div className="da-gfs-image-preview-dialog__header-main">
          <Button
            className="da-gfs-image-preview-dialog__copy"
            aria-label={
              copyState === 'copied' ? 'Copied image to clipboard' : 'Copy image to clipboard'
            }
            color="neutral"
            disabled={!sourceBlob}
            onClick={() => void copyImageToClipboard()}
            variant="ghost"
          >
            <IconCopy width={18} height={18} />
            <span className="da-gfs-preview-button__label">
              {copyState === 'copied' ? 'Copied' : 'Copy'}
            </span>
          </Button>
          <HeadingTag className="da-gfs-preview-title" id={headingId}>
            {fileName}
          </HeadingTag>
        </div>
        <div className="da-gfs-image-preview-dialog__header-actions">{headerActions}</div>
      </header>
      <div className="da-gfs-image-preview-dialog__body">
        {previewError ? <StatusBanner tone="error" text={previewError} /> : null}
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
