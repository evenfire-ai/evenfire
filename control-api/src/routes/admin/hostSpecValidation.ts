import { z } from 'zod'
import {
  type LlmProviderId,
  PROVIDER_CREDENTIAL_SLOTS,
  isLlmProviderId,
} from '@clerum/llm-providers'
import {
  getModelAllowlistState as getModelAllowlistStateDefault,
  isModelAllowed as isModelAllowedDefault,
} from '../../services/llmAllowedModels.js'
import { isPlainObject } from '../../utils/isPlainObject.js'
import {
  type HostSpecIncoherenceToleratedEvent,
  type IncoherenceToleranceGate,
} from './hostWriteGateAudit.js'
import {
  type CoverageSet,
  isNonWorseningToleration,
  offeredKey,
} from './modelAllowlistTolerance.js'
import { STALE_MODEL_ASSIGNED, type StaleModelWarning } from './staleModelWarning.js'

// A Kubernetes Secret/ConfigMap data key: `[-._a-zA-Z0-9]`, max 253 chars.
// A fallback `credentialSlot` names a key inside the chatllm-api-keys Secret, so
// it must satisfy that format. We validate the FORMAT only — the key's existence
// in the Secret is resolved by mcp-host at runtime (a cheap DB-free write gate
// cannot see the Secret's contents; spec §3-R5.3). Same pattern as recipes.ts.
const SECRET_KEY_RE = /^[-._a-zA-Z0-9]+$/

/**
 * Whether a provider may carry a per-fallback `credentialSlot` (an extra
 * single-line Secret key that overrides its one API key). Only providers whose
 * SOLE credential slot is a single-line API key qualify. A multi-slot provider
 * (Bedrock: access-key-id + secret-access-key) or a single-slot provider whose
 * key is the multiline service-account JSON (Vertex: `vertex-service-account-json`
 * → `VERTEX_SERVICE_ACCOUNT_JSON`) cannot be expressed by one extra key, so those
 * fallbacks must reuse the primary's credentials. Derived entirely from the
 * shared registry so adding a provider needs no change here.
 */
function providerSupportsFallbackCredentialSlot(provider: LlmProviderId): boolean {
  const slots = PROVIDER_CREDENTIAL_SLOTS[provider]
  // A per-fallback credentialSlot is ONE single-line API key. A multi-slot
  // provider (Bedrock's pair) or a multi-line slot (Vertex's service-account
  // JSON) can't be expressed as one extra key. `multiline` is the explicit
  // registry flag (replaces the old `-json`/`_JSON` name heuristic).
  return slots.length === 1 && !slots[0].multiline
}

const HostApprovalSchema = z
  .object({
    defaultPolicy: z.string().optional(),
    channels: z.any().optional(),
    tools: z.record(z.string(), z.boolean()).optional(),
  })
  .passthrough()
  .optional()

export interface HostSpecValidationDeps {
  isModelAllowed: (provider: string, model: string) => Promise<boolean>
  /**
   * Full `{ enabled, stale }` allowlist state for a pair (Fase 6). OPTIONAL and
   * defaulted so existing callers that inject only `isModelAllowed` keep working;
   * it is consulted ONLY when `context.warnings` is supplied (the stale-warning
   * sink), so a caller not requesting warnings never triggers this lookup.
   */
  getModelAllowlistState?: (
    provider: string,
    model: string
  ) => Promise<{ enabled: boolean; stale: boolean } | null>
}

/**
 * Per-write context for the no-worsening tolerance (Pieza D). ABSENT on create
 * (there is no stored CR, so tolerance can never apply — a fresh spec may not
 * introduce a disabled model). Supplied on update by the admin facade, which
 * reads the stored Host CR before the write.
 */
export interface HostSpecValidationContext {
  /** The stored Host CR spec read before this write; absent on create. */
  stored?: Record<string, unknown>
  /** Host identity for the audit event payload. */
  hostRef?: { namespace: string; name: string }
  /**
   * OUTPUT sink. When the write is ACCEPTED, the validator appends here the
   * audit events for each tolerated gate. It does NOT emit them: the caller
   * emits only AFTER the write persists (mini-spec 01), so a write that a later
   * step (secretRef check, K8s conflict) rejects leaves no audit record.
   */
  tolerations?: HostSpecIncoherenceToleratedEvent[]
  /**
   * OUTPUT sink for Fase 6 soft-quarantine warnings. When present, the validator
   * appends a warning for every NEW assignment of an `enabled` but `stale` model
   * (a live reference in `stored` is never revalidated). Same emit-after-persist
   * discipline as `tolerations`: the validator only fills the sink on ACCEPT; the
   * caller returns it in the success body only after the write persists — a write
   * rejected by a later gate carries no warning. Independent of `stored`: warnings
   * apply on both create (all assignments new) and update.
   */
  warnings?: StaleModelWarning[]
}

