import { useEffect, useRef } from 'react'
import { Button } from '@components/Common'

export interface GfsMoveConfirmRequest {
  /** Sanitizable display facts of the moving folder. */
  sourceName: string
  destinationName: string
}

export interface GfsMoveConfirmDialogProps {
  request: GfsMoveConfirmRequest
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/**
 * The ONE confirmation for folder moves (rev-2 §1) discloses the inherited-
 * access impact. Dragging does not consent to a numbered rename. Escape/Cancel
 * end the admission before dispatch; once the PATCH is dispatched it cannot
 * be recalled.
 */
export function GfsMoveConfirmDialog({
  request,
  busy = false,
  onConfirm,
  onCancel,
}: GfsMoveConfirmDialogProps) {
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null)
  const dialogRef = useRef<HTMLElement | null>(null)

  /**
   * Focus enters the dialog and returns to the opener when it closes: a
   * keyboard user must never be left on a removed node, and the surface
   * behind a modal dialog must not be reachable while it is open (RP-020).
   */
  useEffect(() => {
    const previousActiveElement =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    cancelButtonRef.current?.focus()
    return () => {
      if (previousActiveElement?.isConnected) previousActiveElement.focus()
    }
  }, [])

  useEffect(() => {
    if (busy) return
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [busy, onCancel])

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
        onKeyDown={handleDialogKeyDown}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
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
        </div>
        <footer className="da-gfs-move-confirm-dialog__actions">
          <Button disabled={busy} onClick={onCancel} ref={cancelButtonRef} variant="ghost">
            Cancel
          </Button>
          <Button disabled={busy} onClick={onConfirm} variant="solid">
            {busy ? 'Moving…' : 'Move'}
          </Button>
        </footer>
      </section>
    </div>
  )
}
