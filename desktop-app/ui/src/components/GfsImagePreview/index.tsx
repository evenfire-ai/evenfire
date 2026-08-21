import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconButton, StatusBanner } from '@components/Common'
import { IconClose, IconCopy } from '@components/SidebarNav/icons'
import { getCachedGfsBlob, setCachedGfsBlob } from '@lib/gfsBlobCache'
import { assertGfsImagePreviewSize } from '@lib/gfsImagePreview'
import type { GfsImagePreviewProps } from './types'

export function GfsImagePreview({
  byteLength,
  fileName,
  gfsUri,
  mimeType,
  onClose,
  onDownloadError,
}: GfsImagePreviewProps) {
  const titleId = useId()
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [sourceBlob, setSourceBlob] = useState<Blob | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle')
  const copyResetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Translate gfs://<drive>/<rid> to a stable cache key so we can share
  // the row thumbnail's blob URL with this preview modal.
  const cacheKey = gfsUriCacheKey(gfsUri)

  useEffect(() => {
    closeButtonRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  useEffect(() => {
    let active = true
    let objectUrl: string | null = null
    const isFromCacheRef = { current: false }

    const loadPreview = async () => {
      // If the row thumbnail already paid the proxy round-trip for this
      // resource, reuse its object URL and skip the network entirely.
      const cached = getCachedGfsBlob(cacheKey)
      if (cached) {
        isFromCacheRef.current = true
        if (!active) return
        setPreviewUrl(cached.blobUrl)
        // The cached blob is reachable only through the object URL; for
        // the "Copy" affordance we still need a Blob. Issue a fetch on
        // the object URL to materialise it cheaply.
        try {
          const cachedBlob = await (await fetch(cached.blobUrl)).blob()
          if (active) setSourceBlob(cachedBlob)
        } catch {
          /* Copy will surface the error in copyImageToClipboard. */
        }
        return
      }

      try {
        assertGfsImagePreviewSize(byteLength)
        const { bytes } = await window.clerum.gfs.download(gfsUri)
        assertGfsImagePreviewSize(bytes.byteLength)
        if (!active) return
        const blob = new Blob([bytes], { type: mimeType })
        setSourceBlob(blob)
        objectUrl = URL.createObjectURL(blob)
        // Publish to the cache so the next preview open skips the
        // network. We don't revoke the URL on unmount — the next open
        // may want it.
        setCachedGfsBlob(cacheKey, { blobUrl: objectUrl, mimeType: blob.type })
        setPreviewUrl(objectUrl)
      } catch (error) {
        if (!active) return
        onDownloadError?.(error)
        setPreviewError(error instanceof Error ? error.message : 'Could not load the image preview')
      }
    }

    void loadPreview()
    return () => {
      active = false
      // Only revoke object URLs we created ourselves. Cache-served URLs
      // are owned by the row thumbnail component.
      if (objectUrl && !isFromCacheRef.current) URL.revokeObjectURL(objectUrl)
    }
  }, [byteLength, cacheKey, gfsUri, mimeType, onDownloadError])

  useEffect(() => {
    return () => {
      if (copyResetTimeoutRef.current) clearTimeout(copyResetTimeoutRef.current)
    }
  }, [])

  async function copyImageToClipboard(): Promise<void> {
    if (!sourceBlob) return
    try {
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        let clipboardBlob: Blob | null = sourceBlob
        if (!sourceBlob.type.includes('png')) {
          clipboardBlob = await convertBlobToPng(sourceBlob)
        }
        if (clipboardBlob) {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': clipboardBlob })])
          setCopyState('copied')
        } else if (navigator.clipboard?.writeText && previewUrl) {
          await navigator.clipboard.writeText(previewUrl)
          setCopyState('copied')
        } else {
          setCopyState('error')
        }
      } else if (navigator.clipboard?.writeText && previewUrl) {
        await navigator.clipboard.writeText(previewUrl)
        setCopyState('copied')
      } else {
        setCopyState('error')
      }
    } catch {
      setCopyState('error')
    }
    if (copyResetTimeoutRef.current) clearTimeout(copyResetTimeoutRef.current)
    copyResetTimeoutRef.current = setTimeout(() => setCopyState('idle'), 2000)
  }

  return createPortal(
    <div
      className="da-gfs-image-preview-modal"
      role="presentation"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        className="da-gfs-image-preview-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="da-gfs-image-preview-dialog__header">
          <h3 id={titleId}>{fileName}</h3>
          <div className="da-gfs-image-preview-dialog__header-actions">
            <IconButton
              label={
                copyState === 'copied' ? 'Copied image to clipboard' : 'Copy image to clipboard'
              }
              disabled={!sourceBlob}
              onClick={() => void copyImageToClipboard()}
              size="sm"
              variant="ghost"
            >
              <IconCopy />
            </IconButton>
            <IconButton
              ref={closeButtonRef}
              label="Close image preview"
              onClick={onClose}
              size="sm"
              variant="ghost"
            >
              <IconClose />
            </IconButton>
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
      </section>
    </div>,
    document.body
  )
}

/** Strip the `gfs://<drive>/` prefix to expose just the resource id,
 *  which is the same key the row thumbnail uses for the blob cache. */
function gfsUriCacheKey(gfsUri: string): string {
  const slash = gfsUri.lastIndexOf('/')
  return slash >= 0 ? gfsUri.slice(slash + 1) : gfsUri
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

export type { GfsImagePreviewProps } from './types'
