import type { TokenBudget } from '@lib/api'
import type { BudgetScopeLookups } from '@lib/budgets'

export type TokenBudgetTableProps = {
  items: TokenBudget[]
  // id → display-name maps so team_id/user_id scopes render as names.
  lookups?: BudgetScopeLookups
  onCreate: () => void
  onEdit: (id: string) => void
  onDelete: (budget: TokenBudget) => Promise<void>
  onToggle: (budget: TokenBudget) => Promise<void>
  onRefresh: () => void
  deletingId: string | null
  togglingId: string | null
  refreshing: boolean
  loading?: boolean
}
