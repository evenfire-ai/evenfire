import { Fragment, useContext, useMemo } from 'react'
import { toJsxRuntime } from 'hast-util-to-jsx-runtime'
import 'katex/dist/katex.min.css'
import { jsx, jsxs } from 'react/jsx-runtime'
import { formulaKey, renderChatMath } from '@lib/chatMath'
import { ChatMathPastBudgetContext } from './ChatMathPastBudgetContext'
import type { ChatMathProps, ChatMathResult } from './types'

const PAST_BUDGET: ChatMathResult = { ok: false, reason: 'this message draws too many formulas' }

/** Falls back to the LaTeX source, with the reason, when KaTeX cannot render it. */
export function ChatMath({ source, display, block, fallback }: ChatMathProps) {
  const pastBudget = useContext(ChatMathPastBudgetContext).has(formulaKey(source, display))
  const result = useMemo(
    () => (pastBudget ? PAST_BUDGET : renderChatMath(source, display)),
    [display, pastBudget, source]
  )
  if (!result.ok) {
    if (block) {
      return (
        <div>
          <p className="chat-math__note">This formula could not be drawn: {result.reason}.</p>
          {fallback}
        </div>
      )
    }
    return <span title={`Not drawn: ${result.reason}`}>{fallback}</span>
  }
  const drawing = toJsxRuntime(result.tree, { Fragment, ignoreInvalidStyle: true, jsx, jsxs })
  const className = display ? 'chat-math chat-math--display' : 'chat-math'
  return block ? (
    <div className={className}>{drawing}</div>
  ) : (
    <span className={className}>{drawing}</span>
  )
}
