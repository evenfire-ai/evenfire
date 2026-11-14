import type { ReactNode } from 'react'
import type { AdminAttentionItem, AdminCatalogModelAttentionItem, LlmAllowedModel } from '@lib/api'

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

export type CatalogModelAttentionGroupProps = {
  items: AdminCatalogModelAttentionItem[]
  /** The group's explanation, given the item count. */
  lede: (count: number) => ReactNode
  modelIdsByPair: Map<string, string>
}

export type AttentionReviewLinkProps = {
  item: AdminAttentionItem
  modelIdsByPair: Map<string, string>
}
