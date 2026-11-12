import { useState } from 'react'
import { Button } from '@components/Common'
import type { MarkdownDraftBinding, MarkdownDraftOwner } from '@lib/markdownDraftOwner'
import { GfsMarkdownEditor } from './MarkdownAdapter'

type MarkdownEditorSurfaceProps = {
  fileName: string
  value: string
  mode: 'edit' | 'recover'
  owner: MarkdownDraftOwner | undefined
  binding: MarkdownDraftBinding | null
  onChange?: (value: string) => void
}

/** Keeps the exact local Markdown draft available without issuing a GFS read. */
export function MarkdownEditorSurface({
  fileName,
  value,
  mode,
  onChange,
}: MarkdownEditorSurfaceProps) {
  const [copyStatus, setCopyStatus] = useState('')

  if (mode === 'recover') {
    return (
      <section aria-label={`Unsaved Markdown draft for ${fileName}`}>
        <p role="status">
          This local draft is available to inspect and copy. Saving is unavailable.
        </p>
        <Button
          onClick={() => {
            void navigator.clipboard
              .writeText(value)
              .then(() => setCopyStatus('Unsaved Markdown draft copied.'))
              .catch(() => setCopyStatus('Could not copy the unsaved Markdown draft.'))
          }}
          size="sm"
          variant="outline"
        >
          Copy unsaved draft
        </Button>
        {copyStatus ? <p role="status">{copyStatus}</p> : null}
        <pre aria-label="Unsaved Markdown draft content">{value}</pre>
      </section>
    )
  }

  return (
    <GfsMarkdownEditor
      ariaLabel={`Edit Markdown source for ${fileName}`}
      onChange={next => onChange?.(next)}
      value={value}
    />
  )
}
