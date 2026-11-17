import { useEffect, useState } from 'react'
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
  owner,
  binding,
  onChange,
}: MarkdownEditorSurfaceProps) {
  const [copyStatus, setCopyStatus] = useState('')
  const [closePending, setClosePending] = useState(false)

  useEffect(() => {
    if (!owner || !binding) {
      setClosePending(false)
      return
    }
    const refresh = () => {
      const record = owner.getVisibleRecord(binding) ?? owner.get(binding)
      setClosePending(Boolean(record?.closeAuthorizationPending || record?.closeReserved))
    }
    refresh()
    return owner.subscribe(refresh)
  }, [binding?.gfsUri, binding?.principalOwner, binding?.scopeKey, binding?.tabId, owner])

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
    <div
      aria-disabled={closePending}
      className="da-gfs-markdown-editor"
      inert={closePending}
    >
      {closePending ? <p role="status">Close authorization pending. Editing is paused.</p> : null}
      <GfsMarkdownEditor
        ariaLabel={`Edit Markdown source for ${fileName}`}
        onChange={next => {
          const record = owner && binding ? owner.get(binding) : null
          if (!closePending && !record?.closeAuthorizationPending && !record?.closeReserved)
            onChange?.(next)
        }}
        value={value}
      />
    </div>
  )
}
