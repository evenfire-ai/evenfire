'use client'

import type { ReactNode } from 'react'
import { DialogShell } from './DialogShell'
import type { ConfirmationDialogProps, DialogDismissReason } from './types'

export function ConfirmationDialog({
  open,
  onCancel,
  onConfirm,
  title,
  description,
  children,
  tone = 'info',
  icon,
  cancelLabel = 'Cancel',
  confirmLabel = 'Confirm',
  secondaryAction,
  confirmDisabled = false,
  pending = false,
  error,
  size = 'default',
}: ConfirmationDialogProps) {
  function handleDismiss(_reason: DialogDismissReason) {
    onCancel()
  }

  const footer: ReactNode = (
    <>
      <button
        className="eft-dialog__button eft-dialog__button--secondary"
        disabled={pending}
        onClick={onCancel}
        type="button"
      >
        {cancelLabel}
      </button>
      {secondaryAction ? (
        <button
          className="eft-dialog__button eft-dialog__button--secondary"
          disabled={pending || secondaryAction.disabled}
          onClick={secondaryAction.onSelect}
          type="button"
        >
          {secondaryAction.label}
        </button>
      ) : null}
      <button
        className={`eft-dialog__button eft-dialog__button--primary eft-dialog__button--${tone}`}
        disabled={pending || confirmDisabled}
        onClick={onConfirm}
        type="button"
      >
        {pending ? 'Working…' : confirmLabel}
      </button>
    </>
  )

  return (
    <DialogShell
      busy={pending}
      description={description}
      error={error}
      footer={footer}
      onDismiss={handleDismiss}
      open={open}
      role="alertdialog"
      size={size}
      title={
        <span className="eft-dialog-confirmation__title" data-tone={tone}>
          {icon != null ? (
            <span aria-hidden="true" className="eft-dialog-confirmation__icon">
              {icon}
            </span>
          ) : null}
          {title}
        </span>
      }
    >
      {children}
    </DialogShell>
  )
}
