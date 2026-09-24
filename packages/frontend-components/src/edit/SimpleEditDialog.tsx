'use client'

import { type FormEvent, type ReactNode, useId } from 'react'
import { DialogShell } from './DialogShell'
import type { SimpleEditDialogProps } from './types'

export function SimpleEditDialog({
  open,
  onCancel,
  onSave,
  title,
  description,
  children,
  isValid = true,
  isDirty = false,
  pending = false,
  error,
  cancelLabel = 'Cancel',
  saveLabel = 'Save',
  closeButtonLabel,
  size = 'default',
}: SimpleEditDialogProps) {
  const formId = useId()
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!pending && isValid && isDirty) onSave()
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
      <button
        className="eft-dialog__button eft-dialog__button--primary"
        disabled={pending || !isValid || !isDirty}
        form={formId}
        type="submit"
      >
        {pending ? 'Saving…' : saveLabel}
      </button>
    </>
  )

  return (
    <DialogShell
      busy={pending}
      closeButtonLabel={closeButtonLabel}
      description={description}
      error={error}
      footer={footer}
      onDismiss={() => onCancel()}
      open={open}
      size={size}
      title={title}
    >
      <form className="eft-dialog__form" id={formId} onSubmit={submit}>
        {children}
      </form>
    </DialogShell>
  )
}
