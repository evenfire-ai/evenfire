import { useState } from 'react'
import { Alert, Button, Form, Input, Space } from 'antd'
import { parseGfsResourceLink } from '@clerum/desktop-app-links'
import type { GfsFilePickerProps } from './filePicker.types'

/**
 * Desktop GFS link entry. Accepts canonical GFS URIs and the supported
 * Evenfire/Profile handoffs, then resolves the canonical URI through the
 * authenticated GFS API. Ant Design owns the visible controls.
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
      <Form.Item label="URL" htmlFor="gfs-url-input">
        <Space.Compact block>
          <Input
            autoFocus
            id="gfs-url-input"
            aria-label="URL"
            placeholder="gfs://… or https://…/open/files?uri=…"
            value={link}
            onChange={event => {
              setLink(event.target.value)
              setInputError(null)
            }}
          />
          <Button type="primary" htmlType="submit" disabled={busy || !valid} loading={busy}>
            Open
          </Button>
        </Space.Compact>
      </Form.Item>
      {error || inputError ? (
        <Alert role="alert" showIcon type="error" title={error || inputError} />
      ) : null}
    </form>
  )
}

export type { GfsFilePickerProps } from './filePicker.types'
