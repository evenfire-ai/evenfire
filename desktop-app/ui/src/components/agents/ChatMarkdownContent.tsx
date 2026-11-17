import { type ComponentPropsWithoutRef, Fragment, useMemo } from 'react'
import { type ExtraProps, toJsxRuntime } from 'hast-util-to-jsx-runtime'
import { jsx, jsxs } from 'react/jsx-runtime'
import {
  type ChatMessageSemanticModel,
  annotateChatSemanticTree,
  containsSearchMark,
  mermaidSourceOf,
} from '../../lib/chatMessageSemantics'
import { ChatMermaidDiagram } from './ChatMermaidDiagram'

/**
 * A code block, or the diagram of a `mermaid` one. While a search highlights
 * text inside the diagram's code, the code shows so the match is visible.
 */
function MarkdownPre({ node, ...props }: ComponentPropsWithoutRef<'pre'> & ExtraProps) {
  const codeBlock = <pre {...props} />
  const source = node && !containsSearchMark(node) ? mermaidSourceOf(node) : null
  return source === null ? codeBlock : <ChatMermaidDiagram code={source} codeBlock={codeBlock} />
}

const DIAGRAM_COMPONENTS = { pre: MarkdownPre }

export function ChatMarkdownContent({
  model,
  query,
  activeOccurrence,
}: {
  model: ChatMessageSemanticModel
  query: string
  activeOccurrence: number | null
}) {
  const tree = useMemo(
    () => annotateChatSemanticTree(model, query, activeOccurrence),
    [activeOccurrence, model, query]
  )
  return toJsxRuntime(tree, {
    Fragment,
    ignoreInvalidStyle: true,
    jsx,
    jsxs,
    passKeys: true,
    ...(model.hasMermaidDiagram ? { components: DIAGRAM_COMPONENTS, passNode: true } : {}),
  })
}
