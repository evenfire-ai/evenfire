import { useCallback, useMemo, useRef, useState } from 'react'
import '@uiw/react-md-editor/markdown-editor.css'
import type { RefMDEditor } from '@uiw/react-md-editor/nohighlight'
import { createRoot } from 'react-dom/client'
import { ChatMarkdownContent } from '@components/agents/ChatMarkdownContent'
import { MarkdownSourceEditor } from '@components/agents/MarkdownSourceEditor'
import { buildComposerMarkdownSemanticModel } from '@lib/chatMessageSemantics'

const INITIAL_DRAFT =
  'before [Project Plan](gfs://main/0123456789abcdef0123456789abcdef)' +
  '[Roadmap](gfs://main/abcdef0123456789abcdef0123456789) after'

function MarkdownSourceEditorHarness() {
  const [draft, setDraft] = useState(INITIAL_DRAFT)
  const [sentSource, setSentSource] = useState('')
  const editorRef = useRef<RefMDEditor | null>(null)
  const model = useMemo(() => buildComposerMarkdownSemanticModel(draft), [draft])

  const editLinkSource = useCallback(
    (range: { start: number; end: number }) => {
      window.requestAnimationFrame(() => {
        const textarea = editorRef.current?.textarea
        if (!textarea || !textarea.isConnected || textarea.value !== draft) return
        textarea.focus()
        textarea.setSelectionRange(range.start, range.end)
      })
    },
    [draft]
  )

  return (
    <main>
      <section aria-label="Markdown preview">
        <ChatMarkdownContent
          model={model}
          query=""
          activeOccurrence={null}
          onEditLink={editLinkSource}
        />
      </section>
      <MarkdownSourceEditor
        editorRef={editorRef}
        height={220}
        value={draft}
        onChange={value => setDraft(value ?? '')}
        textareaProps={{ 'data-testid': 'markdown-source', 'aria-label': 'Markdown source' }}
      />
      <output data-testid="canonical-draft">{draft}</output>
      <button type="button" onClick={() => setSentSource(draft)}>
        Send current draft
      </button>
      <output data-testid="sent-source">{sentSource}</output>
    </main>
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('Markdown editor test root is missing')
createRoot(root).render(<MarkdownSourceEditorHarness />)
