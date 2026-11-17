import React from 'react'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MarkdownEditorSurface } from '../../../ui/src/components/GfsMarkdownPreview/MarkdownEditorSurface'

function MarkdownEditorHarness({ initialValue }: { initialValue: string }) {
  const [value, setValue] = useState(initialValue)
  return (
    <MarkdownEditorSurface
      binding={null}
      fileName="about-me.md"
      mode="edit"
      owner={undefined}
      onChange={setValue}
      value={value}
    />
  )
}

declare global {
  interface Window {
    mountGfsMarkdownEditor?: (value: string) => void
  }
}

window.mountGfsMarkdownEditor = value => {
  const host = document.querySelector('#markdown-editor-host')
  if (!host) throw new Error('Markdown editor host is missing')
  createRoot(host).render(<MarkdownEditorHarness initialValue={value} />)
}
