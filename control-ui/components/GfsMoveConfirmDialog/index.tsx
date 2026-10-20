'use client'

import { useEffect, useState } from 'react'
import { Button } from '@components/ui'

export interface GfsMoveConfirmRequest {
  sourceName: string
  destinationName: string
  /** Suggested numbered-name candidate, when destination names are known. */
  suggestedName?: string
  /** Numbered renaming is allowed (operator plane: intrinsic write). */
  canRename: boolean
}

export interface GfsMoveConfirmDialogProps {
  request: GfsMoveConfirmRequest
  busy?: boolean
  onConfirm: (options: { allowNumberedRename: boolean }) => void
  onCancel: () => void
}

/**
 * The ONE confirmation for folder drag moves (rev-2 §1): explains the
 * inherited-access impact and records the conflict naming policy in the same
 * dialog, so no second automatic prompt follows the drop. Cancel ends the
 * admission before dispatch; once the PATCH is dispatched it cannot be
 * recalled. Files move without confirmation; the Move dialog is its own
 * explicit confirmation surface.
 */
export function GfsMoveConfirmDialog({
  request,
  busy = false,
  onConfirm,
  onCancel,
}: GfsMoveConfirmDialogProps): React.JSX.Element {
  const [allowNumberedRename, setAllowNumberedRename] = useState(false)

  useEffect(() => {
    if (busy) return
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [busy, onCancel])

  return (
    <div
      className="cu-modal-backdrop"
      role="presentation"
      onMouseDown={event => {
        if (!busy && event.target === event.currentTarget) onCancel()
      }}
    >
      <section
        aria-label={`Move folder ${request.sourceName} to ${request.destinationName}`}
        aria-modal="true"
        className="cu-modal-panel cu-gfs-move-confirm"
        role="dialog"
      >
        <header className="cu-gfs-move-confirm__header">
          <h3>
            Move “{request.sourceName}” to “{request.destinationName}”?
          </h3>
        </header>
        <div className="cu-gfs-move-confirm__body">
          <p className="cu-gfs-move-confirm__impact">
            Inherited access to this folder and its contents follows the new location. Direct
            sharing entries stay with their items — including any access they grant — and grantees
            may lose access.
          </p>
          {request.canRename ? (
            <label className="cu-gfs-move-confirm__rename-toggle">
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
        <footer className="cu-gfs-move-confirm__actions">
          <Button autoFocus disabled={busy} onClick={onCancel} variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={busy}
            onClick={() => onConfirm({ allowNumberedRename })}
            variant="primary"
          >
            {busy ? 'Moving…' : 'Move'}
          </Button>
        </footer>
      </section>
    </div>
  )
}
