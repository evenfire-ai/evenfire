import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Button } from '../Button'
import { StatusBanner } from '../StatusBanner'
import { TextInput } from '../TextInput'
import type { SingleValueEditDialogProps } from './types'

const UNSPECIFIED_SAVE_ERROR = 'Could not save. Please try again.'

/**
 * Modal that edits one scalar value of a record the user is reading (a name, a
 * title). The draft lives here until Save: cancel, Escape and the backdrop leave
 * the record untouched, and a rejected save keeps the draft and shows the reason.
 *
 * It renders in place. A caller nested under a transformed or clipped ancestor
 * (a sticky header, a scrolling panel) portals it to `document.body`.
 */
export function SingleValueEditDialog({
  title,
  description,
  label,
  initialValue,
  submitLabel = 'Save',
  cancelLabel = 'Cancel',
  validate,
  onSubmit,
  onClose,
}: SingleValueEditDialogProps) {
  const titleId = useId()
  const descriptionId = useId()
  const inputId = useId()
  const feedbackId = useId()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const onCloseRef = useRef(onClose)
  const pendingRef = useRef(false)
  const [value, setValue] = useState(initialValue)
  const [pending, setPending] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  onCloseRef.current = onClose

  const trimmed = value.trim()
  // An empty draft has nothing to validate: Save simply stays unavailable.
  const validationError = trimmed ? (validate?.(trimmed) ?? null) : null
  const canSave =
    Boolean(trimmed) && trimmed !== initialValue.trim() && !validationError && !pending
  const feedback = saveError ?? validationError

  useEffect(() => {
    const opener = document.activeElement
    inputRef.current?.focus()
    inputRef.current?.select()
    return () => {
      if (opener instanceof HTMLElement) opener.focus()
    }
  }, [])

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !pendingRef.current) onCloseRef.current()
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [])

  const handleSubmit = async () => {
    if (!canSave) return
    pendingRef.current = true
    setPending(true)
    setSaveError(null)
    try {
      await onSubmit(trimmed)
    } catch (error) {
      pendingRef.current = false
      setPending(false)
      // A rejection without a usable message still has to say something.
      setSaveError(error instanceof Error && error.message ? error.message : UNSPECIFIED_SAVE_ERROR)
      return
    }
    pendingRef.current = false
    setPending(false)
    onCloseRef.current()
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLFormElement>) => {
    if (event.key !== 'Tab') return
    const focusable = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        'input:not(:disabled), button:not(:disabled)'
      )
    )
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (!first || !last) return
    const leavingForward = !event.shiftKey && document.activeElement === last
    const leavingBackward = event.shiftKey && document.activeElement === first
    if (leavingForward || leavingBackward) {
      const target = leavingForward ? first : last
      event.preventDefault()
      target.focus()
    }
  }

  return (
    <div
      className="confirm-dialog-backdrop"
      role="presentation"
      onMouseDown={event => {
        if (event.target === event.currentTarget && !pendingRef.current) onCloseRef.current()
      }}
    >
      <form
        aria-busy={pending}
        aria-describedby={description ? descriptionId : undefined}
        aria-labelledby={titleId}
        className="confirm-dialog single-value-edit-dialog"
        onSubmit={event => {
          event.preventDefault()
          void handleSubmit()
        }}
        onKeyDown={handleKeyDown}
        role="dialog"
        aria-modal="true"
      >
        <h3 id={titleId}>{title}</h3>
        {description ? (
          <div className="confirm-dialog-body" id={descriptionId}>
            <p>{description}</p>
          </div>
        ) : null}
        <div className="single-value-edit-dialog-field">
          <label htmlFor={inputId}>{label}</label>
          <TextInput
            aria-describedby={feedback ? feedbackId : undefined}
            autoComplete="off"
            id={inputId}
            onChange={event => setValue(event.currentTarget.value)}
            ref={inputRef}
            spellCheck={false}
            value={value}
          />
        </div>
        {feedback ? (
          <div className="single-value-edit-dialog-feedback" id={feedbackId} role="alert">
            <StatusBanner text={feedback} tone="error" />
          </div>
        ) : null}
        <div className="confirm-dialog-actions">
          <Button disabled={pending} onClick={onClose} size="sm" type="button" variant="ghost">
            {cancelLabel}
          </Button>
          <Button disabled={!canSave} loading={pending} type="submit">
            {submitLabel}
          </Button>
        </div>
      </form>
    </div>
  )
}

export type { SingleValueEditDialogProps } from './types'
