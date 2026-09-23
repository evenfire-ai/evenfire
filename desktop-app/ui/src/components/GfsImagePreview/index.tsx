import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@components/Common'
import { EmptyState } from '@components/Common'
import { IconClose } from '@components/SidebarNav/icons'
import { useWorkspaceModalStyle } from '@hooks/useWorkspaceModalStyle'
import { GfsImagePreviewBody } from './Body'
import type { GfsImagePreviewProps } from './types'

/**
 * Modal chrome around {@link GfsImagePreviewBody} (spec 18 §3.B.2): portal,
 * backdrop, `role="dialog"`, focus-on-open, Escape-to-close, and the workspace
 * backdrop positioning. The body owns the fetch/copy/size-guard so both this
 * modal and `FilePreviewPage` share one implementation.
 */
export function GfsImagePreview({
  byteLength,
  fileName,
  gfsUri,
  mimeType,
  onClose,
  reloadVersion,
  unavailable = false,
  onDownloadError,
}: GfsImagePreviewProps) {
  const titleId = useId()
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)
  const backdropStyle = useWorkspaceModalStyle()

  useEffect(() => {
    closeButtonRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return createPortal(
    <div
      className="da-gfs-image-preview-modal"
      role="presentation"
      style={backdropStyle}
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
        {unavailable ? (
          <EmptyState title="File unavailable" body="This item is no longer available." />
        ) : (
          <GfsImagePreviewBody
            key={`${gfsUri}:${reloadVersion ?? 0}`}
            byteLength={byteLength}
            fileName={fileName}
            gfsUri={gfsUri}
            mimeType={mimeType}
            onDownloadError={onDownloadError}
            titleId={titleId}
            headerActions={
              <Button
                className="da-gfs-image-preview-dialog__close"
                data-preview-close
                ref={closeButtonRef}
                aria-label="Close image preview"
                color="neutral"
                onClick={onClose}
                variant="ghost"
              >
                <IconClose width={18} height={18} />
              </Button>
            }
          />
        )}
      </section>
    </div>,
    document.body
  )
}

export { GfsImagePreviewBody } from './Body'
export type { GfsImagePreviewProps } from './types'
