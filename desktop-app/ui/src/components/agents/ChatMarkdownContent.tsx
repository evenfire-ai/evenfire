import { type ComponentPropsWithoutRef, Fragment, useMemo } from 'react'
import { type ExtraProps, toJsxRuntime } from 'hast-util-to-jsx-runtime'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useChatEndFollowerFromContext } from '../../hooks/useNearChatViewport'
import { isDisplayMathCode, isMathCode } from '../../lib/chatMarkdownTransforms'
import { formulasPastBudget } from '../../lib/chatMath'
import {
  type ChatMessageSemanticModel,
  annotateChatSemanticTree,
  containsSearchMark,
  elementText,
  mathSourceOf,
  mermaidSourceOf,
} from '../../lib/chatMessageSemantics'
import { ChatGfsImage } from './ChatGfsImage'
import { ChatImage } from './ChatImage'
import { ChatMath } from './ChatMath'
import { ChatMathPastBudgetContext } from './ChatMath/ChatMathPastBudgetContext'
import { ChatMermaidDiagram } from './ChatMermaidDiagram'

/**
 * A code block, or the diagram or formula it holds. While a search highlights
 * text inside, the code shows so the match is visible.
 */
function MarkdownPre({ node, ...props }: ComponentPropsWithoutRef<'pre'> & ExtraProps) {
  const codeBlock = <pre {...props} />
  if (!node || containsSearchMark(node)) return codeBlock
  const diagram = mermaidSourceOf(node)
  if (diagram !== null) return <ChatMermaidDiagram code={diagram} codeBlock={codeBlock} />
  const formula = mathSourceOf(node)
  if (formula === null) return codeBlock
  const formulaCode = (
    <pre>
      <code className="language-math">{formula}</code>
    </pre>
  )
  return <ChatMath source={formula} display block fallback={formulaCode} />
}

function MarkdownCode({ node, ...props }: ComponentPropsWithoutRef<'code'> & ExtraProps) {
  const code = <code {...props} />
  if (!node || !isMathCode(node) || containsSearchMark(node)) return code
  return (
    <ChatMath
      source={elementText(node).trim()}
      display={isDisplayMathCode(node)}
      block={false}
      fallback={code}
    />
  )
}

function MarkdownImage({ node, src, alt = '' }: ComponentPropsWithoutRef<'img'> & ExtraProps) {
  const follower = useChatEndFollowerFromContext()
  const uri = node?.properties.dataGfsSrc
  if (typeof uri === 'string') return <ChatGfsImage uri={uri} alt={alt} />
  if (typeof src !== 'string') return <>{alt}</>
  return (
    <ChatImage
      className="chat-md-image"
      src={src}
      alt={alt}
      fallback={alt}
      onShow={follower.capture}
      onLoad={follower.grew}
    />
  )
}

const RICH_COMPONENTS = { code: MarkdownCode, img: MarkdownImage, pre: MarkdownPre }

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
  const pastBudget = useMemo(() => formulasPastBudget(model.renderTree), [model])
  const content = toJsxRuntime(tree, {
    Fragment,
    ignoreInvalidStyle: true,
    jsx,
    jsxs,
    passKeys: true,
    // Not conditional on the content: switching mid-stream would remount the code blocks.
    ...(model.representation === 'markdown' ? { components: RICH_COMPONENTS, passNode: true } : {}),
  })
  return (
    <ChatMathPastBudgetContext.Provider value={pastBudget}>
      {content}
    </ChatMathPastBudgetContext.Provider>
  )
}
