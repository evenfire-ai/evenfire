/**
 * Operator-attention feed (`GET /admin/attention`). The catalog sync never
 * disables a model on its own when the catalog drops or deprecates it, so the
 * operator is told — but only about models somebody uses: an item is a decision
 * to make, and a model without consumers has none.
 *
 *   - `stale_model_referenced` — an enabled model the catalog no longer lists,
 *     with an explicit consumer or an all-models Host offering it. An implicit
 *     offer counts here: a Host user can pick it and fail on the next turn.
 *   - `deprecated_model_enabled` — an enabled model the catalog tags
 *     deprecated, with an explicit consumer. The provider still serves it, so a
 *     Host merely offering it is nobody's decision; when it disappears it comes
 *     back as `stale_model_referenced`.
 *
 * `stale_discovery_enabled` is no longer emitted: a stale model with consumers
 * is already `stale_model_referenced`, and one without consumers needs nothing
 * from the operator. Consumers must ignore kinds they do not know, so a kind
 * that stops appearing breaks nobody.
 *
 * ACKNOWLEDGEMENT. Each item carries the row's `episode` for its kind and the
 * keys of its explicit consumers. An operator acknowledgement stores both, and
 * stays in force while the episode is the same and no explicit consumer
 * outside the stored keys has appeared (removing one does not reopen). Items in
 * force are omitted by default and returned with `acknowledged: true` on
 * request. The authority over `enabled` plays no part in the feed.
 *
 * Consumer enumeration is `computeModelConsumers` (composed over the impact
 * gate's `computeModelImpact`), with Host and recipe LISTs memoized for the
 * whole request. FAIL-LOUD: any LIST or query rejection propagates and the
 * route answers 500, never a feed missing a model somebody uses.
 */
import { type AttentionCandidateRow } from './llmAllowedModels.js'
import {
  type ModelConsumerSources,
  type ObjectRef,
  computeModelConsumers,
  explicitConsumerKeys,
  memoizeConsumerSources,
  modelHasConsumers,
} from './llmModelConsumers.js'
import type { GrantModelReference, HostModelRole } from './llmModelImpact.js'

export const ATTENTION_KIND_STALE_MODEL_REFERENCED = 'stale_model_referenced'
export const ATTENTION_KIND_DEPRECATED_MODEL_ENABLED = 'deprecated_model_enabled'

/** `implicit`: an all-models Host offers the model without naming it. */
export type AttentionHostRole = HostModelRole | 'implicit'

export interface AttentionHostReference {
  namespace: string
  name: string
  roles: AttentionHostRole[]
}

export interface ModelAttentionItem {
  kind:
    | typeof ATTENTION_KIND_STALE_MODEL_REFERENCED
    | typeof ATTENTION_KIND_DEPRECATED_MODEL_ENABLED
  provider: string
  model: string
  displayName?: string
  hostsAffected: AttentionHostReference[]
  grantsAffected: GrantModelReference[]
  /** Present only when a WorkflowRecipe names the model. */
  recipesAffected?: ObjectRef[]
  /** The row's episode counter for this kind; sent back verbatim on acknowledge. */
  episode: number
  /** Keys of the explicit consumers; sent back verbatim on acknowledge. */
  consumerKeys: string[]
  /** Present (true) only for an item in force under an acknowledgement. */
  acknowledged?: true
}

/** Extensible union: consumers must ignore kinds they do not know. */
export type AttentionItem = ModelAttentionItem

export interface AttentionReport {
  items: AttentionItem[]
  /** ISO-8601 instant the feed was computed. */
  generatedAt: string
}

export interface ComputeAttentionOptions {
  includeAcknowledged?: boolean
}

/**
 * The stored acknowledgement for `kind` is in force: same episode, and every
 * current explicit consumer was among the keys the operator reviewed. A
 * malformed entry is never in force.
 */
function acknowledgementInForce(
  rawAck: unknown,
  kind: string,
  episode: number,
  currentKeys: string[]
): boolean {
  if (rawAck === null || typeof rawAck !== 'object' || Array.isArray(rawAck)) return false
  const entry = (rawAck as Record<string, unknown>)[kind]
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false
  const { episode: ackedEpisode, consumerKeys } = entry as Record<string, unknown>
  if (ackedEpisode !== episode || !Array.isArray(consumerKeys)) return false
  const reviewed = new Set(consumerKeys.filter((key): key is string => typeof key === 'string'))
  return currentKeys.every(key => reviewed.has(key))
}

export async function computeAttention(
  rows: AttentionCandidateRow[],
  sources: ModelConsumerSources,
  options: ComputeAttentionOptions = {}
): Promise<AttentionReport> {
  const memoized = memoizeConsumerSources(sources)
  const staleItems: AttentionItem[] = []
  const deprecatedItems: AttentionItem[] = []

  for (const row of rows) {
    const consumers = await computeModelConsumers(row.provider, row.model, memoized)
    const consumerKeys = explicitConsumerKeys(consumers)
    const hostsAffected: AttentionHostReference[] = [
      ...consumers.impact.hostsAffected,
      ...consumers.implicitHosts.map(host => ({ ...host, roles: ['implicit' as const] })),
    ]

    const itemFor = (kind: ModelAttentionItem['kind'], episode: number): void => {
      const acknowledged = acknowledgementInForce(row.attention_ack, kind, episode, consumerKeys)
      if (acknowledged && !options.includeAcknowledged) return
      const item: ModelAttentionItem = {
        kind,
        provider: row.provider,
        model: row.model,
        hostsAffected,
        grantsAffected: consumers.impact.grantsAffected,
        episode,
        consumerKeys,
      }
      if (consumers.recipes.length > 0) item.recipesAffected = consumers.recipes
      // display_name is nullable; omitted rather than null so the UI falls back
      // to the model id without a null check.
      if (row.display_name) item.displayName = row.display_name
      if (acknowledged) item.acknowledged = true
      ;(kind === ATTENTION_KIND_STALE_MODEL_REFERENCED ? staleItems : deprecatedItems).push(item)
    }

    if (row.stale && modelHasConsumers(consumers)) {
      itemFor(ATTENTION_KIND_STALE_MODEL_REFERENCED, row.stale_episode)
    }
    if (row.deprecated && consumers.explicit) {
      itemFor(ATTENTION_KIND_DEPRECATED_MODEL_ENABLED, row.deprecated_episode)
    }
  }

  return { items: [...staleItems, ...deprecatedItems], generatedAt: new Date().toISOString() }
}
