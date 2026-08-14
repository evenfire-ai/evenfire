/**
 * LLM-model impact enumeration (spec Fase 3). Enumerates every LIVE reference to
 * an operator-allowlist `(provider, model)` pair, so a destructive allowlist
 * mutation (DELETE, or a PUT that disables the model) can warn the operator
 * about the Hosts/grants it would silently invalidate instead of breaking them
 * in the dark.
 *
 * This feeds a SAFETY GATE: an under-report lets the operator disable a still-
 * referenced model believing it is free — exactly the silent breakage the phase
 * exists to prevent. So the enumeration is FAIL-LOUD: if any Host LIST fails, the
 * whole computation REJECTS (propagates) rather than returning a partial result,
 * and the caller fails the destructive op closed.
 *
 * A `(provider, model)` pair is referenced from FOUR sources — a hybrid of the
 * live K8s CRD store and Postgres:
 *   1. Host `spec.model` (the primary model the Host defaults to)          [CRD]
 *   2. Host `spec.allowedModels[]` (the per-Host offered subset)           [CRD]
 *   3. Host `spec.llmPolicy.fallbacks[]` (the provider-fallback policy)    [CRD]
 *   4. `plugin_workload_sdk_grants.allowed_models` (grant model allowlist) [PG]
 *
 * OUT OF SCOPE by design (spec §3.2 + §5): grant `prompt_targets` are NOT
 * enumerated. The spec limits the grant impact surface to `allowed_models` (§3.2)
 * and excludes promptBridge from carrying a warning surface (§5). References that
 * exist only through `prompt_targets` are intentionally not reported here — this
 * is a deliberate scope boundary, not a missing source.
 *
 * NAMESPACE COVERAGE. Host CRDs live in the operator's host namespace(s). This
 * module enumerates the SAME set the canonical host fan-out uses — the injected
 * `hostNamespaces` (built from `config.hostsNamespace` + the control-api default
 * namespace, mirroring `ResourceService.listNamespacesForPlural('hosts')`) — and
 * LISTs each ONE BY ONE via `listResource('hosts', ns)`. It deliberately does NOT
 * use the `namespace='*'` sentinel: `ResourceService` swallows per-namespace LIST
 * errors on that path (`catch {}`), which would silently under-report. The
 * per-namespace path propagates, giving the fail-loud guarantee above. Every
 * admin write pins Hosts to `config.hostsNamespace` (`enforceNamespace`), so this
 * set is the full universe a Host can occupy. Cost: O(#namespaces) LIST calls,
 * each O(#Hosts).
 *
 * The GRANT match is by MODEL NAME ONLY, not `(provider, model)`. The grant
 * `allowed_models` column is a provider-LESS flat model-name list and is NOT
 * enforced to hold only models of the grant's `provider` column (the write-gate
 * validates `prompt_targets` per-provider, but `allowed_models` is passed through
 * free-form and can span providers). Filtering by `provider` would therefore
 * UNDER-report — the unsafe direction for a safety gate. Matching by model name
 * may over-report a same-named model under a different provider (added operator
 * friction, never silent breakage), which is the fail-safe trade-off.
 *
 * ONE module, TWO callers (regla D4): the `?force` gate on PUT/DELETE
 * (`routes/admin/llmModels.ts`) and, later, `GET /admin/attention` (Fase 5).
 * Neither reconstructs the impact — both call `computeModelImpact`.
 */
import {
  type HostModelRole,
  enumerateHostModelReferences,
} from '../routes/admin/hostModelReferences.js'
import { offeredKey } from '../routes/admin/modelAllowlistTolerance.js'
import { isPlainObject } from '../utils/isPlainObject.js'
import { type PluginWorkloadSdkGrant, listGrantsReferencingModel } from './pluginWorkloadSdkDb.js'

/**
 * Which Host spec source referenced the pair. A Host may match in several.
 * Re-exported from the shared enumeration module (regla D4) so existing importers
 * of this symbol from `llmModelImpact` keep working.
 */
export type { HostModelRole }

/** A Host CR that references the pair, with the roles it matched in. */
export interface HostModelReference {
  namespace: string
  name: string
  roles: HostModelRole[]
}

/** A grant that references the pair through its `allowed_models` list. */
export interface GrantModelReference {
  id: string
  recipeNamespace: string
  recipeName: string
  capabilityFamily: string
}

/** The enumerated live references to a `(provider, model)` pair. */
export interface ModelImpact {
  provider: string
  model: string
  hostsAffected: HostModelReference[]
  grantsAffected: GrantModelReference[]
}

