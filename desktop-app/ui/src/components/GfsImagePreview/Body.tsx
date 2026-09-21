import { useEffect, useId, useRef, useState } from 'react'
import { Button, StatusBanner } from '@components/Common'
import { IconCopy } from '@components/SidebarNav/icons'
import { GFS_IMAGE_PREVIEW_MAX_BYTES } from '@constants/gfsImagePreview'
import { assertGfsImagePreviewSize } from '@lib/gfsImagePreview'
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
        // The listed size is a skip HINT (fail fast without a round-trip); the
        // download itself is independently bounded so a wrong listed size cannot
        // materialize an oversized payload.
        assertGfsImagePreviewSize(byteLength)
        const { bytes } = await window.clerum.gfs.downloadPreview(
          gfsUri,
          GFS_IMAGE_PREVIEW_MAX_BYTES
        )
        assertGfsImagePreviewSize(bytes.byteLength)
        if (!active) return
        const blob = new Blob([bytes], { type: mimeType })
        setSourceBlob(blob)
        objectUrl = URL.createObjectURL(blob)
        setPreviewUrl(objectUrl)
      } catch (error) {
        if (!active) return
        onDownloadErrorRef.current?.(error)
        setPreviewError(error instanceof Error ? error.message : 'Could not load the image preview')
      }
    }

    void loadPreview()
    return () => {
      active = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [byteLength, gfsUri, mimeType])

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
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        let clipboardBlob: Blob | null = sourceBlob
        if (!sourceBlob.type.includes('png')) {
          clipboardBlob = await convertBlobToPng(sourceBlob)
        }
        if (!mountedRef.current) return
        if (clipboardBlob) {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': clipboardBlob })])
          if (!mountedRef.current) return
          markCopyState('copied')
          return
        }
      }
      if (navigator.clipboard?.writeText) {
        const dataUrl = await blobToDataUrl(sourceBlob)
        if (!mountedRef.current) return
        await navigator.clipboard.writeText(dataUrl)
        if (!mountedRef.current) return
        markCopyState('copied')
      } else {
        markCopyState('error')
      }
    } catch {
      markCopyState('error')
    }
  }

  return (
    <>
      <header className="da-gfs-image-preview-dialog__header">
        <HeadingTag className="da-gfs-preview-title" id={headingId}>
          {fileName}
        </HeadingTag>
        <div className="da-gfs-image-preview-dialog__header-actions">
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
          {headerActions}
        </div>
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

async function convertBlobToPng(blob: Blob): Promise<Blob | null> {
  if (typeof createImageBitmap === 'undefined') return null
  try {
    const bitmap = await createImageBitmap(blob)
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(bitmap, 0, 0)
    return await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
  } catch {
    return null
  }
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const result = await new Promise<string | ArrayBuffer | null>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the image'))
    reader.readAsDataURL(blob)
  })
  if (typeof result !== 'string') throw new Error('Could not read the image')
  return result
}
