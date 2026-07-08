import type { TabBarOption } from '@components/TabBar/types'
import type { CostSegment } from './types'

export const COST_TABS: TabBarOption<CostSegment>[] = [
  { value: 'usage', href: '/cost/usage', label: 'Usage' },
  { value: 'llm-prices', href: '/cost/llm-prices', label: 'LLM Prices' },
  { value: 'token-budgets', href: '/cost/token-budgets', label: 'Token Budgets' },
]
