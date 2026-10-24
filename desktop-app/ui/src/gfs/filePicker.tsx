import { useState } from 'react'
import { parseGfsResourceLink } from '@clerum/desktop-app-links'
import { Button, Field, StatusBanner, TextInput } from '@components/Common'
import type { GfsFilePickerProps } from './filePicker.types'

/**
 * Desktop GFS link entry. Accepts a canonical gfs:// URI, an evenfire://files
 * handoff, or a Profile /open/files URL, then resolves only its canonical URI
 * through the authenticated GFS API.
 */

export function GfsFilePicker({
  onOpen,
  onOpened,
  busy = false,
  error = null,
}: GfsFilePickerProps) {
  const [link, setLink] = useState('')
  const [inputError, setInputError] = useState<string | null>(null)
  const valid = link.trim().length > 0

  const submit = async () => {
    if (!valid) return
    const target = parseGfsResourceLink(link)
    if (!target) {
      setInputError('Enter a valid EvenDrive link or canonical GFS URI.')
      return
    }
    setInputError(null)
    const opened = await onOpen(target.uri)
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
      <Field label="URL" htmlFor="gfs-url-input">
        <div className="da-gfs-file-picker__row">
          <div className="da-gfs-file-picker__input">
            <span className="da-gfs-file-picker__scheme" aria-hidden="true">
              URL
            </span>
            <TextInput
              autoFocus
              id="gfs-url-input"
              aria-label="URL"
              placeholder="gfs://… or https://…/open/files?uri=…"
              value={link}
              onChange={e => {
                setLink(e.target.value)
                setInputError(null)
              }}
            />
          </div>
          <Button type="submit" disabled={busy || !valid} loading={busy}>
            Open
          </Button>
        </div>
      </Field>
      {error || inputError ? <StatusBanner tone="error" text={error || inputError || ''} /> : null}
    </form>
  )
}

export type { GfsFilePickerProps } from './filePicker.types'
