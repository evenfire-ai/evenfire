import type { ReactNode } from 'react'
import type { DiagramDrawResult } from '../../../../../src/types'

export type ChatMermaidDiagramProps = {
  /** Mermaid code from a fenced `mermaid` block of an agent reply. */
  code: string
  /** The same block rendered as code, shown when the diagram cannot be drawn. */
  codeBlock: ReactNode
}

/** What a diagram block shows, and whether the chat was following its end when it arrived. */
export type ChatMermaidDiagramShown = Readonly<{
  code: string
  result: DiagramDrawResult
  followChatEnd: boolean
}>
