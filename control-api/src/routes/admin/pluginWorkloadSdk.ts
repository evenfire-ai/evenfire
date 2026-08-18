import { type Response, Router } from 'express'
import {
  isCredentialSlotOwnedByProvider,
  isLlmProviderId,
  isRunnableLlmModelId,
} from '@clerum/llm-providers'
import {
  advisoryLockModelNames,
  boundCarrierTransactionIdleTimeout,
  withTransaction,
} from '../../db.js'
import { asyncHandler } from '../../http/asyncHandler.js'
import type { UiAuthedRequest } from '../../middleware/controlUIAuth.js'
import { createPluginWorkloadSdkAdminRateLimit } from '../../middleware/pluginWorkloadSdkRateLimits.js'
import { listEnabledModelsWithStaleForProvider } from '../../services/llmAllowedModels.js'
import {
  MAX_ALLOWLIST_ENTRY_LENGTH,
  MAX_ALLOWLIST_ITEMS,
  MAX_PROMPT_BRIDGE_TARGETS_PER_GRANT,
  PLUGIN_WORKLOAD_SDK_FAMILIES,
  PLUGIN_WORKLOAD_SDK_INVOCATION_STATUSES,
  type PluginWorkloadSdkFamily,
  type PluginWorkloadSdkInvocationStatus,
  type PluginWorkloadSdkModelPolicy,
  type PluginWorkloadSdkPromptTarget,
  type PluginWorkloadSdkQuotaLimits,
  deleteGrant,
  getPluginWorkloadSdkLegacyGrantInventory,
  getQuotaCounters,
  hasUsableClientNotificationRecipients,
  listGrants,
  listInvocations,
  upsertGrant,
} from '../../services/pluginWorkloadSdkDb.js'
import { isPlainObject } from '../../utils/isPlainObject.js'
import {
  type EmitHostSpecIncoherenceTolerated,
  type HostSpecIncoherenceToleratedEvent,
  emitHostSpecIncoherenceTolerated as emitHostSpecIncoherenceToleratedDefault,
} from './hostWriteGateAudit.js'
import {
  type CoverageSet,
  isNonWorseningToleration,
  offeredKey,
} from './modelAllowlistTolerance.js'
import { STALE_MODEL_ASSIGNED, type StaleModelWarning } from './staleModelWarning.js'

// ─── Plugin Workload SDK — admin routes (plan §2.6) ──────────────────────
// Admin auth is enforced upstream by the control-ui auth gate in app.ts
// (same contract as every other /admin router).
//
//   GET    /admin/plugin-workload-sdk/grants
//   POST   /admin/plugin-workload-sdk/grants            (upsert by recipe+family)
//   DELETE /admin/plugin-workload-sdk/grants/:id
//   GET    /admin/plugin-workload-sdk/legacy-inventory (read-only migration gate)
//   GET    /admin/plugin-workload-sdk/quota/:recipeNamespace/:recipeName
//   GET    /admin/plugin-workload-sdk/invocations       (audit search)

const FAMILY_SET = new Set<string>(PLUGIN_WORKLOAD_SDK_FAMILIES)
const STATUS_SET = new Set<string>(PLUGIN_WORKLOAD_SDK_INVOCATION_STATUSES)

// allowedUserRefs are matched verbatim against audience.userId, which every
// delivery path (claim, desktop ACK, SSE) joins to the control-plane user UUID.
// A non-UUID userRef would authorize + enqueue but never claim (no medium-account
// match), leaving the notification to expire silently after 72h. Reject it at
// grant creation so the failure is loud and immediate, not silent data loss.
// (targetRefs are opaque provider identities, so they are intentionally exempt.)
const USER_REF_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SECRET_KEY_RE = /^[-._a-zA-Z0-9]+$/

