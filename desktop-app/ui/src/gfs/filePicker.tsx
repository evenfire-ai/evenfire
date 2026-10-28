import { useState } from 'react'
import { Alert, Button, Form, Input, Space } from 'antd'
import type { GfsFilePickerProps } from './filePicker.types'

/**
 * P2-S06 / P4-S07 — Desktop gfs:// open bar (renderer). Drives the GFS browser:
 * the user pastes a gfs:// link and the page resolves it THROUGH the API (no
 * local mirror), starting navigation at that resource. A revoked grant surfaces
 * as the API error on open. The component state and submit contract stay here;
 * Ant Design owns the visible controls.
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
      <Form.Item label="EvenDrive link" htmlFor="gfs-uri-input">
        <Space.Compact block>
          <Input
            autoFocus
            id="gfs-uri-input"
            aria-label="EvenDrive link"
            placeholder="gfs://main/<rid>"
            prefix="URI"
            value={uri}
            onChange={event => setUri(event.target.value)}
          />
          <Button type="primary" htmlType="submit" disabled={busy || !valid} loading={busy}>
            Open
          </Button>
        </Space.Compact>
      </Form.Item>
      {error ? <Alert role="alert" showIcon type="error" title={error} /> : null}
    </form>
  )
}

export type { GfsFilePickerProps } from './filePicker.types'
