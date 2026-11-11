import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '../Button'
import { acknowledgePermissionErrors } from '../permissionErrorAcknowledgement'
import type { PermissionErrorDialogProps } from './types'

export function PermissionErrorDialog({
  errors,
  onDismiss,
  title = 'Could not verify permissions',
  suspended = false,
  progress = [],
}: PermissionErrorDialogProps) {
  const titleId = useId()
  const messagesId = useId()
  const closeRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const visible = errors.length > 0 && !suspended
  const seenQueries = new Set<object>()
  const seenIds = new Set<string>()
  const presentedErrors = errors.filter(error => {
    if (error.queryIdentity) {
      if (seenQueries.has(error.queryIdentity)) return false
      seenQueries.add(error.queryIdentity)
    }
    if (seenIds.has(error.id)) return false
    seenIds.add(error.id)
    return true
  })
  const presentedErrorSignature = presentedErrors.map(error => error.id).join('|')
  const latestRef = useRef({ errors, onDismiss, suspended })
  latestRef.current = { errors, onDismiss, suspended }
  useEffect(() => {
    if (!visible) return
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    const surface = dialogRef.current?.closest('.da-gfs-page, .da-gfs-preview-page')
    closeRef.current?.focus()
    return () => {
      if (latestRef.current.suspended) return
      const isVisible = (element: HTMLElement | null): element is HTMLElement =>
        Boolean(
          element?.isConnected &&
          !element.closest('[hidden], [aria-hidden="true"]') &&
          (typeof element.checkVisibility !== 'function' || element.checkVisibility())
        )
      if (isVisible(previouslyFocused) && (!surface || surface.contains(previouslyFocused))) {
        previouslyFocused.focus()
        return
      }
      const fallback = (surface ?? document).querySelector<HTMLElement>(
        '.da-gfs-preview-title-row .da-gfs-resource-menu__trigger, .da-gfs-current-file__title-row .da-gfs-resource-menu__trigger, .da-gfs-drive__title-row .da-gfs-resource-menu__trigger'
      )
      if (isVisible(fallback)) fallback.focus()
    }
  }, [visible])
  useEffect(() => {
    const dialog = dialogRef.current
    if (!visible || !dialog || dialog.contains(document.activeElement)) return
    const retry = dialog.querySelector<HTMLElement>(
      '.da-permission-error-dialog__item button:not([disabled])'
    )
    ;(retry ?? closeRef.current)?.focus()
  }, [presentedErrorSignature, visible])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!latestRef.current.errors.length || latestRef.current.suspended) return
      if (event.key === 'Escape') {
        event.preventDefault()
        acknowledgePermissionErrors(latestRef.current.errors)
        latestRef.current.onDismiss(latestRef.current.errors.map(error => error.id))
      }
      if (event.key === 'Tab') {
        const dialog = dialogRef.current
        if (!dialog) return
        const focusable = dialog.querySelectorAll<HTMLElement>('button:not([disabled])')
        if (focusable.length === 0) return
        const first = focusable.item(0)
        const last = focusable.item(focusable.length - 1)
        if (!dialog.contains(document.activeElement)) {
          event.preventDefault()
          closeRef.current?.focus()
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  if (!visible) return null
  return createPortal(
    <div className="confirm-dialog-backdrop da-permission-error-backdrop">
      <section
        aria-labelledby={titleId}
        aria-describedby={messagesId}
        aria-modal="true"
        className="confirm-dialog da-permission-error-dialog"
        ref={dialogRef}
        role="alertdialog"
      >
        <h2 id={titleId}>{title}</h2>
        <div className="confirm-dialog-body da-permission-error-dialog__messages" id={messagesId}>
          {progress.map(label => (
            <p
              aria-live="polite"
              aria-label={label}
              className="da-permission-error-dialog__progress"
              key={label}
              role="status"
            >
              {label}
            </p>
          ))}
          {presentedErrors.map(error => (
            <div className="da-permission-error-dialog__item" key={error.id}>
              <p>{error.message}</p>
              {error.retry ? (
                <Button
                  onClick={() => {
                    const retry = error.retry?.()
                    const state = (
                      error.queryIdentity as { state?: { fetchStatus?: string } } | undefined
                    )?.state
                    if (state?.fetchStatus === 'fetching') acknowledgePermissionErrors([error])
                    void Promise.resolve(retry).catch(() => undefined)
                  }}
                  size="sm"
                  variant="outline"
                >
                  Retry permission check
                </Button>
              ) : null}
            </div>
          ))}
        </div>
        <div className="confirm-dialog-actions da-permission-error-dialog__actions">
          <Button
            ref={closeRef}
            onClick={() => {
              acknowledgePermissionErrors(errors)
              onDismiss(errors.map(error => error.id))
            }}
            variant="outline"
          >
            Close
          </Button>
        </div>
      </section>
    </div>,
    document.body
  )
}
