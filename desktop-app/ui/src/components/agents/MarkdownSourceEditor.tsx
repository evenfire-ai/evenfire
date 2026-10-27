import MDEditor from '@uiw/react-md-editor/nohighlight'
import type { MarkdownSourceEditorProps } from './MarkdownSourceEditor.types'

/** Desktop's source-only Markdown editor adapter. */
export function MarkdownSourceEditor({
  value,
  onChange,
  editorRef,
  height,
  className,
  textareaProps,
}: MarkdownSourceEditorProps) {
  return (
    <MDEditor
      ref={editorRef}
      value={value}
      onChange={onChange}
      className={className}
      preview="edit"
      hideToolbar
      visibleDragbar={false}
      highlightEnable={false}
      defaultTabEnable
      commands={[]}
      extraCommands={[]}
      height={height}
      textareaProps={textareaProps}
    />
  )
}
