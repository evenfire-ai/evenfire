import { type Response, Router } from 'express'
import { asyncHandler } from '../../http/asyncHandler.js'
import {
  MAX_ALLOWLIST_ENTRY_LENGTH,
  MAX_ALLOWLIST_ITEMS,
  PLUGIN_WORKLOAD_SDK_FAMILIES,
  PLUGIN_WORKLOAD_SDK_INVOCATION_STATUSES,
  type PluginWorkloadSdkFamily,
  type PluginWorkloadSdkInvocationStatus,
  type PluginWorkloadSdkModelPolicy,
  type PluginWorkloadSdkQuotaLimits,
  deleteGrant,
  getQuotaCounters,
  listGrants,
  listInvocations,
  upsertGrant,
} from '../../services/pluginWorkloadSdkDb.js'
import { isPlainObject } from '../../utils/isPlainObject.js'

// ─── Plugin Workload SDK — admin routes (plan §2.6) ──────────────────────
// Admin auth is enforced upstream by the control-ui auth gate in app.ts
// (same contract as every other /admin router).
//
//   GET    /admin/plugin-workload-sdk/grants
//   POST   /admin/plugin-workload-sdk/grants            (upsert by recipe+family)
//   DELETE /admin/plugin-workload-sdk/grants/:id
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

const QUOTA_LIMIT_KEYS: ReadonlyArray<keyof PluginWorkloadSdkQuotaLimits> = [
  'maxRequestsPerRun',
  'maxNotificationsPerRun',
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
  for (const key of QUOTA_LIMIT_KEYS) {
    const raw = value[key]
    if (raw === undefined) continue
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
      res.status(400).json({ error: `quotaLimits.${key} must be a positive integer` })
      return null
    }
    limits[key] = raw
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
      !raw.model.trim()
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

export function createAdminPluginWorkloadSdkRouter(): Router {
  const router = Router()

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

      const allowedModels = parseStringArray(body.allowedModels, 'allowedModels', res)
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
      if (capabilityFamily === 'promptBridge' && allowedModels.length === 0) {
        res.status(400).json({ error: 'allowedModels must be non-empty for promptBridge grants' })
        return
      }

      if (allowedCallers.length === 0) {
        res.status(400).json({ error: 'allowedCallers must be non-empty' })
        return
      }

      const grant = await upsertGrant({
        recipeNamespace,
        recipeName,
        capabilityFamily: capabilityFamily as PluginWorkloadSdkFamily,
        allowedModels,
        allowedEventTypes,
        allowedTargetRefs,
        allowedUserRefs,
        allowedCallers,
        quotaLimits,
        modelPolicies,
      })
      res.status(200).json({ grant })
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
      const deleted = await deleteGrant(req.params.id, recipeNamespace, recipeName)
      if (!deleted) {
        res.status(404).json({ error: 'grant not found' })
        return
      }
      res.status(200).json({ deleted: true })
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
