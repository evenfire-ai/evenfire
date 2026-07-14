import { useEffect, useId, useRef } from 'react'
import { Button } from '@components/Common'
import type { ConfirmDialogProps } from './types'

export function ConfirmDialog({
  body,
  cancelLabel = 'Cancel',
  confirmLabel = 'Confirm',
  onCancel,
  onConfirm,
  title,
  tone = 'primary',
}: ConfirmDialogProps) {
  const titleId = useId()
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    cancelButtonRef.current?.focus()
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [onCancel])

  return (
    <div
      className="confirm-dialog-backdrop"
      role="presentation"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      <div className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h3 id={titleId}>{title}</h3>
        <div className="confirm-dialog-body">{body}</div>
        <div className="confirm-dialog-actions">
          <Button
            ref={cancelButtonRef}
            color="neutral"
            onClick={onCancel}
            size="sm"
            variant="ghost"
          >
            {cancelLabel}
          </Button>
          <Button
            className={`composer-send-button composer-send-button-compact confirm-dialog-confirm confirm-dialog-confirm--${tone}`}
            color={tone === 'danger' ? 'danger' : 'primary'}
            onClick={onConfirm}
            size="sm"
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}