// spec.lifecycle follows the facade's contract for optional spec objects,
// exactly like spec.desktop: the admin facade forwards body.spec to the K8s
// client WHOLESALE (resourceService.updateResource is a full replace via
// replaceNamespacedCustomObject), so an update payload WITHOUT lifecycle
// strips it from the CR — absent means disabled. Control UI must always echo
// the full spec it read (get -> edit -> update); the round-trip regression in
// test/routes.resources.test.ts pins that guarantee. When present, lifecycle
// must be an object carrying a boolean `stateless`; unknown extra keys pass
// through, matching the HostApprovalSchema idiom above.
//
// AP-6 (docs/architecture/stateless-invariants.md): the echo alone cannot
// protect against a STALE echo — a form saved after the CR changed would
// replace the fresh spec with what the form read earlier. Control UI
// therefore also sends metadata.resourceVersion of the read the edit form
// was built from; resourceService.updateResource uses it as the replace
// precondition and surfaces 409 {error:'conflict', reason:'resource_changed'}
// instead of retrying with the stale payload.
const HostLifecycleSchema = z
  .object({
    stateless: z.boolean(),
  })
  .passthrough()
  .optional()

/**
 * Validate a Host spec before it reaches the K8s API.
 *
 * - `spec.approval`: defensive zod shape check (unchanged behavior).
 * - `spec.lifecycle` (stateless agents): optional object carrying a boolean
 *   `stateless`; absent means disabled (the admin facade full-replaces the CR,
 *   so Control UI must echo the full spec it read).
 * - `spec.model` (R3): when a model name is present it must exist AND be enabled
 *   in the operator allowlist under its declared provider — fail-closed for new
 *   selections. A spec without `spec.model.name` is left untouched (deployed
 *   Hosts are never disrupted; enforcement applies to create/edit via this API).
 * - `spec.llmPolicy` (R5): opt-in provider-fallback policy; every fallback entry
 *   must reference a known provider and an allowlisted model.
 * - `spec.allowedModels` (Topic 3a): optional/additive per-host SUBSET of the
 *   global allowlist this host offers. Absent/empty = the host offers the FULL
 *   global allowlist (back-compat). When present, every entry must be a global
 *   allowlist pair, and the primary (`spec.model.name`) plus every fallback must
 *   fall WITHIN the offered subset (coherence — a host cannot serve what it does
 *   not offer).
 *
 * `isModelAllowed` is injectable so this stays unit-testable without a DB.
 */
