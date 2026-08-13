/**
 * The SINGLE definition of "from which locations of a Host spec does a reference
 * to a `(provider, model)` pair come, and in which role" (regla D4).
 *
 * A Host references a `(provider, model)` pair iff it appears in one of THREE
 * spec locations:
 *   1. `spec.model`                  → role `primary`      (the Host default)
 *   2. `spec.allowedModels[]`        → role `allowedModels` (per-Host subset)
 *   3. `spec.llmPolicy.fallbacks[]`  → role `fallback`      (fallback policy)
 *
 * This business rule was implemented TWICE — the live impact enumeration
 * (`hostRolesReferencing` in services/llmModelImpact.ts, feeding the destructive
 * allowlist-mutation gate) and the stored-reference detection (`storedRoleSets`
 * in routes/admin/hostSpecValidation.ts, feeding no-worsening tolerance). Both
 * copies were consistent, but a future 4th location added to only one copy would
 * make the impact gate SILENTLY under-report while tolerance still saw it. This
 * module collapses the enumeration to one place: a 4th location is a one-line
 * change here that both callers inherit.
 *
 * Purely structural and defensive: any malformed/partial entry is skipped, never
 * throws. Normalization is `.trim()` on both provider and model, both required
 * non-empty, keyed via `offeredKey` (the same NUL-separated key the write-gate
 * uses, so a model id containing spaces can never collide with a distinct pair) —
 * IDENTICAL to what both callers did inline before the extraction.
 *
 * SCOPE (what this module does NOT do): it emits every reference, unfiltered and
 * un-deduped, in spec order (primary, then allowedModels[] in array order, then
 * fallbacks[] in array order). Target-filtering + role dedup (the impact caller)
 * and primary/any bucketing (the tolerance caller) are each caller's own concern,
 * applied on top of this common enumeration — no decision logic lives here.
 */
import { isPlainObject } from '../../utils/isPlainObject.js'
import { offeredKey } from './modelAllowlistTolerance.js'

/** Which Host spec location referenced a `(provider, model)` pair. */
export type HostModelRole = 'primary' | 'allowedModels' | 'fallback'

/** One `(provider, model)` reference emitted by a Host spec, tagged by its role. */
export interface HostModelReferenceEntry {
  /** `offeredKey(provider, model)` — the NUL-separated pair key. */
  key: string
  /** The spec location this reference came from. */
  role: HostModelRole
}

/**
 * Enumerate every `(provider, model)` reference a Host spec makes, tagged by the
 * role (location) it came from. Emitted in spec order — `primary` first, then
 * each `spec.allowedModels[]` entry, then each `spec.llmPolicy.fallbacks[]` entry
 * — with NO filtering and NO deduplication (a pair present in several locations
 * yields one entry per location). A non-object spec, or a spec whose locations
 * are absent/empty/malformed, yields the entries it can and skips the rest.
 */
export function enumerateHostModelReferences(spec: unknown): HostModelReferenceEntry[] {
  if (!isPlainObject(spec)) return []
  const refs: HostModelReferenceEntry[] = []

  // 1. primary — spec.model
  const model = spec.model
  if (isPlainObject(model)) {
    const name = typeof model.name === 'string' ? model.name.trim() : ''
    const provider = typeof model.provider === 'string' ? model.provider.trim() : ''
    if (name && provider) refs.push({ key: offeredKey(provider, name), role: 'primary' })
  }

  // 2. allowedModels — spec.allowedModels[]
  const allowedModels = spec.allowedModels
  if (Array.isArray(allowedModels)) {
    for (const entry of allowedModels) {
      if (!isPlainObject(entry)) continue
      const provider = typeof entry.provider === 'string' ? entry.provider.trim() : ''
      const m = typeof entry.model === 'string' ? entry.model.trim() : ''
      if (provider && m) refs.push({ key: offeredKey(provider, m), role: 'allowedModels' })
    }
  }

  // 3. fallback — spec.llmPolicy.fallbacks[]
  const llmPolicy = spec.llmPolicy
  if (isPlainObject(llmPolicy) && Array.isArray(llmPolicy.fallbacks)) {
    for (const entry of llmPolicy.fallbacks) {
      if (!isPlainObject(entry)) continue
      const provider = typeof entry.provider === 'string' ? entry.provider.trim() : ''
      const m = typeof entry.model === 'string' ? entry.model.trim() : ''
      if (provider && m) refs.push({ key: offeredKey(provider, m), role: 'fallback' })
    }
  }

  return refs
}