function parseIsoTimestamp(
  value: unknown,
  field: string,
  res: Response
): string | null | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    res.status(400).json({ error: `${field} must be an ISO-8601 timestamp string` })
    return null
  }
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) {
    res.status(400).json({ error: `${field} must be a valid ISO-8601 timestamp` })
    return null
  }
  return new Date(parsed).toISOString()
}

function parseStringArray(value: unknown, field: string, res: Response): string[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) {
    res.status(400).json({ error: `${field} must be an array of strings` })
    return null
  }
  if (value.length > MAX_ALLOWLIST_ITEMS) {
    res.status(400).json({
      error: `${field} must contain at most ${MAX_ALLOWLIST_ITEMS} entries`,
    })
    return null
  }
  for (const entry of value) {
    if (entry.length > MAX_ALLOWLIST_ENTRY_LENGTH) {
      res.status(400).json({
        error: `${field} entries must be at most ${MAX_ALLOWLIST_ENTRY_LENGTH} characters`,
      })
      return null
    }
  }
  return value as string[]
}

function parseModelArray(value: unknown, field: string, res: Response): string[] | null {
  const values = parseStringArray(value, field, res)
  if (values === null) return null
  // Keep wildcard rejection distinct from the runnable-model grammar error.
  // Wildcards are a policy-boundary violation, not a malformed model id, and
  // callers/tests rely on the stable structured error for that case.
  if (values.some(model => model.includes('*'))) {
    res.status(400).json({ error: 'wildcard_not_allowed' })
    return null
  }
  const invalid = values.find(
    model => !isRunnableLlmModelId(model.trim()) || model.trim() !== model
  )
  if (invalid !== undefined) {
    res.status(400).json({
      error: `${field} entries must be valid runnable model ids`,
      value: invalid,
    })
    return null
  }
  return values
}

// Issue #348: per-run quota keys are deprecated. They remain accepted on the
// wire for compatibility and are validated with the same shape rules, but they
// are stripped before persistence — only per-minute/platform limits are stored.
const DEPRECATED_QUOTA_LIMIT_KEYS: ReadonlyArray<keyof PluginWorkloadSdkQuotaLimits> = [
  'maxRequestsPerRun',
  'maxNotificationsPerRun',
]

const ACTIVE_QUOTA_LIMIT_KEYS: ReadonlyArray<keyof PluginWorkloadSdkQuotaLimits> = [
  'maxInvocationsPerMinute',
  'maxNotificationsPerMinute',
  'maxOutputTokens',
]

function parseQuotaLimits(value: unknown, res: Response): PluginWorkloadSdkQuotaLimits | null {
  if (value === undefined) return {}
  if (!isPlainObject(value)) {
    res.status(400).json({ error: 'quotaLimits must be an object' })
    return null
  }
  const limits: PluginWorkloadSdkQuotaLimits = {}
  for (const key of [...DEPRECATED_QUOTA_LIMIT_KEYS, ...ACTIVE_QUOTA_LIMIT_KEYS]) {
    const raw = value[key]
    if (raw === undefined) continue
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
      res.status(400).json({ error: `quotaLimits.${key} must be a positive integer` })
      return null
    }
    // Deprecated keys are validated (malformed input still 400s) but never
    // assigned, so they are not persisted (issue #348).
    if ((ACTIVE_QUOTA_LIMIT_KEYS as readonly string[]).includes(key)) {
      limits[key] = raw
    }
  }
  return limits
}

function parseModelPolicies(
  value: unknown,
  res: Response
): Record<string, PluginWorkloadSdkModelPolicy> | null {
  if (value === undefined) return {}
  if (!isPlainObject(value)) {
    res.status(400).json({ error: 'modelPolicies must be an object' })
    return null
  }
  const policies: Record<string, PluginWorkloadSdkModelPolicy> = {}
  for (const [ref, raw] of Object.entries(value)) {
    if (
      !isPlainObject(raw) ||
      typeof raw.provider !== 'string' ||
      !raw.provider.trim() ||
      typeof raw.model !== 'string' ||
      !isRunnableLlmModelId(raw.model.trim())
    ) {
      res.status(400).json({
        error: `modelPolicies.${ref} must declare provider and model`,
      })
      return null
    }
    policies[ref] = {
      provider: raw.provider,
      model: raw.model,
      ...(typeof raw.temperature === 'number' ? { temperature: raw.temperature } : {}),
      ...(typeof raw.maxCostUsd === 'number' ? { maxCostUsd: raw.maxCostUsd } : {}),
    }
  }
  return policies
}

