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
}