/**
 * Injectable sources so the enumeration stays unit-testable without a real K8s
 * client or DB. Both callers build these from the real producers via
 * `modelImpactSourcesFromGateway`.
 */
export interface ModelImpactSources {
  /** The exact set of namespaces a Host can occupy (the canonical host set). */
  hostNamespaces: string[]
  /**
   * LIST Hosts in ONE namespace. MUST propagate (reject) on failure — the
   * enumeration relies on that for its fail-loud/fail-closed guarantee.
   */
  listHostsInNamespace: (namespace: string) => Promise<unknown[]>
  /** Grants whose `allowed_models` list contains `model` (provider-less match). */
  listGrantsForModel: (model: string) => Promise<PluginWorkloadSdkGrant[]>
}

/** Minimal gateway surface this module needs — a per-namespace Host LIST. */
interface HostListGateway {
  listResource: (plural: 'hosts', namespace?: string) => Promise<unknown[]>
}

/**
 * Wire the impact sources to the real producers: live per-namespace Host LIST via
 * the K8s gateway (NO `'*'` — see the fail-loud rationale above) and the grant
 * SQL query. `hostNamespaces` is supplied by the caller from config so the single
 * source of truth for "where Hosts live" stays in one place.
 */
export function modelImpactSourcesFromGateway(
  gateway: HostListGateway,
  hostNamespaces: string[]
): ModelImpactSources {
  return {
    hostNamespaces,
    listHostsInNamespace: namespace => gateway.listResource('hosts', namespace),
    listGrantsForModel: model => listGrantsReferencingModel(model),
  }
}

/**
 * The roles in which a Host spec references the TARGET `(provider, model)` pair.
 * Provider-aware match: keeps only the shared enumeration entries whose key
 * equals `targetKey` (the same NUL-separated `offeredKey` the write-gate uses, so
 * a model id containing spaces can never collide with a distinct pair), deduped
 * so each role appears at most once, in spec order (primary, allowedModels,
 * fallback). Empty when the Host does not reference the target.
 *
 * The location enumeration itself lives in `enumerateHostModelReferences` (regla
 * D4), shared verbatim with the tolerance seam's `storedRoleSets`. This caller's
 * own concern — layered on top — is target-filtering + role dedup.
 */
function hostRolesReferencing(spec: unknown, targetKey: string): HostModelRole[] {
  const roles: HostModelRole[] = []
  const seen = new Set<HostModelRole>()
  for (const ref of enumerateHostModelReferences(spec)) {
    if (ref.key !== targetKey || seen.has(ref.role)) continue
    seen.add(ref.role)
    roles.push(ref.role)
  }
  return roles
}

/**
 * Enumerate every live reference to `(provider, model)` across the four sources.
 * Aggregation over the injected sources — its only I/O is the Host LIST per
 * namespace and the grant query, both of which it lets REJECT (fail-loud). No
 * try/catch: a partial enumeration must never be returned to a safety gate.
 * Shared verbatim by the `?force` gate and the Fase 5 attention endpoint.
 */
export async function computeModelImpact(
  provider: string,
  model: string,
  sources: ModelImpactSources
): Promise<ModelImpact> {
  const targetKey = offeredKey(provider, model)

  const hostsAffected: HostModelReference[] = []
  for (const namespace of sources.hostNamespaces) {
    // No catch: a failed LIST propagates so the caller fails the destructive op
    // CLOSED instead of acting on a partial (under-reported) impact.
    const hosts = await sources.listHostsInNamespace(namespace)
    for (const host of hosts) {
      if (!isPlainObject(host)) continue
      const roles = hostRolesReferencing(host.spec, targetKey)
      if (roles.length === 0) continue
      const metadata = isPlainObject(host.metadata) ? host.metadata : {}
      hostsAffected.push({
        namespace: typeof metadata.namespace === 'string' ? metadata.namespace : namespace,
        name: typeof metadata.name === 'string' ? metadata.name : '',
        roles,
      })
    }
  }

  const grants = await sources.listGrantsForModel(model)
  const grantsAffected: GrantModelReference[] = grants.map(grant => ({
    id: grant.id,
    recipeNamespace: grant.recipeNamespace,
    recipeName: grant.recipeName,
    capabilityFamily: grant.capabilityFamily,
  }))

  return { provider, model, hostsAffected, grantsAffected }
}

/** True when the pair has at least one live Host or grant reference. */
export function modelImpactHasReferences(impact: ModelImpact): boolean {
  return impact.hostsAffected.length > 0 || impact.grantsAffected.length > 0
}
