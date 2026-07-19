import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconButton, StatusBanner } from '@components/Common'
import { IconClose } from '@components/SidebarNav/icons'
import { assertGfsImagePreviewSize } from '@lib/gfsImagePreview'
import type { GfsImagePreviewProps } from './types'

export function GfsImagePreview({
  byteLength,
  fileName,
  gfsUri,
  mimeType,
  onClose,
}: GfsImagePreviewProps) {
  const titleId = useId()
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)

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

    const loadPreview = async () => {
      try {
        assertGfsImagePreviewSize(byteLength)
        const { bytes } = await window.clerum.gfs.download(gfsUri)
        assertGfsImagePreviewSize(bytes.byteLength)
        if (!active) return
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: mimeType }))
        setPreviewUrl(objectUrl)
      } catch (error) {
        if (!active) return
        setPreviewError(error instanceof Error ? error.message : 'Could not load the image preview')
      }
    }

    void loadPreview()
    return () => {
      active = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [byteLength, gfsUri, mimeType])

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
          <IconButton
            ref={closeButtonRef}
            label="Close image preview"
            onClick={onClose}
            size="sm"
            variant="ghost"
          >
            <IconClose />
          </IconButton>
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

export type { GfsImagePreviewProps } from './types'
