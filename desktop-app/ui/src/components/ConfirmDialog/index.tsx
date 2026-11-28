import { useEffect, useId, useRef, useState } from 'react'
import { Button } from '@components/Common'
import type { ConfirmDialogProps } from './types'

export function ConfirmDialog({
  body,
  returnFocusTo,
  fallbackFocusWithin,
  cancelLabel = 'Cancel',
  confirmLabel = 'Confirm',
  onCancel,
  onConfirm,
  title,
  tone = 'primary',
}: ConfirmDialogProps) {
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const focusTargetsRef = useRef({ returnFocusTo, fallbackFocusWithin })
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null)
  const onCancelRef = useRef(onCancel)
  const [pending, setPending] = useState(false)
  const pendingRef = useRef(false)
  onCancelRef.current = onCancel

  const handleConfirm = () => {
    if (pendingRef.current) return
    const result = onConfirm()
    if (!result || typeof result.then !== 'function') return

    pendingRef.current = true
    setPending(true)
    dialogRef.current?.focus()
    void Promise.resolve(result).finally(() => {
      pendingRef.current = false
      setPending(false)
    })
  }

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    cancelButtonRef.current?.focus()
    const keepFocusInside = (event: FocusEvent) => {
      const dialog = dialogRef.current
      if (dialog && !dialog.contains(event.target as Node)) {
        const target = dialog.querySelector<HTMLElement>('button:not(:disabled)') ?? dialog
        target.focus()
      }
    }
    const handleEscape = (event: KeyboardEvent) => {
      const dialog = dialogRef.current
      if (!dialog) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        if (!pendingRef.current) onCancelRef.current()
      }
      if (event.key !== 'Tab') return
      const buttons = Array.from(
        dialog.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
      )
      const first = buttons[0] ?? dialog
      const last = buttons.at(-1) ?? dialog
      if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === dialog)
      ) {
        event.preventDefault()
        last.focus()
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || document.activeElement === dialog)
      ) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', handleEscape)
    document.addEventListener('focusin', keepFocusInside)
    return () => {
      window.removeEventListener('keydown', handleEscape)
      document.removeEventListener('focusin', keepFocusInside)
      const { returnFocusTo: opener, fallbackFocusWithin: region } = focusTargetsRef.current
      const target = opener?.isConnected
        ? opener
        : previous?.isConnected &&
            previous !== document.body &&
            previous !== document.documentElement
          ? previous
          : region?.isConnected
            ? region.querySelector<HTMLElement>('button:not(:disabled), [href], [tabindex="0"]')
            : null
      target?.focus()
    }
  }, [])

  return (
    <div
      className="confirm-dialog-backdrop"
      role="presentation"
      onMouseDown={event => {
        if (event.target === event.currentTarget && !pendingRef.current) onCancelRef.current()
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={pending}
      >
        <h3 id={titleId}>{title}</h3>
        <div className="confirm-dialog-body">{body}</div>
        <div className="confirm-dialog-actions">
          <Button
            ref={cancelButtonRef}
            color="neutral"
            disabled={pending}
            onClick={() => {
              if (!pendingRef.current) onCancelRef.current()
            }}
            size="sm"
            variant="ghost"
          >
            {cancelLabel}
          </Button>
          <Button
            className={`composer-send-button composer-send-button-compact confirm-dialog-confirm confirm-dialog-confirm--${tone}`}
            color={tone === 'danger' ? 'danger' : 'primary'}
            loading={pending}
            onClick={handleConfirm}
            size="sm"
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}
