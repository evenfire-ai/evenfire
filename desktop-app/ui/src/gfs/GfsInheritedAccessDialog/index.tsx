import { useEffect, useId, useState } from 'react'
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
  const [showHelp, setShowHelp] = useState(false)

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
  const title = isRemove ? 'Remove access on parent folder?' : 'Update role on parent folder?'
  const lead = isRemove
    ? `Removing ${request.memberLabel}'s access to this item will also remove their access on a parent folder.`
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
        aria-labelledby={titleId}
        aria-modal="true"
        className="da-gfs-parent-update-dialog"
        role="alertdialog"
      >
        <header className="da-gfs-parent-update-dialog__header">
          <h3 id={titleId}>{showHelp ? 'How sharing works in EvenDrive' : title}</h3>
        </header>
        <div className="da-gfs-parent-update-dialog__body">
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
              <div className="da-gfs-parent-update-dialog__columns">
                <div className="da-gfs-parent-update-dialog__column">
                  <span className="da-gfs-parent-update-dialog__name">
                    {request.parentFolderName}
                  </span>
                  <span className="da-gfs-parent-update-dialog__change">
                    <span className="da-gfs-parent-update-dialog__role">
                      {ROLE_LABELS[request.parentCurrentRole]}
                    </span>
                    <span aria-hidden="true">→</span>
                    <span className="da-gfs-parent-update-dialog__role da-gfs-parent-update-dialog__role--next">
                      {parentNextLabel}
                    </span>
                  </span>
                </div>
                <div className="da-gfs-parent-update-dialog__column">
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
              <Button autoFocus disabled={busy} onClick={onCancel} type="button" variant="ghost">
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
