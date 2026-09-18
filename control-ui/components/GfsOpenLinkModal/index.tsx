'use client'

import { useEffect, useId, useState } from 'react'
import { Button, Field, TextInput } from '@components/ui'
import type { GfsOpenLinkModalProps } from './types'

/**
 * Operator dialog for the breadcrumb folder menu's "Open EvenDrive link"
 * action. It mirrors the Desktop Files flow: paste an EvenDrive (gfs://) link
 * and jump directly to that folder. The dialog is presentational — it hands
 * the trimmed URI back to the owning GfsBrowser, which resolves it through
 * control-api and navigates the breadcrumb.
 */
export function GfsOpenLinkModal({
  pending,
  error,
  onOpen,
  onCancel,
}: GfsOpenLinkModalProps): React.JSX.Element {
  const titleId = useId()
  const descriptionId = useId()
  const inputId = useId()
  const [uri, setUri] = useState('')

  useEffect(() => {
    const previousActiveElement =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape' && !pending) onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      previousActiveElement?.focus()
    }
  }, [onCancel, pending])

  const trimmed = uri.trim()
  const canSubmit = trimmed.length > 0 && !pending

  function submit(): void {
    if (!canSubmit) return
    onOpen(trimmed)
  }

  return (
    <div
      className="cu-modal-backdrop"
      role="presentation"
      onMouseDown={event => {
        if (event.target === event.currentTarget && !pending) onCancel()
      }}
    >
      <section
        className="cu-modal-panel cu-modal-panel--narrow"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onMouseDown={event => event.stopPropagation()}
      >
        <div className="cu-modal-panel__head">
          <h3 id={titleId} className="cu-modal-panel__title">
            Open EvenDrive link
          </h3>
        </div>
        <p id={descriptionId} className="cu-modal-copy">
          Paste an EvenDrive link to jump directly to a folder.
        </p>
        <Field label="EvenDrive link" htmlFor={inputId}>
          <TextInput
            id={inputId}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            disabled={pending}
            value={uri}
            placeholder="gfs://main/…"
            onChange={event => setUri(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && canSubmit) {
                event.preventDefault()
                submit()
              }
            }}
          />
        </Field>
        {error ? (
          <p className="cu-field__error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="cu-modal-panel__foot">
          <Button variant="ghost" disabled={pending} onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!canSubmit} onClick={submit}>
            {pending ? 'Opening…' : 'Open'}
          </Button>
        </div>
      </section>
    </div>
  )
}
