'use client'

import { useEffect, useId, useRef, useState } from 'react'
import type { GfsInheritedAccessDialogProps, GfsInheritedAccessRole } from './types'

/**
 * Google-Drive-style confirmation for editing an inherited access row in the
 * Share dialog: the member's access is configured on a parent folder, so any
 * role change (or removal) is applied there and cascades to everything inside
 * the folder. "Learn more" swaps the confirmation for a short help panel
 * explaining the cascade and the limited-access-folder alternative.
 */

const ROLE_LABELS: Record<GfsInheritedAccessRole, string> = {
  read: 'Read',
  editor: 'Editor',
}

const HELP_POINTS = [
  "A folder's permissions apply to every file and subfolder inside it.",
  "You can't give someone less access on a single file than they have on its parent folder.",
  'To limit access to one file, create a folder with limited access and share the file from there.',
]

export function GfsInheritedAccessDialog({
  request,
  busy = false,
  onConfirm,
  onCancel,
}: GfsInheritedAccessDialogProps): React.JSX.Element | null {
  const titleId = useId()
  const bodyId = useId()
  const columnsId = useId()
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null)
  const [showHelp, setShowHelp] = useState(false)

  useEffect(() => {
    if (!request) return
    const previousActiveElement =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    cancelButtonRef.current?.focus()

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onCancel()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      previousActiveElement?.focus()
    }
  }, [onCancel, request])

  // A new request always reopens on the confirmation view.
  useEffect(() => {
    setShowHelp(false)
  }, [request])

  if (!request) return null

  const isRemove = request.mode === 'remove'
  const nextLabel = isRemove
    ? request.fileRemainingRole
      ? ROLE_LABELS[request.fileRemainingRole]
      : 'No access'
    : request.nextRole
      ? ROLE_LABELS[request.nextRole]
      : ''
  const parentNextLabel = isRemove ? 'No access' : nextLabel
  const confirmLabel = isRemove ? 'Remove' : 'Update role'
  const title = isRemove ? 'Remove access on parent folder?' : 'Update role on parent folder?'
  const lead = isRemove
    ? `Removing ${request.memberLabel}'s access to this item will also remove their access on a parent folder.`
    : `Changing ${request.memberLabel}'s permissions on this item will also change permissions on a parent folder.`

  return (
    <div
      className="cu-modal-backdrop"
      role="presentation"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      <section
        className="cu-modal-panel cu-modal-panel--confirm cu-gfs-parent-update"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={showHelp ? `${bodyId}` : `${bodyId} ${columnsId}`}
        onMouseDown={event => event.stopPropagation()}
      >
        <div className="cu-modal-panel__head">
          <h3 id={titleId} className="cu-modal-panel__title">
            {showHelp ? 'How sharing works in EvenDrive' : title}
          </h3>
        </div>
        {showHelp ? (
          <div id={bodyId} className="cu-modal-copy">
            <ul className="cu-gfs-parent-update__help">
              {HELP_POINTS.map(point => (
                <li key={point}>{point}</li>
              ))}
            </ul>
          </div>
        ) : (
          <>
            <p id={bodyId} className="cu-modal-copy">
              {lead} Alternatively, create a folder with limited access.{' '}
              <button
                type="button"
                className="cu-gfs-parent-update__learn-more"
                onClick={() => setShowHelp(true)}
              >
                Learn more
              </button>
            </p>
            <div id={columnsId} className="cu-gfs-parent-update__columns">
              <div className="cu-gfs-parent-update__column">
                <span className="cu-gfs-parent-update__name">{request.parentFolderName}</span>
                <span className="cu-gfs-parent-update__change">
                  <span className="cu-gfs-parent-update__role">
                    {ROLE_LABELS[request.parentCurrentRole]}
                  </span>
                  <span aria-hidden="true">→</span>
                  <span className="cu-gfs-parent-update__role cu-gfs-parent-update__role--next">
                    {parentNextLabel}
                  </span>
                </span>
              </div>
              <div className="cu-gfs-parent-update__column">
                <span className="cu-gfs-parent-update__name">{request.fileName}</span>
                <span className="cu-gfs-parent-update__change">
                  <span className="cu-gfs-parent-update__role">
                    {ROLE_LABELS[request.fileCurrentRole]}
                  </span>
                  <span aria-hidden="true">→</span>
                  <span className="cu-gfs-parent-update__role cu-gfs-parent-update__role--next">
                    {nextLabel}
                  </span>
                </span>
              </div>
            </div>
          </>
        )}
        <div className="cu-modal-panel__foot">
          {showHelp ? (
            <button
              ref={cancelButtonRef}
              type="button"
              className="cu-btn cu-btn--ghost"
              onClick={() => setShowHelp(false)}
            >
              Back
            </button>
          ) : (
            <>
              <button
                ref={cancelButtonRef}
                type="button"
                className="cu-btn cu-btn--ghost"
                disabled={busy}
                onClick={onCancel}
              >
                Cancel
              </button>
              <button
                type="button"
                className={`cu-btn ${isRemove ? 'cu-btn--danger' : 'cu-btn--primary'}`}
                disabled={busy}
                onClick={onConfirm}
              >
                {busy ? 'Updating…' : confirmLabel}
              </button>
            </>
          )}
        </div>
      </section>
    </div>
  )
}