export async function validateHostSpec(
  spec: Record<string, unknown>,
  deps: HostSpecValidationDeps = {
    isModelAllowed: isModelAllowedDefault,
    getModelAllowlistState: getModelAllowlistStateDefault,
  },
  context: HostSpecValidationContext = {}
): Promise<{ errors: Array<{ field: string; message: string }> } | null> {
  // Contract guard (mini-spec 01): passing `stored` enables tolerance, so the
  // caller MUST also pass the `tolerations` sink — otherwise a tolerated pair
  // would be accepted while its audit event is silently dropped ("never silent"
  // violated). Couple them: a caller that supplies `stored` without a sink is a
  // programming error, not a silent degrade.
  if (context.stored !== undefined && context.tolerations === undefined) {
    throw new Error(
      'validateHostSpec: context.tolerations sink is required when context.stored is provided (a tolerated pair must never be emitted silently)'
    )
  }

  // Structural (sync, zod) checks first: accumulate approval + lifecycle shape
  // errors so a payload bad in both surfaces both — dev's stateless contract
  // pinned by test/routes.resources.test.ts.
  const structuralErrors: Array<{ field: string; message: string }> = []
  if (spec.approval !== undefined) {
    const result = HostApprovalSchema.safeParse(spec.approval)
    if (!result.success) {
      for (const issue of result.error.issues) {
        structuralErrors.push({
          field: ['spec', 'approval', ...issue.path].join('.'),
          message: issue.message,
        })
      }
    }
  }
  if (spec.lifecycle !== undefined) {
    const result = HostLifecycleSchema.safeParse(spec.lifecycle)
    if (!result.success) {
      for (const issue of result.error.issues) {
        structuralErrors.push({
          field: ['spec', 'lifecycle', ...issue.path].join('.'),
          message: issue.message,
        })
      }
    }
  }
  if (structuralErrors.length > 0) return { errors: structuralErrors }

  // No-worsening tolerance context (Pieza D), computed once and shared by the 3
  // global-allowlist gates below. On create `context.stored` is absent, so
  // `storedPairs` is empty and no gate can tolerate — a fresh spec may never
  // introduce a disabled model.
  const tol: HostToleranceBundle = {
    context,
    deps,
    storedRoles: storedRoleSets(context.stored),
    incomingCov: hostCoverage(spec),
    storedCov: hostCoverage(context.stored),
    pending: [],
    warnings: [],
    warnedKeys: new Set(),
  }

  // R3 model allowlist. Enforcement is keyed on the PRESENCE of `spec.model.name`
  // (not just a truthy string) so a non-string/garbage name cannot slip past the
  // gate — that is strictly fail-closed. A spec with no `name` key at all is left
  // untouched (deployed Hosts are never disrupted).
  const model = spec.model
  if (isPlainObject(model) && model.name !== undefined) {
    const name = typeof model.name === 'string' ? model.name.trim() : ''
    if (!name) {
      return {
        errors: [
          { field: 'spec.model.name', message: 'spec.model.name must be a non-empty string' },
        ],
      }
    }
    const provider = typeof model.provider === 'string' ? model.provider.trim() : ''
    if (!provider) {
      // The allowlist is keyed by (provider, model); a bare model name cannot be
      // validated. Ask for the provider explicitly instead of routing an empty
      // provider through the lookup (which would reject with a confusing message).
      return {
        errors: [
          {
            field: 'spec.model.provider',
            message: 'spec.model.provider is required when spec.model.name is set',
          },
        ],
      }
    }
    const allowed = await deps.isModelAllowed(provider, name)
    if (!allowed && !toleratePair(provider, name, 'primary', tol)) {
      return {
        errors: [
          {
            field: 'spec.model.name',
            message: `model_not_allowed: "${name}" is not enabled in the allowlist for provider "${provider}"`,
          },
        ],
      }
    }
    // Fase 6: an ENABLED pair that passed the gate may still be `stale`. Warn (no
    // block) if this is a NEW assignment.
    if (allowed) await maybeWarnStale(provider, name, 'spec.model.name', tol)
  }

  // R5 provider-fallback policy. Opt-in and additive: a spec with no `llmPolicy`
  // is untouched. When present, EVERY fallback entry must reference a real
  // provider and a model enabled in the operator allowlist under that provider
  // (same fail-closed gate as spec.model.name), so a broken fallback is caught
  // on write instead of surfacing only during the incident it was meant to
  // absorb (spec V16). `credentialSlot`, when present, is format-checked only.
  const policyErrors = await validateLlmPolicy(spec.llmPolicy, deps, tol)
  if (policyErrors) return policyErrors

  // Topic 3a per-host allowlist. Runs AFTER the global-allowlist gates above, so
  // by the time coherence is checked the primary + fallbacks are already known
  // to be valid GLOBAL pairs; this narrows them to the host's offered subset.
  const allowedModelsErrors = await validateAllowedModels(spec, deps, tol)
  if (allowedModelsErrors) return allowedModelsErrors

  // The write PASSED validation: hand the queued tolerations to the caller via
  // the context sink. The caller emits them only AFTER the write persists — never
  // here, so a later rejection (secretRef check, K8s conflict) leaves no audit
  // record (mini-spec 01, persist-ordering fix).
  if (context.tolerations) context.tolerations.push(...tol.pending)

  // Fase 6: hand the queued soft-quarantine warnings to the caller via the sink,
  // on ACCEPT only — same persist-ordering as tolerations, so a write a later gate
  // rejects (secretRef check, K8s conflict) surfaces no warning.
  if (context.warnings) context.warnings.push(...tol.warnings)

  return null
}

