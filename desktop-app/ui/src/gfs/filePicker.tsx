import { useState } from 'react'
import { Button, Field, StatusBanner, TextInput } from '@components/Common'
import type { GfsFilePickerProps } from './filePicker.types'

/**
 * P2-S06 / P4-S07 — Desktop gfs:// open bar (renderer). Drives the GFS browser:
 * the user pastes a gfs:// link and the page resolves it THROUGH the API (no
 * local mirror), starting navigation at that resource. A revoked grant surfaces
 * as the API error on open. Composes the shared Common primitives per the
 * desktop-app/ui frontend rules.
 */

export function GfsFilePicker({
  onOpen,
  onOpened,
  busy = false,
  error = null,
}: GfsFilePickerProps) {
  const [uri, setUri] = useState('')
  const valid = uri.trim().length > 0

  const submit = async () => {
    if (!valid) return
    const opened = await onOpen(uri.trim())
    if (opened !== false) onOpened?.()
  }

  return (
    <form
      className="da-gfs-file-picker"
      onSubmit={event => {
        event.preventDefault()
        void submit()
      }}
    >
      <Field label="GFS URI" htmlFor="gfs-uri-input">
        <div className="da-gfs-file-picker__row">
          <div className="da-gfs-file-picker__input">
            <span className="da-gfs-file-picker__scheme" aria-hidden="true">
              URI
            </span>
            <TextInput
              autoFocus
              id="gfs-uri-input"
              aria-label="gfs URI"
              placeholder="gfs://main/<rid>"
              value={uri}
              onChange={e => setUri(e.target.value)}
            />
          </div>
          <Button type="submit" disabled={busy || !valid} loading={busy}>
            Open
          </Button>
        </div>
      </Field>
      {error ? <StatusBanner tone="error" text={error} /> : null}
    </form>
  )
}

export type { GfsFilePickerProps } from './filePicker.types'
