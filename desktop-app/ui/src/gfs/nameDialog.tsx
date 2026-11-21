import { useEffect, useId, useRef, useState } from 'react'
import { Button, StatusBanner, TextInput } from '@components/Common'
import type { GfsNameDialogProps } from './nameDialog.types'

/** Modal that edits one GFS resource name (new folder, rename). */
export function GfsNameDialog({
  title,
  description,
  formLabel,
  fieldLabel,
  submitLabel,
  placeholder,
  initialValue = '',
  busy,
  error,
  onSubmit,
  onCancel,
}: GfsNameDialogProps) {
  const titleId = useId()
  const descriptionId = useId()
  const inputId = useId()
  const [value, setValue] = useState(initialValue)
  const onCancelRef = useRef(onCancel)
  onCancelRef.current = onCancel
  const trimmed = value.trim()

  useEffect(() => {
    if (busy) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancelRef.current()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [busy])

  return (
    <div
      className="da-gfs-manage-modal da-gfs-new-folder-modal"
      role="presentation"
      onMouseDown={event => {
        if (event.target === event.currentTarget && !busy) onCancel()
      }}
    >
      <section
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="da-gfs-new-folder-dialog"
        onMouseDown={event => event.stopPropagation()}
        role="dialog"
      >
        <header className="da-gfs-new-folder-dialog__header">
          <h3 id={titleId}>{title}</h3>
        </header>
        <p className="da-gfs-new-folder-dialog__copy" id={descriptionId}>
          {description}
        </p>
        <form
          aria-label={formLabel}
          className="da-gfs-new-folder-dialog__form"
          onSubmit={event => {
            event.preventDefault()
            onSubmit(value)
          }}
        >
          <label className="da-gfs-new-folder-dialog__field" htmlFor={inputId}>
            <span>{fieldLabel}</span>
            <TextInput
              aria-label={fieldLabel}
              autoComplete="off"
              autoFocus
              disabled={busy}
              id={inputId}
              placeholder={placeholder}
              spellCheck={false}
              value={value}
              onChange={event => setValue(event.currentTarget.value)}
            />
          </label>
          {error ? <StatusBanner tone="error" text={error} /> : null}
          <footer className="da-gfs-new-folder-dialog__actions">
            <Button disabled={busy} onClick={onCancel} type="button" variant="ghost">
              Cancel
            </Button>
            <Button disabled={!trimmed || trimmed === initialValue} loading={busy} type="submit">
              {submitLabel}
            </Button>
          </footer>
        </form>
      </section>
    </div>
  )
}
