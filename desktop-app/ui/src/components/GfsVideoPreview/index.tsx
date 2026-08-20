import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconButton, StatusBanner } from '@components/Common'
import { IconClose } from '@components/SidebarNav/icons'
import { assertGfsVideoPreviewSize } from '@lib/gfsVideoPreview'
import type { GfsVideoPreviewProps } from './types'

export function GfsVideoPreview({
  byteLength,
  fileName,
  gfsUri,
  mimeType,
  onClose,
  onDownloadError,
}: GfsVideoPreviewProps) {
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
        assertGfsVideoPreviewSize(byteLength)
        const { bytes } = await window.clerum.gfs.download(gfsUri)
        assertGfsVideoPreviewSize(bytes.byteLength)
        if (!active) return
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: mimeType }))
        setPreviewUrl(objectUrl)
      } catch (error) {
        if (!active) return
        onDownloadError?.(error)
        setPreviewError(error instanceof Error ? error.message : 'Could not load the video preview')
      }
    }

    void loadPreview()
    return () => {
      active = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [byteLength, gfsUri, mimeType, onDownloadError])

  return createPortal(
    <div
      className="da-gfs-video-preview-modal"
      role="presentation"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        className="da-gfs-video-preview-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="da-gfs-video-preview-dialog__header">
          <h3 id={titleId}>{fileName}</h3>
          <IconButton
            ref={closeButtonRef}
            label="Close video preview"
            onClick={onClose}
            size="sm"
            variant="ghost"
          >
            <IconClose />
          </IconButton>
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
      </section>
    </div>,
    document.body
  )
}

export type { GfsVideoPreviewProps } from './types'
