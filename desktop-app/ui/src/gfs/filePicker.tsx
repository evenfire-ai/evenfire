import { useState } from 'react'
import { Button, Field, StatusBanner, TextInput } from '@components/Common'

/**
 * P2-S06 / P4-S07 — Desktop gfs:// open bar (renderer). Drives the GFS browser:
 * the user pastes a gfs:// link and the page resolves it THROUGH the API (no
 * local mirror), starting navigation at that resource. A revoked grant surfaces
 * as the API error on open. Composes the shared Common primitives per the
 * desktop-app/ui frontend rules.
 */

export interface GfsFilePickerProps {
  /** Resolve the gfs:// URI and start browsing at that resource. */
  onOpen: (uri: string) => void | Promise<void>
  /** True while the resolve round-trip is in flight. */
  busy?: boolean
  /** Resolve error from the controller (e.g. denied / not a gfs URI). */
  error?: string | null
}

export function GfsFilePicker({ onOpen, busy = false, error = null }: GfsFilePickerProps) {
  const [uri, setUri] = useState('')
  const valid = uri.trim().length > 0

  const submit = () => {
    if (valid) void onOpen(uri.trim())
  }

  return (
    <div className="da-gfs-file-picker">
      <Field label="Open a gfs:// link" htmlFor="gfs-uri-input">
        <div className="da-gfs-file-picker__row">
          <div className="da-gfs-file-picker__input">
            <span className="da-gfs-file-picker__scheme" aria-hidden="true">
              URI
            </span>
            <TextInput
              id="gfs-uri-input"
              aria-label="gfs URI"
              placeholder="gfs://main/<rid>"
              value={uri}
              onChange={e => setUri(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') submit()
              }}
            />
          </div>
          <Button type="button" onClick={submit} disabled={busy || !valid} loading={busy}>
            Open
          </Button>
        </div>
      </Field>
      {error ? <StatusBanner tone="error" text={error} /> : null}
    </div>
  )
}
