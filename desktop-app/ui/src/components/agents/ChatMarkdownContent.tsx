import { Fragment, useMemo } from 'react'
import { toJsxRuntime } from 'hast-util-to-jsx-runtime'
import { jsx, jsxs } from 'react/jsx-runtime'
import {
  type ChatMessageSemanticModel,
  annotateChatSemanticTree,
} from '../../lib/chatMessageSemantics'

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
  })
}
