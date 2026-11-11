import React from 'react'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { GfsMarkdownEditor } from '../../../ui/src/components/GfsMarkdownPreview/MarkdownAdapter'

function MarkdownEditorHarness({ initialValue }: { initialValue: string }) {
  const [value, setValue] = useState(initialValue)
  return <GfsMarkdownEditor ariaLabel="Markdown source" onChange={setValue} value={value} />
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
