/**
 * R2 — pure model-resolution helpers over the operator allowlist.
 *
 * These are the single source of truth for "which model does this session get"
 * and "which models can the user pick", shared by the per-task resolver
 * (`main.ts`), the `GET /v1/runtime/models` projection and the
 * `POST /v1/runtime/model` write gate. Kept pure (no ConfigStore/K8s imports)
 * so they unit-test against a stub {@link AllowlistView}.
 *
 * Degraded-explicit semantics (spec §3-R3.5): when the allowlist ConfigMap is
 * not yet delivered (`allowlistAvailable() === false`), only the Host-configured
 * default model is permitted — never fail-open, never brick an existing Host.
 */
import type { HostAllowedModel } from '../types'
import type { AllowlistView } from './allowlistCheck'
import type { AllowedModelEntry } from './configStore'

/** Join key for a (provider, model) pair. NUL can never occur in either half,
 *  so it is a collision-free separator. */
function pairKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`
}

/**
 * T3a — narrow a GLOBAL {@link AllowlistView} to a Host's per-host subset.
 *
 * `spec.allowedModels` lists the (provider, model) pairs THIS host offers; it is
 * meant to be a subset of the operator's global allowlist. The returned view
 * exposes, for each provider, only the global entries whose (provider, model)
 * also appears in the subset — a LIVE intersection, so a model later dropped
 * from the global disappears here too (fail-closed). Metadata (displayName /
 * contextWindow) is still sourced from the global entry.
 *
 * Back-compat: an absent, empty, or all-malformed subset returns the global
 * view unchanged (the host offers the full global allowlist). `allowlistAvailable()`
 * is delegated verbatim, so the degraded-explicit path (only the Host default,
 * allowlist unknown) is preserved untouched.
 */
export function hostSubsetAllowlistView(
  view: AllowlistView,
  allowedModels: HostAllowedModel[] | undefined
): AllowlistView {
  if (!allowedModels || allowedModels.length === 0) return view
  const subset = new Set<string>()
  for (const e of allowedModels) {
    if (e && e.provider && e.model) subset.add(pairKey(e.provider, e.model))
  }
  // An all-malformed subset collapses to "no subset" → full global. This is the
  // SAME back-compat semantics as an absent/empty array (not a fail-open on a
  // curation control): the CRD schema requires non-empty provider+model, so a
  // real subset never reaches here empty.
  if (subset.size === 0) return view
  return {
    allowlistAvailable: () => view.allowlistAvailable(),
    allowedModels: () => {
      const filtered = new Map<string, AllowedModelEntry[]>()
      for (const [provider, entries] of view.allowedModels()) {
        const kept = entries.filter(e => subset.has(pairKey(provider, e.model)))
        if (kept.length > 0) filtered.set(provider, kept)
      }
      return filtered
    },
  }
}

/** One selectable model as projected to the desktop selector. */
export interface ModelWireEntry {
  name: string
  displayName?: string
  contextWindowTokens?: number
}

export interface SessionModelResolution {
  /** Effective model: the saved selection if still allowed, else the default. */
  model: string
  /** Set only when the saved selection is no longer allowed and we fell back. */
  blocked?: string
}

/**
 * Fail-closed allow-check. In degraded mode (allowlist unavailable) only the
 * Host default is permitted; otherwise the model must appear in the provider's
 * enabled allowlist entries.
 */
export function isModelAllowed(
  view: AllowlistView,
  provider: string,
  model: string,
  hostDefault: string
): boolean {
  if (!view.allowlistAvailable()) return model === hostDefault
  const entries = view.allowedModels().get(provider) ?? []
  return entries.some(e => e.model === model)
}

/**
 * Resolve the effective model for a session from its saved `{ provider → model }`
 * map. Returns `blocked` (the stale saved model) when the saved selection is no
 * longer allowed so the GET projection can surface `sessionModelBlocked`.
 */
export function resolveSessionModel(
  view: AllowlistView,
  provider: string,
  hostDefault: string,
  selections: Record<string, string> | undefined
): SessionModelResolution {
  const saved = selections?.[provider]
  if (!saved || saved === hostDefault) return { model: saved ?? hostDefault }
  if (isModelAllowed(view, provider, saved, hostDefault)) return { model: saved }
  return { model: hostDefault, blocked: saved }
}

/**
 * Project the selectable models for a provider. Degraded → only the Host
 * default (the allowlist — and thus context windows — is unknown).
 */
export function projectModels(
  view: AllowlistView,
  provider: string,
  hostDefault: string
): { degraded: boolean; models: ModelWireEntry[] } {
  if (!view.allowlistAvailable()) {
    return { degraded: true, models: [{ name: hostDefault }] }
  }
  const entries = view.allowedModels().get(provider) ?? []
  return { degraded: false, models: entries.map(entryToWire) }
}

/**
 * Context-window override for the effective model, from the allowlist entry.
 * `undefined` when unknown (caller falls back to `CLERUM_CONTEXT_MAX_TOKENS`).
 */
export function contextWindowForModel(
  view: AllowlistView,
  provider: string,
  model: string
): number | undefined {
  const entries = view.allowedModels().get(provider) ?? []
  return entries.find(e => e.model === model)?.contextWindowTokens
}

function entryToWire(e: AllowedModelEntry): ModelWireEntry {
  const wire: ModelWireEntry = { name: e.model }
  if (e.displayName) wire.displayName = e.displayName
  if (e.contextWindowTokens) wire.contextWindowTokens = e.contextWindowTokens
  return wire
}
