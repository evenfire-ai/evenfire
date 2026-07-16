'use client'

import { useEffect, useId, useState } from 'react'
import { Button, Field, TextInput } from '@components/ui'
import { GFS_RESOURCE_NAME_MAX_LENGTH } from '@lib/gfsResourceName'
import type { NewFolderModalProps } from './types'

/**
 * Operator dialog for creating a folder in the Global File System. It replaces
 * the previous native window.prompt flow with an accessible, token-styled
 * modal. The dialog is presentational: it validates a non-empty name and
 * hands the trimmed raw value back to the owning GfsBrowser, which runs the
 * normalization + GFS proxy write — keeping the mutation co-located with the
 * other operator actions (upload, rename, delete).
 */
export function NewFolderModal({
  folderLabel,
  pending,
  error,
  onCreate,
  onCancel,
}: NewFolderModalProps): React.JSX.Element {
  const titleId = useId()
  const descriptionId = useId()
  const inputId = useId()
  const [name, setName] = useState('')

  useEffect(() => {
    const previousActiveElement =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !pending) onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      previousActiveElement?.focus()
    }
  }, [onCancel, pending])

  const trimmed = name.trim()
  const canSubmit = trimmed.length > 0 && !pending

  function submit(): void {
    if (!canSubmit) return
    onCreate(trimmed)
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
            New folder
          </h3>
        </div>
        <p id={descriptionId} className="cu-modal-copy">
          Create a new folder in {folderLabel}.
        </p>
        <Field
          label="Folder name"
          htmlFor={inputId}
          description={`Names longer than ${GFS_RESOURCE_NAME_MAX_LENGTH} characters are shortened automatically.`}
        >
          <TextInput
            id={inputId}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            disabled={pending}
            value={name}
            placeholder="e.g. research-notes"
            onChange={event => setName(event.target.value)}
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
            {pending ? 'Creating…' : 'Create folder'}
          </Button>
        </div>
      </section>
    </div>
  )
}
