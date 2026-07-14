'use client'

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { ConfirmDialogOptions, ConfirmDialogProps, ConfirmDialogRequest } from './types'

function ConfirmDialog({ request, onResolve }: ConfirmDialogProps) {
  const titleId = useId()
  const messageId = useId()
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (!request) return
    const previousActiveElement =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    cancelButtonRef.current?.focus()

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onResolve(false)
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      previousActiveElement?.focus()
    }
  }, [onResolve, request])

  if (!request) return null

  const {
    cancelLabel = 'Cancel',
    confirmLabel = 'OK',
    message,
    title = 'Confirm action',
    tone = 'default',
  } = request.options
  const confirmButtonClass = tone === 'danger' ? 'cu-btn cu-btn--danger' : 'cu-btn cu-btn--primary'

  return (
    <div
      className="cu-modal-backdrop"
      role="presentation"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onResolve(false)
      }}
    >
      <section
        className="cu-modal-panel cu-modal-panel--confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        onMouseDown={event => event.stopPropagation()}
      >
        <div className="cu-modal-panel__head">
          <h3 id={titleId} className="cu-modal-panel__title">
            {title}
          </h3>
        </div>
        <p id={messageId} className="cu-modal-copy">
          {message}
        </p>
        <div className="cu-modal-panel__foot">
          <button
            ref={cancelButtonRef}
            type="button"
            className="cu-btn cu-btn--ghost"
            onClick={() => onResolve(false)}
          >
            {cancelLabel}
          </button>
          <button type="button" className={confirmButtonClass} onClick={() => onResolve(true)}>
            {confirmLabel}
          </button>
        </div>
      </section>
    </div>
  )
}

export function useConfirmDialog() {
  const [request, setRequest] = useState<ConfirmDialogRequest | null>(null)
  const nextIdRef = useRef(0)

  const resolveRequest = useCallback(
    (confirmed: boolean) => {
      setRequest(current => {
        if (current) current.resolve(confirmed)
        return null
      })
    },
    [setRequest]
  )

  const confirm = useCallback((options: ConfirmDialogOptions) => {
    return new Promise<boolean>(resolve => {
      nextIdRef.current += 1
      setRequest({ id: nextIdRef.current, options, resolve })
    })
  }, [])

  return {
    confirm,
    confirmDialog: <ConfirmDialog request={request} onResolve={resolveRequest} />,
  }
}