/**
 * The stored `(provider, model)` pairs a Host spec references, ranked by ROLE
 * ACTIVENESS (mini-spec 01 v2 — role-scoped tolerance):
 *
 *   - `primary` — the ACTIVE slot (`spec.model`), the default mcp-host routes.
 *   - `any`     — every referenced pair, across primary + fallbacks + subset.
 *
 * Tolerance at the ACTIVE `primary` gate is strict (`P ∈ primary`), so a disabled
 * pair that was only a fallback/subset entry cannot be PROMOTED to the active
 * default. The non-active gates (fallback, subset) accept `P ∈ any`, so DEMOTING
 * a disabled pair from primary to a less-active role — pure non-worsening — is
 * tolerated. This mirrors the grant seam (`storedDefaultTarget` strict for the
 * default slot, `storedAnyTarget` for the rest), keeping Host and grants
 * symmetric (D4). Both sets are empty when there is no stored spec (create), so
 * tolerance never applies to a fresh Host.
 */
interface StoredRoleSets {
  /** The active slot: `spec.model`. */
  primary: ReadonlySet<string>
  /** Union of every referenced pair (primary ∪ fallbacks ∪ allowedModels). */
  any: ReadonlySet<string>
}

function storedRoleSets(stored: Record<string, unknown> | undefined): StoredRoleSets {
  const primary = new Set<string>()
  const any = new Set<string>()
  if (!isPlainObject(stored)) return { primary, any }
  const model = stored.model
  if (
    isPlainObject(model) &&
    typeof model.name === 'string' &&
    typeof model.provider === 'string'
  ) {
    const name = model.name.trim()
    const provider = model.provider.trim()
    if (name && provider) {
      const key = offeredKey(provider, name)
      primary.add(key)
      any.add(key)
    }
  }
  const llmPolicy = stored.llmPolicy
  if (isPlainObject(llmPolicy) && Array.isArray(llmPolicy.fallbacks)) {
    for (const entry of llmPolicy.fallbacks) {
      if (!isPlainObject(entry)) continue
      const provider = typeof entry.provider === 'string' ? entry.provider.trim() : ''
      const fbModel = typeof entry.model === 'string' ? entry.model.trim() : ''
      if (provider && fbModel) any.add(offeredKey(provider, fbModel))
    }
  }
  const allowedModels = stored.allowedModels
  if (Array.isArray(allowedModels)) {
    for (const entry of allowedModels) {
      if (!isPlainObject(entry)) continue
      const provider = typeof entry.provider === 'string' ? entry.provider.trim() : ''
      const model2 = typeof entry.model === 'string' ? entry.model.trim() : ''
      if (provider && model2) any.add(offeredKey(provider, model2))
    }
  }
  return { primary, any }
}

/**
 * Coverage a Host spec offers, for condition (b). `spec.allowedModels` absent,
 * non-array, or EMPTY means "offers the full global allowlist" (Topic 3a
 * back-compat), represented by the `'UNIVERSAL'` sentinel; a non-empty array is
 * the finite set of offered `(provider, model)` keys.
 */
function hostCoverage(spec: Record<string, unknown> | undefined): CoverageSet {
  if (!isPlainObject(spec)) return 'UNIVERSAL'
  const allowedModels = spec.allowedModels
  if (!Array.isArray(allowedModels) || allowedModels.length === 0) return 'UNIVERSAL'
  const keys = new Set<string>()
  for (const entry of allowedModels) {
    if (!isPlainObject(entry)) continue
    const provider = typeof entry.provider === 'string' ? entry.provider.trim() : ''
    const model = typeof entry.model === 'string' ? entry.model.trim() : ''
    if (provider && model) keys.add(offeredKey(provider, model))
  }
  return keys
}

/**
 * Shared no-worsening decision for a Host write gate. Returns `true` (and emits
 * the audit event) when the disallowed `(provider, model)` pair may be tolerated
 * because the write does not worsen a pre-existing incoherence.
 */

/** The precomputed no-worsening tolerance inputs, shared by the 3 Host gates. */
interface HostToleranceBundle {
  context: HostSpecValidationContext
  deps: HostSpecValidationDeps
  storedRoles: StoredRoleSets
  incomingCov: CoverageSet
  storedCov: CoverageSet
  /**
   * Audit events for tolerated gates, ACCUMULATED here and copied into
   * `context.tolerations` only once `validateHostSpec` confirms the write is
   * ACCEPTED (returns null). Never emitted by the validator — the caller emits
   * after the write persists. A write that a later gate hard-rejects (422)
   * leaves no audit record. One event per tolerated gate decision.
   */
  pending: HostSpecIncoherenceToleratedEvent[]
  /**
   * Fase 6 soft-quarantine warnings, ACCUMULATED here and copied into
   * `context.warnings` only on ACCEPT (same persist-ordering as `pending`).
   */
  warnings: StaleModelWarning[]
  /** Pair keys already warned, so a model in two roles warns at most once. */
  warnedKeys: Set<string>
}