function credentialSlotBelongsToProvider(provider: string, credentialSlot: string): boolean {
  // This shares the exact slot-ownership rule with the runtime broker. A
  // target only carries the key identity; this route never reads the Secret or
  // returns a value.
  return isCredentialSlotOwnedByProvider(provider, credentialSlot)
}

function parsePromptTargets(value: unknown, res: Response): PluginWorkloadSdkPromptTarget[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    res
      .status(400)
      .json({ error: 'promptTargets must be a non-empty array for promptBridge grants' })
    return null
  }
  if (value.length > MAX_PROMPT_BRIDGE_TARGETS_PER_GRANT) {
    res.status(400).json({
      error: `promptTargets must contain at most ${MAX_PROMPT_BRIDGE_TARGETS_PER_GRANT} entries`,
    })
    return null
  }
  const targets: PluginWorkloadSdkPromptTarget[] = []
  const targetRefs = new Set<string>()
  // Provider + model must be unique even when two extra slots exist. Otherwise
  // the documented exact `{provider, model}` selector and modelPolicyRef would
  // choose a credential slot implicitly, which is a policy bypass.
  const providerModels = new Set<string>()
  for (let index = 0; index < value.length; index++) {
    const raw = value[index]
    if (!isPlainObject(raw)) {
      res.status(400).json({ error: `promptTargets[${index}] must be an object` })
      return null
    }
    const targetRef = typeof raw.targetRef === 'string' ? raw.targetRef.trim() : ''
    const provider = typeof raw.provider === 'string' ? raw.provider.trim() : ''
    const model = typeof raw.model === 'string' ? raw.model.trim() : ''
    const credentialSlot = typeof raw.credentialSlot === 'string' ? raw.credentialSlot.trim() : ''
    if (!targetRef || targetRef.length > MAX_ALLOWLIST_ENTRY_LENGTH || targetRef.includes('*')) {
      res
        .status(400)
        .json({ error: `promptTargets[${index}].targetRef must be a non-wildcard identifier` })
      return null
    }
    if (!isLlmProviderId(provider)) {
      res.status(400).json({ error: `promptTargets[${index}].provider is invalid` })
      return null
    }
    if (!isRunnableLlmModelId(model) || model.includes('*')) {
      res
        .status(400)
        .json({ error: `promptTargets[${index}].model must be a non-wildcard model id` })
      return null
    }
    if (
      !credentialSlot ||
      credentialSlot.length > 253 ||
      !SECRET_KEY_RE.test(credentialSlot) ||
      !credentialSlotBelongsToProvider(provider, credentialSlot)
    ) {
      res.status(400).json({
        error: `promptTargets[${index}].credentialSlot must be a valid slot owned by provider "${provider}"`,
      })
      return null
    }
    const providerModel = `${provider}\u0000${model}`
    if (targetRefs.has(targetRef) || providerModels.has(providerModel)) {
      res.status(400).json({ error: `promptTargets[${index}] duplicates an existing target` })
      return null
    }
    targetRefs.add(targetRef)
    providerModels.add(providerModel)
    targets.push({ targetRef, provider, model, credentialSlot })
  }
  return targets
}

// A rejection produced by the enabled-ness write-gate WHILE it runs inside the
// carrier transaction that holds the per-model advisory locks (R1-H3 fase 2).
// It is THROWN (not `res.json`-ed inline) so the transaction ROLLS BACK — the
// upsert never persists and no Pieza D audit is emitted — then mapped back to
// the SAME 400 body the gate has always returned. `body` is byte-stable with
// the pre-fase-2 responses (`model_not_allowed`, `modelPolicies.*` drift).
class GrantModelGateError extends Error {
  constructor(readonly body: Record<string, unknown>) {
    super('grant_model_gate_rejected')
    this.name = 'GrantModelGateError'
  }
}

