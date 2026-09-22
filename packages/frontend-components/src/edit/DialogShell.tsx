'use client'

import { type KeyboardEvent, type ReactNode, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { classNames } from '../table/utils'
import type { DialogDismissReason, DialogShellProps } from './types'

function getFocusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'a[href], button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
    )
  ).filter(element => {
    if (element.closest('[hidden], [aria-hidden="true"]')) return false
    const style = window.getComputedStyle(element)
    return style.display !== 'none' && style.visibility !== 'hidden'
  })
}

export function DialogShell({
  open,
  onDismiss,
  title,
  description,
  children,
  footer,
  status,
  error,
  size = 'default',
  role = 'dialog',
  closeButtonLabel = 'Close dialog',
  dismissOnEscape = true,
  dismissOnBackdrop = true,
  preventDismissWhileBusy = true,
  busy = false,
  initialFocusRef,
  className,
}: DialogShellProps) {
  const titleId = useId()
  const descriptionId = useId()
  const statusId = useId()
  const errorId = useId()
  const panelRef = useRef<HTMLElement | null>(null)
  const [mounted, setMounted] = useState(false)
  const blocked = busy && preventDismissWhileBusy

  useLayoutEffect(() => {
    setMounted(true)
  }, [])

  useLayoutEffect(() => {
    if (!open || !mounted) return
    const previousActiveElement =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    const panel = panelRef.current
    if (panel) {
      const focusTarget =
        initialFocusRef?.current ??
        getFocusableElements(panel).find(element => !element.hasAttribute('data-dialog-close')) ??
        panel
      focusTarget.focus()
    }
    return () => {
      if (previousActiveElement?.isConnected) previousActiveElement.focus()
    }
  }, [initialFocusRef, mounted, open])

  function dismiss(reason: DialogDismissReason) {
    if (!blocked) onDismiss(reason)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') {
      if (!dismissOnEscape) return
      event.preventDefault()
      event.stopPropagation()
      if (blocked) return
      dismiss('escape')
      return
    }
    if (event.key !== 'Tab' || !panelRef.current) return

    const focusable = getFocusableElements(panelRef.current)
    if (focusable.length === 0) {
      event.preventDefault()
      panelRef.current.focus()
      return
    }
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    const active = document.activeElement
    if (event.shiftKey && (active === first || !panelRef.current.contains(active))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (active === last || !panelRef.current.contains(active))) {
      event.preventDefault()
      first.focus()
    }
  }

  if (!open || !mounted || typeof document === 'undefined') return null

  const describedBy =
    [
      description ? descriptionId : undefined,
      status ? statusId : undefined,
      error ? errorId : undefined,
    ]
      .filter(Boolean)
      .join(' ') || undefined

  return createPortal(
    <div
      className="eft-dialog-backdrop"
      data-testid="dialog-backdrop"
      onKeyDown={handleKeyDown}
      onMouseDown={event => {
        if (event.target === event.currentTarget && dismissOnBackdrop) dismiss('backdrop')
      }}
      role="presentation"
    >
      <section
        aria-busy={busy || undefined}
        aria-describedby={describedBy}
        aria-labelledby={titleId}
        aria-modal="true"
        className={classNames('eft-dialog', `eft-dialog--${size}`, className)}
        ref={panelRef}
        role={role}
        tabIndex={-1}
      >
        <header className="eft-dialog__header">
          <div className="eft-dialog__heading">
            <h3 className="eft-dialog__title" id={titleId}>
              {title}
            </h3>
            {description ? (
              <div className="eft-dialog__description" id={descriptionId}>
                {description}
              </div>
            ) : null}
          </div>
          <button
            aria-label={closeButtonLabel}
            className="eft-dialog__close"
            data-dialog-close="true"
            disabled={blocked}
            onClick={() => dismiss('close-button')}
            type="button"
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>
        {children != null ? <div className="eft-dialog__content">{children}</div> : null}
        {error ? (
          <div className="eft-dialog__error" id={errorId} role="alert">
            {error}
          </div>
        ) : null}
        {status ? (
          <div className="eft-dialog__status" id={statusId} role="status">
            {status}
          </div>
        ) : null}
        {footer ? <footer className="eft-dialog__footer">{footer}</footer> : null}
      </section>
    </div>,
    document.body
  )
}
