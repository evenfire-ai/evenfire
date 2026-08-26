'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconX } from '@components/icons'
import { Button } from '@components/ui'
import { gfsFetchFileBlob } from '@lib/api'
import { assertGfsVideoPreviewSize } from '@lib/gfsVideoPreview'
import type { GfsVideoPreviewProps } from './types'

export function GfsVideoPreview({
  byteLength,
  fileName,
  mimeType,
  onClose,
  rid,
}: GfsVideoPreviewProps): React.JSX.Element {
  const titleId = useId()
  const dialogRef = useRef<HTMLElement | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)

  useEffect(() => {
    const previouslyFocused = document.activeElement
    dialogRef.current?.querySelector<HTMLButtonElement>('[data-preview-close]')?.focus()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      if (previouslyFocused instanceof HTMLElement && document.contains(previouslyFocused)) {
        previouslyFocused.focus()
      }
    }
  }, [onClose])

  useEffect(() => {
    let active = true
    let objectUrl: string | null = null

    async function loadPreview(): Promise<void> {
      try {
        assertGfsVideoPreviewSize(byteLength)
        const sourceBlob = await gfsFetchFileBlob(rid)
        assertGfsVideoPreviewSize(sourceBlob.size)
        if (!active) return
        objectUrl = URL.createObjectURL(new Blob([sourceBlob], { type: mimeType }))
        setPreviewUrl(objectUrl)
      } catch (error) {
        if (!active) return
        setPreviewError(error instanceof Error ? error.message : 'Could not load the video preview')
      }
    }

    void loadPreview()
    return () => {
      active = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [byteLength, mimeType, rid])

  return createPortal(
    <div
      className="cu-modal-backdrop cu-gfs-video-preview-modal"
      role="presentation"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        className="cu-gfs-video-preview-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="cu-gfs-video-preview-dialog__header">
          <h3 id={titleId}>{fileName}</h3>
          <Button
            className="cu-gfs-video-preview-dialog__close"
            data-preview-close
            variant="ghost"
            aria-label="Close video preview"
            onClick={onClose}
          >
            <IconX width={18} height={18} />
          </Button>
        </header>
        <div className="cu-gfs-video-preview-dialog__body">
          {previewError ? (
            <div className="cu-banner cu-banner--error" role="alert">
              {previewError}
            </div>
          ) : null}
          {!previewError && !previewUrl ? (
            <div className="cu-gfs-video-preview-dialog__loading" role="status">
              Loading video preview…
            </div>
          ) : null}
          {previewUrl && !previewError ? (
            <video
              aria-label={`Video preview of ${fileName}`}
              className="cu-gfs-video-preview-dialog__video"
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