export interface AdminPluginWorkloadSdkRouterDeps {
  /**
   * Emit the audit signal for a tolerated pre-existing model_not_allowed
   * incoherence on a grant write (Pieza D). Injected so the "never silent"
   * guarantee is testable through the seam; defaults to the shared emitter.
   */
  emitIncoherenceTolerated?: EmitHostSpecIncoherenceTolerated
}

export function createAdminPluginWorkloadSdkRouter(
  deps: AdminPluginWorkloadSdkRouterDeps = {}
): Router {
  const emitIncoherenceTolerated =
    deps.emitIncoherenceTolerated ?? emitHostSpecIncoherenceToleratedDefault
  const router = Router()
  router.use('/admin/plugin-workload-sdk', createPluginWorkloadSdkAdminRateLimit())

  router.get(
    '/admin/plugin-workload-sdk/grants',
    asyncHandler(async (req, res) => {
      const recipeNamespace =
        typeof req.query.recipeNamespace === 'string' ? req.query.recipeNamespace : undefined
      const recipeName = typeof req.query.recipeName === 'string' ? req.query.recipeName : undefined
      const items = await listGrants({ recipeNamespace, recipeName })
      res.status(200).json({ items })
    })
  )

  router.post(
    '/admin/plugin-workload-sdk/grants',
    asyncHandler(async (req, res) => {
      const body = isPlainObject(req.body) ? req.body : {}

      const recipeNamespace =
        typeof body.recipeNamespace === 'string' ? body.recipeNamespace.trim() : ''
      const recipeName = typeof body.recipeName === 'string' ? body.recipeName.trim() : ''
      if (!recipeNamespace || !recipeName) {
        res.status(400).json({ error: 'recipeNamespace and recipeName are required' })
        return
      }
      const capabilityFamily =
        typeof body.capabilityFamily === 'string' ? body.capabilityFamily : ''
      if (!FAMILY_SET.has(capabilityFamily)) {
        res.status(400).json({
          error: `capabilityFamily must be one of: ${PLUGIN_WORKLOAD_SDK_FAMILIES.join(', ')}`,
        })
        return
      }

      const allowedModels = parseModelArray(body.allowedModels, 'allowedModels', res)
      if (allowedModels === null) return
      const allowedEventTypes = parseStringArray(body.allowedEventTypes, 'allowedEventTypes', res)
      if (allowedEventTypes === null) return
      const allowedTargetRefs = parseStringArray(body.allowedTargetRefs, 'allowedTargetRefs', res)
      if (allowedTargetRefs === null) return
      const allowedUserRefs = parseStringArray(body.allowedUserRefs, 'allowedUserRefs', res)
      if (allowedUserRefs === null) return
      if (allowedUserRefs.some(ref => !USER_REF_UUID_RE.test(ref))) {
        res.status(400).json({
          error: 'allowedUserRefs entries must be control-plane user UUIDs',
        })
        return
      }
      const allowedCallers = parseStringArray(body.allowedCallers, 'allowedCallers', res)
      if (allowedCallers === null) return
      const quotaLimits = parseQuotaLimits(body.quotaLimits, res)
      if (quotaLimits === null) return
      const modelPolicies = parseModelPolicies(body.modelPolicies, res)
      if (modelPolicies === null) return

      const hasWildcard = [
        ...allowedModels,
        ...allowedEventTypes,
        ...allowedTargetRefs,
        ...allowedUserRefs,
        ...allowedCallers,
      ].some(entry => entry.includes('*'))
      if (hasWildcard) {
        res.status(400).json({ error: 'wildcard_not_allowed' })
        return
      }

      if (capabilityFamily === 'clientNotifications' && allowedEventTypes.length === 0) {
        res
          .status(400)
          .json({ error: 'allowedEventTypes must be non-empty for clientNotifications grants' })
        return
      }
      if (
        capabilityFamily === 'clientNotifications' &&
        allowedTargetRefs.length + allowedUserRefs.length === 0
      ) {
        res.status(400).json({
          error:
            'clientNotifications grants require at least one allowedTargetRefs or allowedUserRefs entry',
        })
        return
      }
      if (
        capabilityFamily === 'clientNotifications' &&
        !(await hasUsableClientNotificationRecipients({ allowedTargetRefs, allowedUserRefs }))
      ) {
        res.status(400).json({
          error:
            'clientNotifications grants require at least one existing user or verified notification target',
        })
        return
      }
      const promptTargets =
        capabilityFamily === 'promptBridge' ? parsePromptTargets(body.promptTargets, res) : []
      if (promptTargets === null) return
      const defaultTargetRef =
        capabilityFamily === 'promptBridge' && typeof body.defaultTargetRef === 'string'
          ? body.defaultTargetRef.trim()
          : ''
      if (capabilityFamily === 'promptBridge') {
        if (!defaultTargetRef || promptTargets[0]?.targetRef !== defaultTargetRef) {
          res.status(400).json({
            error: 'defaultTargetRef is required and must be the first promptTargets entry',
          })
          return
        }
      }

      // R1: promptBridge credentials resolve per-provider, so the grant stores an
      // explicit provider (it is no longer inferred from the model list). It is
      // required for promptBridge and irrelevant for clientNotifications.
      // R4: `provider` is now validated against the canonical provider set from
      // the shared @clerum/llm-providers package (the guard is prototype-safe).
      // provider↔allowedModels consistency IS also enforced (R3): after the
      // provider is resolved, every allowedModels entry must exist enabled under
      // that provider in the `llm_allowed_models` allowlist (checked below).
      let provider: string | undefined
      // Pieza D — queued grant tolerations, flushed only once the write is
      // ACCEPTED (right before upsert). A grant rejected by a later 400 leaves no
      // audit record.
      const pendingGrantTolerations: HostSpecIncoherenceToleratedEvent[] = []
      // Fase 6 soft-quarantine warnings for NEW assignments of enabled-but-stale
      // models. Returned in the 200 body only after the upsert lands (below); a
      // grant rejected by a later 400 returns before the response and carries none.
      const grantWarnings: StaleModelWarning[] = []
      const grantWarnedKeys = new Set<string>()
      if (capabilityFamily === 'promptBridge') {
        const rawProvider = typeof body.provider === 'string' ? body.provider.trim() : ''
        if (!rawProvider) {
          res.status(400).json({ error: 'provider is required for promptBridge grants' })
          return
        }
        if (!isLlmProviderId(rawProvider)) {
          res.status(400).json({ error: 'Invalid provider' })
          return
        }
        provider = rawProvider
      }

      if (capabilityFamily === 'promptBridge') {
        const defaultTarget = promptTargets[0]!
        // `provider` remains the bootstrap host binding during the compatibility
        // window. It cannot authorize routes by itself and must agree with the
        // policy default instead of being silently reconciled. Pure check, kept
        // OUTSIDE the carrier transaction (no model read, no lock needed).
        if (provider !== defaultTarget.provider) {
          res.status(400).json({ error: 'policy_bootstrap_mismatch' })
          return
        }
      }

      // R1-H3 fase 2 — carrier transaction that serializes this grant upsert
      // against a concurrent llm-model disable/delete (the reductor, fase 1).
      // The reductor enumerates grants by NAME in `allowed_models` under
      // `advisoryLockModelName`; so the upsert takes the SAME per-name locks over
      // ALL incoming `allowed_models` names, HOLDS them across the enabled-ness
      // re-validation, and commits the write atomically. Ordering is the global
      // invariant (adenda A5): every `llm-model:*` lock is taken BEFORE the
      // recipe lock (`plugin_workload_sdk:*`, taken inside `upsertGrant`). If the
      // reductor commits first, the gate below re-reads `llm_allowed_models`
      // under the lock and rejects (400); if the grant commits first, the
      // reductor sees it and answers 409 — neither can strand a dangling grant.
      // Enabled-ness is validated only for promptBridge targets, EXACTLY as
      // before (serialization only, no accept/reject change): a disabled model
      // reachable solely through `allowed_models` (no promptTarget) is a
      // PRE-EXISTING gap, out of R1-H3 scope.
      let grant: Awaited<ReturnType<typeof upsertGrant>>
      try {
        grant = await withTransaction(async db => {
          // Bound idle-in-transaction tenancy for parity with the reductor
          // (fase 1). This seam is PG-only (no K8s write under the lock), so the
          // lock is never held across an external round-trip — cheap, defensive.
          await boundCarrierTransactionIdleTimeout(db)
          // Model-name locks FIRST, deduped + totally ordered, over EVERY incoming
          // `allowed_models` name (the reductor matches by name across families).
          // Empty list = no-op. Taken before the recipe lock (global order A5).
          await advisoryLockModelNames(db, allowedModels)

          if (capabilityFamily === 'promptBridge') {
            const modelsByProvider = new Map<string, string[]>()
            for (const target of promptTargets) {
              modelsByProvider.set(target.provider, [
                ...(modelsByProvider.get(target.provider) ?? []),
                target.model,
              ])
            }
            // Pieza D — role-scoped no-worsening tolerance (editability trap,
            // mini-spec 01). A grant that references a model later disabled
            // globally would otherwise be uneditable (every save 400s
            // `model_not_allowed`). Tolerate a disabled `(provider, model)` iff
            // (b) the incoming `allowed_models` does NOT shrink the stored
            // coverage AND it kept its ROLE: the incoming DEFAULT target
            // (`promptTargets[0]`) is tolerated only if it was the stored default
            // target; a NON-default target only if it was any stored target
            // (demotion is not worsening). Promoting a disabled non-default target
            // to the default slot is NOT tolerated. A brand-new disabled model is
            // never tolerated. The stored grant is read lazily — only when a
            // candidate rejection appears — so the all-enabled happy path keeps
            // its single-query cost.
            const incomingDefaultKey = offeredKey(
              promptTargets[0]!.provider,
              promptTargets[0]!.model
            )
            let storedLoaded = false
            let storedDefaultTarget = new Set<string>()
            let storedAnyTarget = new Set<string>()
            // Grant `allowed_models` is a flat model-name list; treat it as a
            // literal finite coverage set (NOT the Host UNIVERSAL-on-empty
            // semantics) so an emptied list is a strict reduction, not a widening.
            const incomingCoverage: CoverageSet = new Set(allowedModels)
            let storedCoverage: CoverageSet = new Set<string>()
            const loadStoredGrant = async (): Promise<void> => {
              if (storedLoaded) return
              storedLoaded = true
              // Read the stored grant on the CARRIER connection (holds the model
              // locks) so no extra pool checkout happens under the lock (A3).
              const storedGrant = (await listGrants({ recipeNamespace, recipeName }, db))?.find(
                existing => existing.capabilityFamily === capabilityFamily
              )
              const storedTargets = storedGrant?.promptTargets ?? []
              storedDefaultTarget = new Set(
                storedTargets[0]
                  ? [offeredKey(storedTargets[0].provider, storedTargets[0].model)]
                  : []
              )
              storedAnyTarget = new Set(storedTargets.map(t => offeredKey(t.provider, t.model)))
              storedCoverage = new Set(storedGrant?.allowedModels ?? [])
            }
            for (const [targetProvider, targetModels] of modelsByProvider) {
              // Enabled-ness re-read UNDER the model locks, on the carrier `db`
              // (NOT the global pool) — this is the read the reductor races.
              const enabledRows = await listEnabledModelsWithStaleForProvider(targetProvider, db)
              const enabled = new Set(enabledRows.map(row => row.model))
              const staleEnabled = new Set(
                enabledRows.filter(row => row.stale).map(row => row.model)
              )

              // Fase 6 soft quarantine: warn (never block) when a NEW target
              // assigns an ENABLED but `stale` model. A live reference already in
              // the stored grant is not revalidated (spec §3.3). The stored grant
              // is loaded lazily — only when a stale-enabled candidate is actually
              // present — so the all-fresh / no-stale happy path keeps its
              // single-query cost.
              for (const model of targetModels) {
                if (!enabled.has(model) || !staleEnabled.has(model)) continue
                const pairKey = offeredKey(targetProvider, model)
                if (grantWarnedKeys.has(pairKey)) continue
                grantWarnedKeys.add(pairKey)
                await loadStoredGrant()
                if (storedAnyTarget.has(pairKey)) continue
                const i = promptTargets.findIndex(
                  target => target.provider === targetProvider && target.model === model
                )
                grantWarnings.push({
                  code: STALE_MODEL_ASSIGNED,
                  provider: targetProvider,
                  model,
                  field: i >= 0 ? `promptTargets[${i}].model` : 'promptTargets',
                })
              }

              const rawOffenders = targetModels.filter(model => !enabled.has(model))
              if (rawOffenders.length === 0) continue
              await loadStoredGrant()
              const offenders: string[] = []
              for (const model of rawOffenders) {
                const pairKey = offeredKey(targetProvider, model)
                // Role of the offending pair in the INCOMING grant: the default
                // slot (`promptTargets[0]`) must have been the stored default; any
                // other target may have been any stored target.
                const storedRoleSet =
                  pairKey === incomingDefaultKey ? storedDefaultTarget : storedAnyTarget
                const tolerated = isNonWorseningToleration({
                  pairKey,
                  storedReferencedPairKeys: storedRoleSet,
                  incomingCoverage,
                  storedCoverage,
                })
                if (tolerated) {
                  pendingGrantTolerations.push({
                    resourceKind: 'grant',
                    namespace: recipeNamespace,
                    name: recipeName,
                    provider: targetProvider,
                    model,
                    gate: 'grant',
                    offeredBefore: storedCoverage,
                    offeredAfter: incomingCoverage,
                  })
                } else {
                  offenders.push(model)
                }
              }
              if (offenders.length > 0) {
                // THROW (not res.json) so the transaction rolls back — the upsert
                // never runs and no Pieza D audit fires — mapped to the byte-stable
                // 400 `model_not_allowed` body outside the transaction.
                throw new GrantModelGateError({
                  error: 'model_not_allowed',
                  provider: targetProvider,
                  models: offenders,
                })
              }
            }
            // A modelPolicyRef names an already-authorized target, not a second
            // routing authority. Keep the older record shape but reject drift.
            // Runs AFTER the enabled-ness gate to preserve error precedence.
            for (const [ref, policy] of Object.entries(modelPolicies)) {
              if (
                !promptTargets.some(
                  target => target.provider === policy.provider && target.model === policy.model
                )
              ) {
                throw new GrantModelGateError({
                  error: `modelPolicies.${ref} does not match an authorized target`,
                })
              }
            }
          }

          if (allowedCallers.length === 0) {
            throw new GrantModelGateError({ error: 'allowedCallers must be non-empty' })
          }

          // Reuse THIS transaction: `upsertGrant` takes the recipe lock as its
          // first statement — AFTER the model locks above (global order A5) — and
          // commits the write in the same critical section as the re-validation.
          return upsertGrant(
            {
              recipeNamespace,
              recipeName,
              capabilityFamily: capabilityFamily as PluginWorkloadSdkFamily,
              provider,
              allowedModels,
              allowedEventTypes,
              allowedTargetRefs,
              allowedUserRefs,
              allowedCallers,
              quotaLimits,
              modelPolicies,
              promptTargets,
              defaultTargetRef: defaultTargetRef || undefined,
            },
            (req as UiAuthedRequest).adminAuth!.sub,
            db
          )
        })
      } catch (err) {
        if (err instanceof GrantModelGateError) {
          res.status(400).json(err.body)
          return
        }
        throw err
      }
      // Grant PERSISTED: NOW emit any Pieza D tolerations (never before the upsert
      // lands, so a failed upsert leaves no audit record — mini-spec 01).
      for (const event of pendingGrantTolerations) emitIncoherenceTolerated(event)
      // Fase 6: attach any soft-quarantine warnings additively (older clients
      // ignore the field). Absent when there is nothing to warn about.
      res
        .status(200)
        .json(grantWarnings.length > 0 ? { grant, warnings: grantWarnings } : { grant })
    })
  )

  router.delete(
    '/admin/plugin-workload-sdk/grants/:id',
    asyncHandler(async (req, res) => {
      // Scope the delete to the grant's recipe binding (defense in depth): a
      // UUID alone must not delete a grant belonging to another recipe.
      const recipeNamespace =
        typeof req.query.recipeNamespace === 'string' ? req.query.recipeNamespace.trim() : ''
      const recipeName = typeof req.query.recipeName === 'string' ? req.query.recipeName.trim() : ''
      if (!recipeNamespace || !recipeName) {
        res
          .status(400)
          .json({ error: 'recipeNamespace and recipeName query parameters are required' })
        return
      }
      const deleted = await deleteGrant(
        req.params.id,
        recipeNamespace,
        recipeName,
        (req as UiAuthedRequest).adminAuth!.sub
      )
      if (!deleted) {
        res.status(404).json({ error: 'grant not found' })
        return
      }
      res.status(200).json({ deleted: true })
    })
  )

  router.get(
    '/admin/plugin-workload-sdk/legacy-inventory',
    asyncHandler(async (req, res) => {
      const recipeNamespace =
        typeof req.query.recipeNamespace === 'string' ? req.query.recipeNamespace.trim() : undefined
      const recipeName =
        typeof req.query.recipeName === 'string' ? req.query.recipeName.trim() : undefined
      const inventory = await getPluginWorkloadSdkLegacyGrantInventory({
        ...(recipeNamespace ? { recipeNamespace } : {}),
        ...(recipeName ? { recipeName } : {}),
      })
      res.status(200).json(inventory)
    })
  )

  router.get(
    '/admin/plugin-workload-sdk/quota/:recipeNamespace/:recipeName',
    asyncHandler(async (req, res) => {
      const items = await getQuotaCounters(req.params.recipeNamespace, req.params.recipeName)
      res.status(200).json({ items })
    })
  )

  router.get(
    '/admin/plugin-workload-sdk/invocations',
    asyncHandler(async (req, res) => {
      const q = req.query
      const method = typeof q.method === 'string' && FAMILY_SET.has(q.method) ? q.method : undefined
      const status = typeof q.status === 'string' && STATUS_SET.has(q.status) ? q.status : undefined
      const limitRaw = typeof q.limit === 'string' ? Number.parseInt(q.limit, 10) : NaN
      const since = parseIsoTimestamp(q.since, 'since', res)
      if (since === null) return
      const until = parseIsoTimestamp(q.until, 'until', res)
      if (until === null) return
      const items = await listInvocations({
        recipeNamespace: typeof q.recipeNamespace === 'string' ? q.recipeNamespace : undefined,
        recipeName: typeof q.recipeName === 'string' ? q.recipeName : undefined,
        method: method as PluginWorkloadSdkFamily | undefined,
        status: status as PluginWorkloadSdkInvocationStatus | undefined,
        since,
        until,
        limit: Number.isFinite(limitRaw) ? limitRaw : undefined,
      })
      res.status(200).json({ items })
    })
  )

  return router
}
