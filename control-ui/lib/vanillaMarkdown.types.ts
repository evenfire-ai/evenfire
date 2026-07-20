export type MarkdownInlineNode =
  | { id: string; kind: 'text'; value: string }
  | { id: string; kind: 'code'; value: string }
  | { id: string; kind: 'strong'; children: MarkdownInlineNode[] }
  | { id: string; kind: 'emphasis'; children: MarkdownInlineNode[] }
  | { id: string; kind: 'strikethrough'; children: MarkdownInlineNode[] }
  | { id: string; kind: 'link'; href: string | null; children: MarkdownInlineNode[] }

export type MarkdownBlock =
  | {
      id: string
      kind: 'heading'
      level: 1 | 2 | 3 | 4 | 5 | 6
      children: MarkdownInlineNode[]
    }
  | { id: string; kind: 'paragraph'; children: MarkdownInlineNode[] }
  | { id: string; kind: 'blockquote'; children: MarkdownInlineNode[] }
  | {
      id: string
      kind: 'list'
      ordered: boolean
      items: Array<{ id: string; children: MarkdownInlineNode[] }>
    }
  | {
      id: string
      kind: 'code'
      language: string | null
      value: string
    }
  | { id: string; kind: 'divider' }
