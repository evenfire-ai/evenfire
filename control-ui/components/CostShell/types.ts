import type { ReactNode } from 'react'

export type CostSegment = 'usage' | 'llm-prices' | 'token-budgets'

export type CostShellProps = {
  activeSegment: CostSegment
  children: ReactNode
}
