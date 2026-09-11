export type MarkdownEditorProps = {
  ariaLabel: string
  className?: string
  invalid?: boolean
  onChange: (value: string) => void
  placeholder?: string
  value: string
}
