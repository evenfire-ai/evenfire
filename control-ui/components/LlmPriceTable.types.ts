import type { LlmModelPrice, UnpricedModel } from '@lib/api'

export type LlmPriceTableProps = {
  items: LlmModelPrice[]
  unpricedItems: UnpricedModel[]
  onCreate: () => void
  onAddMissingPrice: (model: UnpricedModel) => void
  onEdit: (id: string) => void
  onDelete: (price: LlmModelPrice) => Promise<void>
  onRefresh: () => void
  deletingId: string | null
  refreshing: boolean
  loading?: boolean
}
