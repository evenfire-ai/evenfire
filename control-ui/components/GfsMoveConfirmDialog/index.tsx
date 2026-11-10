'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from '@components/ui'

export interface GfsMoveConfirmRequest {
  sourceName: string
  /** Accurate impact copy and accessible naming per source kind. */
  sourceKind: 'file' | 'directory'
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
 * The ONE confirmation for drag moves (rev-2 §1): explains the
 * inherited-access impact and records the conflict naming policy in the same
 * dialog, so no second automatic prompt follows the drop. Cancel ends the
 * admission before dispatch; once the PATCH is dispatched it cannot be
 * recalled. Files dropped onto breadcrumbs stop here too (source-kind-aware
 * copy); the Move dialog is its own explicit confirmation surface.
 */
export function GfsMoveConfirmDialog({
  request,
  busy = false,
  onConfirm,
  onCancel,
}: GfsMoveConfirmDialogProps): React.JSX.Element {
  const [allowNumberedRename, setAllowNumberedRename] = useState(false)
  const dialogRef = useRef<HTMLElement | null>(null)
  const sourceLabel = request.sourceKind === 'file' ? 'file' : 'folder'
  // The element that had focus before the dialog opened. It is captured during
  // the FIRST render — before the dialog moves focus into itself — so the
  // restore can hand the keyboard back where it came from (RP-020).
  const openerRef = useRef<HTMLElement | null>(null)
  if (openerRef.current === null && typeof document !== 'undefined') {
    openerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
  }

  /**
   * Focus returns to the opener when the dialog closes: a keyboard user must
   * never be left on a removed node, and the surface behind a modal dialog
   * must not be reachable while it is open (RP-020).
   */
  useEffect(() => {
    return () => {
      const opener = openerRef.current
      if (opener?.isConnected) opener.focus()
    }
  }, [])

  /**
   * Tab stays inside the dialog. The panel is a modal surface: without the
   * wrap, a keyboard user tabs straight out of the confirmation and into the
   * page behind it, which the modal has just taken over (RP-020).
   */
  function handleDialogKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    if (event.key !== 'Tab') return
    const panel = dialogRef.current
    if (!panel) return
    const focusable = Array.from(
      panel.querySelectorAll<HTMLElement>(
        'a[href], button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
      )
    ).filter(element => !element.closest('[hidden], [aria-hidden="true"]'))
    if (focusable.length === 0) {
      event.preventDefault()
      panel.focus()
      return
    }
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (!first || !last) {
      event.preventDefault()
      panel.focus()
      return
    }
    const active = document.activeElement
    if (event.shiftKey && (active === first || !panel.contains(active))) {
      event.preventDefault()
      last.focus()
      return
    }
    if (!event.shiftKey && (active === last || !panel.contains(active))) {
      event.preventDefault()
      first.focus()
    }
  }

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
        aria-label={`Move ${sourceLabel} ${request.sourceName} to ${request.destinationName}`}
        aria-modal="true"
        className="cu-modal-panel cu-gfs-move-confirm"
        onKeyDown={handleDialogKeyDown}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="cu-gfs-move-confirm__header">
          <h3>
            Move “{request.sourceName}” to “{request.destinationName}”?
          </h3>
        </header>
        <div className="cu-gfs-move-confirm__body">
          {request.sourceKind === 'file' ? (
            <p className="cu-gfs-move-confirm__impact">
              Inherited access to this file follows the new location. Direct sharing entries stay
              with it — including any access they grant.
            </p>
          ) : (
            <p className="cu-gfs-move-confirm__impact">
              Inherited access to this folder and its contents follows the new location. Direct
              sharing entries stay with their items — including any access they grant — and grantees
              may lose access.
            </p>
          )}
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