/**
 * Fase 6 soft quarantine. Queue a NON-BLOCKING warning when an `enabled` but
 * `stale` model is assigned to something NEW. NO-OP unless `context.warnings` is
 * provided (opt-in sink), so callers that do not request warnings pay no lookup.
 * A pair already referenced by the STORED record is a live reference and is never
 * revalidated (spec §3.3) → no warning. Called ONLY on the `enabled` path (after
 * the gate accepted the pair), so a disabled/tolerated pair (Fase 2) never routes
 * here.
 */
async function maybeWarnStale(
  provider: string,
  model: string,
  field: string,
  tol: HostToleranceBundle
): Promise<void> {
  if (!tol.context.warnings) return
  const key = offeredKey(provider, model)
  if (tol.storedRoles.any.has(key)) return
  if (tol.warnedKeys.has(key)) return
  const getState = tol.deps.getModelAllowlistState ?? getModelAllowlistStateDefault
  // Best-effort: this is an EXTRA lookup (separate from the isModelAllowed gate
  // query) that ONLY feeds the additive stale warning. The PR invariant is that
  // the soft quarantine is additive and NEVER blocks a write (never 422/409/500).
  // A blip on this query (connection reset) must not turn a valid Host
  // create/update into an HTTP 500 — swallow it, proceed WITHOUT a warning, and
  // let the write persist. The correctness gate (isModelAllowed) is untouched: it
  // still propagates its failures and still hard-rejects a disallowed model.
  let state: { enabled: boolean; stale: boolean } | null
  try {
    state = await getState(provider, model)
  } catch (err) {
    console.warn(
      `[Admin] stale-model warning lookup failed for "${provider}/${model}"; proceeding without a warning: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
    return
  }
  if (state?.enabled && state.stale) {
    tol.warnedKeys.add(key)
    tol.warnings.push({ code: STALE_MODEL_ASSIGNED, provider, model, field })
  }
}

/**
 * Decide whether a disallowed `(provider, model)` may be tolerated at `gate`
 * because the write does not worsen a pre-existing incoherence AND the pair does
 * not GAIN activeness (role-scoped, mini-spec 01 v2). On tolerance, QUEUES the
 * audit event (not emitted until the whole write persists) and returns true so
 * the gate skips its rejection.
 */
function toleratePair(
  provider: string,
  model: string,
  gate: 'primary' | 'fallback' | 'subset',
  tol: HostToleranceBundle
): boolean {
  // Role-scoped membership. The ACTIVE `primary` slot is strict: the pair must
  // have been the stored primary (blocks promotion). Non-active gates accept any
  // stored role (allows demotion — pure non-worsening).
  const storedRoleSet = gate === 'primary' ? tol.storedRoles.primary : tol.storedRoles.any
  const tolerated = isNonWorseningToleration({
    pairKey: offeredKey(provider, model),
    storedReferencedPairKeys: storedRoleSet,
    incomingCoverage: tol.incomingCov,
    storedCoverage: tol.storedCov,
  })
  if (!tolerated) return false
  tol.pending.push({
    resourceKind: 'host',
    namespace: tol.context.hostRef?.namespace ?? '',
    name: tol.context.hostRef?.name ?? '',
    provider,
    model,
    gate,
    offeredBefore: tol.storedCov,
    offeredAfter: tol.incomingCov,
  })
  return true
}

/**
 * Validate `spec.allowedModels[]` on write (Topic 3a). OPTIONAL/ADDITIVE: absent
 * returns null (host offers the full global allowlist). When present it is the
 * per-host SUBSET of the global allowlist this host offers:
 *
 *  1. every entry `(provider, model)` must be a known provider AND a pair enabled
 *     in the GLOBAL allowlist (same fail-closed gate as spec.model / R5); an
 *     offending entry answers 422 with a `spec.allowedModels[i]` field path;
 *  2. COHERENCE (only when the offered subset is non-empty): the primary
 *     `spec.model.name` and every `spec.llmPolicy.fallbacks[i].model` must fall
 *     WITHIN that offered subset - a host cannot serve a model it does not offer.
 *
 * An EMPTY array is treated exactly like absent (full global allowlist, coherence
 * skipped) so existing hosts are never disrupted.
 */
async function validateAllowedModels(
  spec: Record<string, unknown>,
  deps: HostSpecValidationDeps,
  tol: HostToleranceBundle
): Promise<{ errors: Array<{ field: string; message: string }> } | null> {
  const allowedModels = spec.allowedModels
  if (allowedModels === undefined) return null
  if (!Array.isArray(allowedModels)) {
    return {
      errors: [{ field: 'spec.allowedModels', message: 'spec.allowedModels must be an array' }],
    }
  }

  const offered = new Set<string>()
  for (let i = 0; i < allowedModels.length; i++) {
    const entry = allowedModels[i]
    const base = `spec.allowedModels[${i}]`
    if (!isPlainObject(entry)) {
      return { errors: [{ field: base, message: `${base} must be an object` }] }
    }

    const provider = typeof entry.provider === 'string' ? entry.provider.trim() : ''
    if (!provider) {
      return { errors: [{ field: `${base}.provider`, message: `${base}.provider is required` }] }
    }
    if (!isLlmProviderId(provider)) {
      return {
        errors: [
          {
            field: `${base}.provider`,
            message: `${base}.provider "${provider}" is not a known provider`,
          },
        ],
      }
    }

    const model = typeof entry.model === 'string' ? entry.model.trim() : ''
    if (!model) {
      return { errors: [{ field: `${base}.model`, message: `${base}.model is required` }] }
    }

    // Global-allowlist gate LAST (only async/DB check): a pair not in the global
    // catalog can never be offered by a host — unless tolerating a pre-existing
    // incoherence this write does not worsen (Pieza D). A tolerated pair is still
    // added to `offered` so the coherence gate below sees the host as offering it.
    const allowed = await deps.isModelAllowed(provider, model)
    if (!allowed && !toleratePair(provider, model, 'subset', tol)) {
      return {
        errors: [
          {
            field: `${base}.model`,
            message: `model_not_allowed: "${model}" is not enabled in the allowlist for provider "${provider}"`,
          },
        ],
      }
    }
    // Fase 6 soft quarantine on the per-host offered subset.
    if (allowed) await maybeWarnStale(provider, model, `${base}.model`, tol)

    offered.add(offeredKey(provider, model))
  }

  // Empty offered set (a literal `[]`) -> additive back-compat: full global
  // allowlist, no subset to violate, so the coherence gate is skipped.
  if (offered.size === 0) return null

  // COHERENCE - primary. Only enforced when `spec.model.name` is actually present
  // (a Host without a declared primary is left untouched, mirroring the R3 gate).
  // The `provider` truthiness guard is defensive only: the R3 gate above already
  // 422s a present `spec.model.name` that lacks a provider, so by here a present
  // name guarantees a present provider.
  const model = spec.model
  if (isPlainObject(model) && typeof model.name === 'string') {
    const name = model.name.trim()
    const provider = typeof model.provider === 'string' ? model.provider.trim() : ''
    if (name && provider && !offered.has(offeredKey(provider, name))) {
      return {
        errors: [
          {
            field: 'spec.model.name',
            message: `model_not_offered: primary model "${name}" (provider "${provider}") is not in spec.allowedModels`,
          },
        ],
      }
    }
  }

  // COHERENCE - fallbacks. Entries here are already known-good GLOBAL pairs
  // (validateLlmPolicy ran first); this narrows them to the offered subset.
  const llmPolicy = spec.llmPolicy
  if (isPlainObject(llmPolicy) && Array.isArray(llmPolicy.fallbacks)) {
    const { fallbacks } = llmPolicy
    for (let i = 0; i < fallbacks.length; i++) {
      const entry = fallbacks[i]
      if (!isPlainObject(entry)) continue
      const provider = typeof entry.provider === 'string' ? entry.provider.trim() : ''
      const fbModel = typeof entry.model === 'string' ? entry.model.trim() : ''
      if (provider && fbModel && !offered.has(offeredKey(provider, fbModel))) {
        return {
          errors: [
            {
              field: `spec.llmPolicy.fallbacks[${i}].model`,
              message: `model_not_offered: fallback "${fbModel}" (provider "${provider}") is not in spec.allowedModels`,
            },
          ],
        }
      }
    }
  }

  return null
}

/**
 * Validate `spec.llmPolicy.fallbacks[]` on write (spec §3-R5.3). Returns the
 * FIRST offending entry's error (mirroring the short-circuit style above) so the
 * caller can answer 422 with a field path like `spec.llmPolicy.fallbacks[1].model`.
 * Absent `llmPolicy` returns null (no failover configured). The CRD schema is the
 * structural authority; this is the semantic gate (allowlist + slot format) that
 * the apiserver cannot perform.
 */
async function validateLlmPolicy(
  llmPolicy: unknown,
  deps: HostSpecValidationDeps,
  tol: HostToleranceBundle
): Promise<{ errors: Array<{ field: string; message: string }> } | null> {
  if (llmPolicy === undefined) return null
  if (!isPlainObject(llmPolicy)) {
    return { errors: [{ field: 'spec.llmPolicy', message: 'spec.llmPolicy must be an object' }] }
  }

  const { fallbacks } = llmPolicy
  // `fallbacks` absent is left to the CRD schema (it is required there). We only
  // validate its entries when it is actually an array with content.
  if (fallbacks === undefined) return null
  if (!Array.isArray(fallbacks)) {
    return {
      errors: [
        { field: 'spec.llmPolicy.fallbacks', message: 'spec.llmPolicy.fallbacks must be an array' },
      ],
    }
  }

  for (let i = 0; i < fallbacks.length; i++) {
    const entry = fallbacks[i]
    const base = `spec.llmPolicy.fallbacks[${i}]`
    if (!isPlainObject(entry)) {
      return { errors: [{ field: base, message: `${base} must be an object` }] }
    }

    const provider = typeof entry.provider === 'string' ? entry.provider.trim() : ''
    if (!provider) {
      return { errors: [{ field: `${base}.provider`, message: `${base}.provider is required` }] }
    }
    if (!isLlmProviderId(provider)) {
      return {
        errors: [
          {
            field: `${base}.provider`,
            message: `${base}.provider "${provider}" is not a known provider`,
          },
        ],
      }
    }

    const model = typeof entry.model === 'string' ? entry.model.trim() : ''
    if (!model) {
      return { errors: [{ field: `${base}.model`, message: `${base}.model is required` }] }
    }

    if (entry.credentialSlot !== undefined) {
      const slot = typeof entry.credentialSlot === 'string' ? entry.credentialSlot : ''
      if (!slot || slot.length > 253 || !SECRET_KEY_RE.test(slot)) {
        return {
          errors: [
            {
              field: `${base}.credentialSlot`,
              message: `${base}.credentialSlot must be a valid Secret data key (matching ${SECRET_KEY_RE}, max 253 chars)`,
            },
          ],
        }
      }
      // Capability gate (residual 1b, decision 3): a fallback `credentialSlot`
      // names ONE single-line Secret key that overrides the provider's single API
      // key. It cannot express a multi-credential provider (Bedrock = access-key +
      // secret pair) or a multiline service-account JSON (Vertex) — those MUST
      // reuse the primary's credentials. `provider` is already narrowed to a known
      // LlmProviderId above, so the registry lookup is total.
      if (!providerSupportsFallbackCredentialSlot(provider)) {
        return {
          errors: [
            {
              field: `${base}.credentialSlot`,
              message: `${base}.credentialSlot is not supported for provider "${provider}": it uses multiple or JSON credentials and must reuse the primary's credentials (drop credentialSlot)`,
            },
          ],
        }
      }
    }

    // Allowlist gate LAST: it is the only async (DB) check, so cheap structural
    // rejections above avoid a needless query. Tolerated (Pieza D) when the pair
    // is a pre-existing incoherence this write does not worsen.
    const allowed = await deps.isModelAllowed(provider, model)
    if (!allowed && !toleratePair(provider, model, 'fallback', tol)) {
      return {
        errors: [
          {
            field: `${base}.model`,
            message: `model_not_allowed: "${model}" is not enabled in the allowlist for provider "${provider}"`,
          },
        ],
      }
    }
    // Fase 6 soft quarantine on a fallback assignment.
    if (allowed) await maybeWarnStale(provider, model, `${base}.model`, tol)
  }

  return null
}
