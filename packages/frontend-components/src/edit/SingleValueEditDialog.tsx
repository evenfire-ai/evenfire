'use client'

import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { DialogShell } from './DialogShell'
import type { SingleValueEditDialogProps } from './types'

export function SingleValueEditDialog<T>({
  open,
  initialValue,
  onDismiss,
  onSave,
  renderEditor,
  title,
  description,
  isValid = true,
  isEqual = Object.is,
  pending = false,
  error,
  discardLabel = 'Discard',
  saveLabel = 'Save',
  closeButtonLabel,
  size = 'default',
}: SingleValueEditDialogProps<T>) {
  const formId = useId()
  const [value, setValue] = useState(initialValue)
  const previousOpen = useRef(false)
  useEffect(() => {
    if (open && !previousOpen.current) setValue(initialValue)
    if (!open) setValue(initialValue)
    previousOpen.current = open
  }, [initialValue, open])

  const dirty = !isEqual(value, initialValue)
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!pending && dirty && isValid) onSave(value)
  }
  const footer: ReactNode = (
    <>
      <button
        className="eft-dialog__button eft-dialog__button--secondary"
        disabled={pending}
        onClick={() => {
          setValue(initialValue)
          onDismiss('cancel')
        }}
        type="button"
      >
        {discardLabel}
      </button>
      <button
        className="eft-dialog__button eft-dialog__button--primary"
        disabled={pending || !dirty || !isValid}
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
      onDismiss={onDismiss}
      open={open}
      size={size}
      title={title}
    >
      <form className="eft-dialog__form" id={formId} onSubmit={submit}>
        {renderEditor({
          value,
          onChange: next => {
            if (!pending) setValue(next)
          },
          disabled: pending,
        })}
      </form>
    </DialogShell>
  )
}
