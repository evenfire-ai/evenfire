import type { ReactNode } from 'react'

export type ChatMermaidDiagramProps = {
  /** Mermaid code from a fenced `mermaid` block of an agent reply. */
  code: string
  /** The same block rendered as code, shown when the diagram cannot be drawn. */
  codeBlock: ReactNode
}
