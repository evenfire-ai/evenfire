// Groups the operator-attention feed for the /llm-models catalog banner and
// resolves each item to its allowlist row, so the banner can link the operator
// straight to the model's edit page.
import type {
  AdminAttentionItem,
  AdminCatalogModelAttentionItem,
  AdminStaleModelReferencedItem,
  LlmAllowedModel,
} from './api'

export type GroupedAttentionItems = {
  staleReferenced: AdminStaleModelReferencedItem[]
  deprecated: AdminCatalogModelAttentionItem[]
  staleDiscovery: AdminCatalogModelAttentionItem[]
}

/**
 * A discovered model that vanished from the catalog while a Host/grant still
 * uses it yields both a `stale_model_referenced` and a `stale_discovery_enabled`
 * item. Only the referenced one is kept — it is the stronger warning and already
 * names the same model — so each group counts distinct models.
 */
export function groupAttentionItems(items: AdminAttentionItem[]): GroupedAttentionItems {
  const groups: GroupedAttentionItems = { staleReferenced: [], deprecated: [], staleDiscovery: [] }
  for (const item of items) {
    switch (item.kind) {
      case 'stale_model_referenced':
        groups.staleReferenced.push(item)
        break
      case 'deprecated_model_enabled':
        groups.deprecated.push(item)
        break
      case 'stale_discovery_enabled':
        groups.staleDiscovery.push(item)
        break
    }
  }
  const referencedPairs = new Set(groups.staleReferenced.map(attentionPairKey))
  groups.staleDiscovery = groups.staleDiscovery.filter(
    item => !referencedPairs.has(attentionPairKey(item))
  )
  return groups
}

export function attentionPairKey(item: Pick<AdminAttentionItem, 'provider' | 'model'>): string {
  return `${item.provider}/${item.model}`
}

/** Allowlist row ids keyed by `provider/model`, the pair attention items carry. */
export function buildModelIdsByPair(
  models: Pick<LlmAllowedModel, 'id' | 'provider' | 'model'>[]
): Map<string, string> {
  return new Map(models.map(model => [attentionPairKey(model), model.id]))
}
