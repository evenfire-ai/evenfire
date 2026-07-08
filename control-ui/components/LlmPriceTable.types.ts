import type { ReactNode } from 'react'
import type { LlmModelPrice } from '@lib/api'

export type LlmPriceTableProps = {
  items: LlmModelPrice[]
  // Optional slot rendered inside the card, directly under the panel header
  // (e.g. the unpriced-models notice) so it never pushes the page layout.
  banner?: ReactNode
  onCreate: () => void
  onEdit: (id: string) => void
  onDelete: (price: LlmModelPrice) => Promise<void>
  onRefresh: () => void
  deletingId: string | null
  refreshing: boolean
  loading?: boolean
}
