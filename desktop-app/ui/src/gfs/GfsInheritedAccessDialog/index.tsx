import { useEffect, useId, useRef, useState } from 'react'
import { Button } from '@components/Common'
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
}: GfsInheritedAccessDialogProps) {
  const titleId = useId()
  const bodyId = useId()
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null)
  const previousActiveElementRef = useRef<HTMLElement | null>(null)
  const [showHelp, setShowHelp] = useState(false)
  // Keyed on open/close transitions, not the request object identity: the
  // parent rebuilds the request object on every render, and refiring per
  // render would reset the help view and steal focus mid-dialog.
  const open = request !== null

  useEffect(() => {
    setShowHelp(false)
  }, [open])

  useEffect(() => {
    if (!open) return
    const previousActiveElement =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    previousActiveElementRef.current = previousActiveElement
    cancelButtonRef.current?.focus()
    return () => {
      previousActiveElementRef.current?.focus()
    }
  }, [open])

  if (!request) return null

  const isRemove = request.mode === 'remove'
  const nextLabel = isRemove ? 'Remove' : request.nextRole ? ROLE_LABELS[request.nextRole] : ''
  const title = isRemove ? 'Remove from parent folder?' : 'Update role on parent folder?'
  const lead = isRemove
    ? `Removing ${request.memberLabel} from this item will also remove them from a parent folder.`
    : `Changing ${request.memberLabel}'s permissions on this item will also change permissions on a parent folder.`

  return (
    <div
      className="da-gfs-manage-modal da-gfs-parent-update-modal"
      role="presentation"
      onMouseDown={event => {
        if (event.target === event.currentTarget && !busy) onCancel()
      }}
    >
      <section
        aria-describedby={bodyId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="da-gfs-parent-update-dialog"
        role="alertdialog"
      >
        <header className="da-gfs-parent-update-dialog__header">
          <h3 id={titleId}>{showHelp ? 'How sharing works in EvenDrive' : title}</h3>
        </header>
        <div className="da-gfs-parent-update-dialog__body" id={bodyId}>
          {showHelp ? (
            <ul className="da-gfs-parent-update-dialog__help">
              {HELP_POINTS.map(point => (
                <li key={point}>{point}</li>
              ))}
            </ul>
          ) : (
            <>
              <p className="da-gfs-parent-update-dialog__lead">
                {lead} Alternatively, create a folder with limited access.{' '}
                <button
                  className="da-gfs-parent-update-dialog__learn-more"
                  onClick={() => setShowHelp(true)}
                  type="button"
                >
                  Learn more
                </button>
              </p>
              <div className="da-gfs-parent-update-dialog__folders">
                {request.folders.map(folder => (
                  <div className="da-gfs-parent-update-dialog__folder" key={folder.resourceId}>
                    <span className="da-gfs-parent-update-dialog__name">{folder.name}</span>
                    <span className="da-gfs-parent-update-dialog__change">
                      <span className="da-gfs-parent-update-dialog__role">
                        {ROLE_LABELS[folder.currentRole]}
                      </span>
                      <span aria-hidden="true">→</span>
                      <span className="da-gfs-parent-update-dialog__role da-gfs-parent-update-dialog__role--next">
                        {nextLabel}
                      </span>
                    </span>
                  </div>
                ))}
                <div className="da-gfs-parent-update-dialog__folder">
                  <span className="da-gfs-parent-update-dialog__name">{request.fileName}</span>
                  <span className="da-gfs-parent-update-dialog__change">
                    <span className="da-gfs-parent-update-dialog__role">
                      {ROLE_LABELS[request.fileCurrentRole]}
                    </span>
                    <span aria-hidden="true">→</span>
                    <span className="da-gfs-parent-update-dialog__role da-gfs-parent-update-dialog__role--next">
                      {nextLabel}
                    </span>
                  </span>
                </div>
              </div>
            </>
          )}
        </div>
        <footer className="da-gfs-parent-update-dialog__actions">
          {showHelp ? (
            <Button onClick={() => setShowHelp(false)} type="button" variant="ghost">
              Back
            </Button>
          ) : (
            <>
              <Button
                ref={cancelButtonRef}
                disabled={busy}
                onClick={onCancel}
                type="button"
                variant="ghost"
              >
                Cancel
              </Button>
              <Button
                color={isRemove ? 'danger' : undefined}
                loading={busy}
                onClick={onConfirm}
                type="button"
              >
                {isRemove ? 'Remove' : 'Update role'}
              </Button>
            </>
          )}
        </footer>
      </section>
    </div>
  )
}
