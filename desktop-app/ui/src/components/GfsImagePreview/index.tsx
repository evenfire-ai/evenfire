import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@components/Common'
import { IconClose, IconCopy } from '@components/SidebarNav/icons'
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
  dataBase64,
  mimeType,
  onClose,
  reloadVersion,
  unavailable = false,
  onDownloadError,
  recordOpen,
}: GfsImagePreviewProps) {
  const titleId = useId()
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)
  const copyContentRef = useRef<(() => Promise<boolean>) | null>(null)
  const copiedResetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [copyContentReady, setCopyContentReady] = useState(false)
  const [copied, setCopied] = useState(false)
  const backdropStyle = useWorkspaceModalStyle()

  const clearCopiedResetTimeout = useCallback(() => {
    if (copiedResetTimeoutRef.current !== null) {
      clearTimeout(copiedResetTimeoutRef.current)
      copiedResetTimeoutRef.current = null
    }
  }, [])

  const handleCopyContentReady = useCallback(
    (copy: (() => Promise<boolean>) | null) => {
      copyContentRef.current = copy
      setCopyContentReady(Boolean(copy))
      if (!copy) {
        clearCopiedResetTimeout()
        setCopied(false)
      }
    },
    [clearCopiedResetTimeout]
  )

  const handleCopy = async () => {
    const copy = copyContentRef.current
    if (!copy) return
    clearCopiedResetTimeout()
    setCopied(false)
    try {
      if (!(await copy())) return
      clearCopiedResetTimeout()
      setCopied(true)
      copiedResetTimeoutRef.current = setTimeout(() => {
        copiedResetTimeoutRef.current = null
        setCopied(false)
      }, 2_000)
    } catch {
      setCopied(false)
    }
  }

  useEffect(() => clearCopiedResetTimeout, [clearCopiedResetTimeout])

  useEffect(() => {
    closeButtonRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const closeButton = (
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
  )

  // This modal is also used by plugin-provided GFS resources, which do not mount
  // FilePreviewPage's shared toolbar. Keep Copy beside Close for both sources.
  const copyButton =
    dataBase64 !== undefined || gfsUri !== undefined ? (
      <Button
        className="da-gfs-image-preview-dialog__copy"
        aria-label={copied ? 'Copied image to clipboard' : 'Copy image to clipboard'}
        color="neutral"
        disabled={!copyContentReady}
        onClick={() => void handleCopy()}
        variant="ghost"
      >
        <IconCopy width={18} height={18} />
        <span className="da-gfs-preview-button__label">{copied ? 'Copied' : 'Copy'}</span>
      </Button>
    ) : null

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
          <>
            <header className="da-gfs-image-preview-dialog__header">
              <h3 id={titleId}>File unavailable</h3>
              {closeButton}
            </header>
            <div className="da-gfs-image-preview-dialog__body">
              <div className="empty-state">
                <p className="muted">This item is no longer available.</p>
              </div>
            </div>
          </>
        ) : (
          <GfsImagePreviewBody
            key={`${gfsUri}:${reloadVersion ?? 0}`}
            byteLength={byteLength}
            fileName={fileName}
            gfsUri={gfsUri}
            dataBase64={dataBase64}
            mimeType={mimeType}
            onDownloadError={onDownloadError}
            recordOpen={recordOpen}
            onCopyContentReady={handleCopyContentReady}
            titleId={titleId}
            headerActions={
              <>
                {copyButton}
                {closeButton}
              </>
            }
          />
        )}
      </section>
    </div>,
    document.body
  )
}

export { GfsImagePreviewBody } from './Body'
export type { GfsImagePreviewProps, GfsImagePreviewSource } from './types'
