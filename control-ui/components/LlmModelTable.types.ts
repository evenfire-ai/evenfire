import type { LlmAllowedModel } from '@lib/api'

export type LlmModelTableProps = {
  items: LlmAllowedModel[]
  // Set of allowed models that have no enabled price, keyed both as
  // `provider/model` and bare `model` (the unpriced feed may omit the
  // provider). Rows in this set render a "No price" chip.
  unpricedKeys: Set<string>
  onCreate: () => void
  onEdit: (id: string) => void
  onDelete: (model: LlmAllowedModel) => Promise<void>
  onRefresh: () => void
  deletingId: string | null
  refreshing: boolean
  loading?: boolean
}
