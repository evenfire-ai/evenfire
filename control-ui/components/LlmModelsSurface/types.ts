import type { ReactNode } from 'react'
import type { TableHeaderColumn } from '@components/TableHeaderRow/types'
import type {
  AdminAckableAttentionItem,
  AdminAttentionItem,
  AdminModelAttentionItem,
  LlmAllowedModel,
} from '@lib/api'
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
  /** Items still to review, grouped by kind. */
  groups: GroupedAttentionItems
  /** Items an acknowledgement covers; listed apart and never counted. */
  reviewed: AdminModelAttentionItem[]
  modelIdsByPair: Map<string, string>
  /** `attentionItemKey`s of the items with an action in flight. */
  busyKeys: ReadonlySet<string>
  /** The last action failure per `attentionItemKey`. */
  itemErrors: ReadonlyMap<string, string>
  onKeepEnabled: (item: AdminAckableAttentionItem) => void
  onMarkReviewed: (item: AdminAckableAttentionItem) => void
  onUndoReviewed: (item: AdminModelAttentionItem) => void
}

export type AttentionItemActionsProps = {
  item: AdminAttentionItem
  modelIdsByPair: Map<string, string>
  busy: boolean
  error: string | undefined
  onKeepEnabled: (item: AdminAckableAttentionItem) => void
  onMarkReviewed: (item: AdminAckableAttentionItem) => void
}

export type AttentionUsedByCellProps = {
  item: AdminModelAttentionItem
}

export type ReviewedAttentionSectionProps = {
  items: AdminModelAttentionItem[]
  busyKeys: ReadonlySet<string>
  itemErrors: ReadonlyMap<string, string>
  onUndoReviewed: (item: AdminModelAttentionItem) => void
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
