import type React from 'react'
import type { RefMDEditor } from '@uiw/react-md-editor/nohighlight'

export type MarkdownSourceTextareaProps = Omit<
  React.TextareaHTMLAttributes<HTMLTextAreaElement>,
  'onScroll' | 'value'
> & {
  value?: string
  onScroll?: React.UIEventHandler<HTMLDivElement>
  'data-testid'?: string
}

export type MarkdownSourceEditorProps = {
  value: string
  onChange: (value?: string, event?: React.ChangeEvent<HTMLTextAreaElement>) => void
  editorRef?: React.Ref<RefMDEditor>
  height: number
  className?: string
  textareaProps: MarkdownSourceTextareaProps
}
