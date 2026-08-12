/**
 * Operator-attention feed (spec Fase 5, Pieza C — `GET /admin/attention`).
 *
 * The Fase 4 catalog-sync cron marks models `stale=true` when they vanish from
 * the external catalog WITHOUT disabling them (`enabled` stays intact → they
 * remain in the runtime allowlist ConfigMap and keep working). That
 * non-destructive default is only safe if the operator is told to act. This
 * module produces that persistent alert: the set of ACTIONABLE attention items.
 *
 * TODAY there is exactly one item kind — a `stale` model that is STILL
 * referenced by some Host/grant, so the operator must decide to disable it
 * (through the Fase 3 impact-gated PUT). A `stale` model that nobody references
 * is NOT actionable and produces NO item.
 *
 * The `kind` discriminator is an OPEN string union on purpose: future phases add
 * item kinds (e.g. a re-appeared model, a pricing gap) without breaking the
 * frontend, which switches on `kind`.
 *
 * REFERENCE LOGIC IS NOT RECONSTRUCTED HERE (regla D4). The "who references
 * (provider, model)" enumeration is `computeModelImpact` (Fase 3,
 * `llmModelImpact.ts`) verbatim — the SAME module the `?force` write-gate uses.
 * This module only enumerates the stale set and calls it once per stale model.
 *
 * FAIL-LOUD (coherent with the Fase 3 safety gate). `computeModelImpact` rejects
 * if any Host LIST fails, and this module does NOT catch: a partial feed that
 * silently drops a referenced-model warning is exactly the under-report the
 * whole phase exists to prevent, so the endpoint answers 500 rather than a
 * truncated list. One un-verifiable model tumbles the whole endpoint.
 *
 * COST. `computeModelImpact` is invoked once per stale model; each call is
 * O(#hostNamespaces) K8s LISTs + one grant query. To keep the K8s cost flat as
 * the stale set grows, the Host LISTs are MEMOIZED per namespace across the loop
 * (`memoizeHostLists`): the apiserver is hit once per namespace for the whole
 * request instead of once per (stale model × namespace). Grant queries stay
 * per-model (O(#stale) Postgres reads) — a batched query would be a new SQL
 * surface, and grants are the cheap side. The memoization preserves fail-loud:
 * a rejected LIST promise is cached and re-thrown on the next await, so the loop
 * still aborts on the first namespace that fails.
 */
import {
  type GrantModelReference,
  type HostModelReference,
  type ModelImpactSources,
  computeModelImpact,
  modelImpactHasReferences,
} from './llmModelImpact.js'

/** The only attention kind today; the union is open for future kinds. */
export const ATTENTION_KIND_STALE_MODEL_REFERENCED = 'stale_model_referenced'

/**
 * A `stale` catalog model that is still referenced by a live Host/grant — the
 * operator must disable it (impact-gated PUT) to converge. Carries the same
 * `hostsAffected`/`grantsAffected` shape the Fase 3 impact body uses, so the
 * frontend renders both surfaces identically.
 */
export interface StaleModelReferencedItem {
  kind: typeof ATTENTION_KIND_STALE_MODEL_REFERENCED
  provider: string
  model: string
  displayName?: string
  hostsAffected: HostModelReference[]
  grantsAffected: GrantModelReference[]
}

/** Extensible union — one member today, more kinds in later phases. */
export type AttentionItem = StaleModelReferencedItem

/** The `GET /admin/attention` response contract consumed by the UI banner. */
export interface AttentionReport {
  items: AttentionItem[]
  /** ISO-8601 instant the feed was computed (for a "as of" label in the UI). */
  generatedAt: string
}

/** Minimal stale-model shape this module needs (subset of `LlmAllowedModel`). */
export interface StaleModelInput {
  provider: string
  model: string
  display_name: string | null
}

/**
 * Wrap `sources` so each namespace's Host LIST runs at most once per request.
 * Caches the PROMISE (not the resolved array) so a rejection is memoized too and
 * still propagates on every await — the fail-loud guarantee is preserved.
 */
function memoizeHostLists(sources: ModelImpactSources): ModelImpactSources {
  const hostListByNamespace = new Map<string, Promise<unknown[]>>()
  return {
    hostNamespaces: sources.hostNamespaces,
    listHostsInNamespace: namespace => {
      let cached = hostListByNamespace.get(namespace)
      if (!cached) {
        cached = sources.listHostsInNamespace(namespace)
        hostListByNamespace.set(namespace, cached)
      }
      return cached
    },
    listGrantsForModel: sources.listGrantsForModel,
  }
}

/**
 * Build the attention feed from the stale set. Enumerates each stale model's
 * live references via `computeModelImpact` (regla D4 — no reconstruction) and
 * emits an item ONLY when there is at least one reference (actionable). Lets any
 * LIST rejection propagate (fail-loud → the route answers 500).
 */
export async function computeAttention(
  staleModels: StaleModelInput[],
  sources: ModelImpactSources
): Promise<AttentionReport> {
  const memoizedSources = memoizeHostLists(sources)
  const items: AttentionItem[] = []
  for (const staleModel of staleModels) {
    const impact = await computeModelImpact(staleModel.provider, staleModel.model, memoizedSources)
    if (!modelImpactHasReferences(impact)) continue
    const item: StaleModelReferencedItem = {
      kind: ATTENTION_KIND_STALE_MODEL_REFERENCED,
      provider: impact.provider,
      model: impact.model,
      hostsAffected: impact.hostsAffected,
      grantsAffected: impact.grantsAffected,
    }
    // display_name is nullable in the catalog; only surface it when present so
    // the UI can fall back to the raw model id without a null check.
    if (staleModel.display_name) item.displayName = staleModel.display_name
    items.push(item)
  }
  return { items, generatedAt: new Date().toISOString() }
}
