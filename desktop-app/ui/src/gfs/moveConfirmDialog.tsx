import { useEffect, useRef, useState } from 'react'
import { Button } from '@components/Common'

export interface GfsMoveConfirmRequest {
  /** Sanitizable display facts of the moving folder. */
  sourceName: string
  destinationName: string
  /** Suggested numbered-name candidate, when destination names are known. */
  suggestedName?: string
  /** Numbered renaming is allowed (source-resource write proved). */
  canRename: boolean
}

export interface GfsMoveConfirmDialogProps {
  request: GfsMoveConfirmRequest
  busy?: boolean
  onConfirm: (options: { allowNumberedRename: boolean }) => void
  onCancel: () => void
}

/**
 * The ONE confirmation for folder moves (rev-2 §1): explains the
 * inherited-access impact and records the conflict naming policy in the same
 * dialog, so no second automatic prompt follows the drop. Files move without
 * confirmation. Escape/Cancel end the admission before dispatch; once the
 * PATCH is dispatched it cannot be recalled.
 */
export function GfsMoveConfirmDialog({
  request,
  busy = false,
  onConfirm,
  onCancel,
}: GfsMoveConfirmDialogProps) {
  const [allowNumberedRename, setAllowNumberedRename] = useState(false)
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    cancelButtonRef.current?.focus()
  }, [])

  useEffect(() => {
    if (busy) return
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [busy, onCancel])

  return (
    <div
      className="da-gfs-manage-modal"
      role="presentation"
      onMouseDown={event => {
        if (!busy && event.target === event.currentTarget) onCancel()
      }}
    >
      <section
        aria-label={`Move folder ${request.sourceName} to ${request.destinationName}`}
        aria-modal="true"
        className="da-gfs-manage-dialog da-gfs-move-confirm-dialog"
        role="dialog"
      >
        <header className="da-gfs-manage-dialog__header">
          <span className="da-gfs-manage-dialog__heading">
            <h3>
              Move “{request.sourceName}” to “{request.destinationName}”?
            </h3>
          </span>
        </header>
        <div className="da-gfs-manage-dialog__body">
          <p className="da-gfs-move-confirm-dialog__impact">
            Inherited access to this folder and its contents follows the new location. Direct
            sharing entries stay with their items — including any access they grant — and you may
            lose access.
          </p>
          {request.canRename ? (
            <label className="da-gfs-move-confirm-dialog__rename-toggle">
              <input
                checked={allowNumberedRename}
                disabled={busy}
                onChange={event => setAllowNumberedRename(event.target.checked)}
                type="checkbox"
              />
              <span>
                {request.suggestedName
                  ? `Use a numbered name if needed (e.g. “${request.suggestedName}”)`
                  : 'Use a numbered name if needed'}
              </span>
            </label>
          ) : null}
        </div>
        <footer className="da-gfs-move-confirm-dialog__actions">
          <Button disabled={busy} onClick={onCancel} ref={cancelButtonRef} variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={busy}
            onClick={() => onConfirm({ allowNumberedRename })}
            variant="solid"
          >
            {busy ? 'Moving…' : 'Move'}
          </Button>
        </footer>
      </section>
    </div>
  )
}
