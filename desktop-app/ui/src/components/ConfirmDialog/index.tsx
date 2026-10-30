import { useEffect, useId, useRef, useState } from 'react'
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
    void Promise.resolve(result).finally(() => {
      pendingRef.current = false
      setPending(false)
    })
  }

  useEffect(() => {
    cancelButtonRef.current?.focus()
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !pendingRef.current) onCancelRef.current()
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
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
