// Groups the operator-attention feed for the /llm-models catalog banner and
// resolves each item to its allowlist row, so the banner can link the operator
// straight to the model's edit page.
import type {
  AdminAckableAttentionItem,
  AdminAttentionItem,
  AdminModelAttentionItem,
  AdminStaleDiscoveryAttentionItem,
  LlmAllowedModel,
} from './api'

export type GroupedAttentionItems = {
  staleReferenced: AdminModelAttentionItem[]
  deprecated: AdminModelAttentionItem[]
  staleDiscovery: AdminStaleDiscoveryAttentionItem[]
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

/** Identity of one attention item: a model can carry one item per kind. */
export function attentionItemKey(
  item: Pick<AdminAttentionItem, 'kind' | 'provider' | 'model'>
): string {
  return `${item.kind}/${item.provider}/${item.model}`
}

/**
 * Splits a feed read with `includeAcknowledged` into what still needs review
 * and what an acknowledgement covers. Only `pending` feeds the banner.
 */
export function splitAcknowledged(items: AdminAttentionItem[]): {
  pending: AdminAttentionItem[]
  reviewed: AdminModelAttentionItem[]
} {
  const pending: AdminAttentionItem[] = []
  const reviewed: AdminModelAttentionItem[] = []
  for (const item of items) {
    if (item.kind !== 'stale_discovery_enabled' && item.acknowledged) reviewed.push(item)
    else pending.push(item)
  }
  return { pending, reviewed }
}

/** Whether the server can acknowledge the item: an ackable kind with an episode. */
export function isAckableAttentionItem(
  item: AdminAttentionItem
): item is AdminAckableAttentionItem {
  return item.kind !== 'stale_discovery_enabled' && item.episode !== null
}

/** Readable Host roles; `implicit` is an all-models Host that never names the model. */
export function formatHostRoles(roles: string[]): string {
  return roles.map(role => (role === 'implicit' ? 'allows all models' : role)).join(', ')
}
