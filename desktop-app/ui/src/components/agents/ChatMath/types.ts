import type { ReactNode } from 'react'

export type { ChatMathResult } from '@lib/chatMath'

export type ChatMathProps = {
  source: string
  display: boolean
  /** A `$$` block rather than math inside a paragraph. */
  block: boolean
  fallback: ReactNode
}
