import type { ReactNode } from 'react'
import type { TableHeaderColumn } from '@components/TableHeaderRow/types'
import type { AdminAttentionItem, LlmAllowedModel } from '@lib/api'
import type { GroupedAttentionItems } from '@lib/llmModelAttention'

export type LlmModelsTab = 'catalog' | 'discovery'

export type LlmModelsSurfaceProps = {
  activeTab: LlmModelsTab
}

export type CatalogAttentionBannerProps = {
  /**
   * Bumped by the surface after each successful mutation (disable/force-delete)
   * so the advisory banner re-fetches the attention feed on demand and stops
   * showing an item the operator just resolved. Not a poll — a change of this
   * value is the only extra fetch trigger beyond mount.
   */
  refreshSignal?: number
  /**
   * The loaded allowlist rows, used only to link each item to its model's edit
   * page. An item whose row is not (yet) loaded renders without the link.
   */
  models?: LlmAllowedModel[]
}

export type CatalogAttentionDialogProps = {
  open: boolean
  onDismiss: () => void
  groups: GroupedAttentionItems
  modelIdsByPair: Map<string, string>
}

export type AttentionReviewLinkProps = {
  item: AdminAttentionItem
  modelIdsByPair: Map<string, string>
}

export type AttentionSectionProps = {
  lede: ReactNode
  columns: TableHeaderColumn[]
  children: ReactNode
}

export type AttentionProviderCellProps = {
  provider: string
}

export type AttentionModelCellProps = {
  item: AdminAttentionItem
}
