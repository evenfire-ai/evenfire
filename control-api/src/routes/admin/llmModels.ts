import { type Request, type Response, Router } from 'express'
import { z } from 'zod'
import { config } from '../../config.js'
import {
  type DbClient,
  advisoryLockModelName,
  boundCarrierTransactionIdleTimeout,
  withTransaction,
} from '../../db.js'
import { asyncHandler } from '../../http/asyncHandler.js'
import type { K8sGateway } from '../../k8s.js'
import type { UiAuthedRequest } from '../../middleware/controlUIAuth.js'
import { llmAllowlistConfigMapWriteFailuresTotal } from '../../observability/metrics.js'
import {
  LlmAllowedModelConflictError,
  createAllowedModel,
  createLlmAllowedModelSchema,
  deleteAllowedModel,
  getAllowedModel,
  listAllowedModels,
  listStaleAllowedModels,
  updateAllowedModel,
  updateLlmAllowedModelSchema,
} from '../../services/llmAllowedModels.js'
import { computeAttention } from '../../services/llmAttention.js'
import { getLastCatalogSyncRun, syncDiscoveredModels } from '../../services/llmCatalogSync.js'
import {
  type ModelImpact,
  computeModelImpact,
  modelImpactHasReferences,
  modelImpactSourcesFromGateway,
  modelImpactSourcesFromGatewayTx,
} from '../../services/llmModelImpact.js'

// The reductor lost the availability-reduction race: a live Host/grant reference
// to the pair was enumerated UNDER the advisory lock, so disabling/removing it
// would strand that reference (INV-1). Thrown from inside the carrier transaction
// so it ROLLS BACK (the mutation never persists) and mapped to the same
// 409 `model_in_use` body the gate has always returned.
class ModelInUseError extends Error {
  constructor(readonly impact: ModelImpact) {
    super('model_in_use')
    this.name = 'ModelInUseError'
  }
}

// The 409 message is unchanged (mini-spec §6: the response shape is byte-stable).
const MODEL_IN_USE_MESSAGE =
  'this model is still referenced by one or more Hosts or grants; retry with ?force=true to disable/remove it and leave those references pointing at a disabled/removed model'

// `id` is a UUID column; a malformed id would otherwise reach Postgres and
// raise 22P02 (→ 500). Treat a non-UUID id as a missing row (404).
const idSchema = z.string().uuid()
function isValidId(id: string): boolean {
  return idSchema.safeParse(id).success
}

function sendZodError(res: Response, error: z.ZodError): void {
  res.status(400).json({
    error: 'invalid_request',
    details: error.issues.map(issue => ({
      field: issue.path.join('.') || '(root)',
      message: issue.message,
    })),
  })
}

function handleServiceError(res: Response, error: unknown): boolean {
  if (error instanceof LlmAllowedModelConflictError) {
    res.status(409).json({ error: 'conflict', message: error.message })
    return true
  }
  return false
}

// `?force=true` opts the operator past the availability-reduction gate (Fase 3).
// Only the exact string `true` counts; absent / `false` / garbage / a repeated
// param (array) all read as NOT forced — fail-safe toward SHOWING the impact.
function isForced(req: Request): boolean {
  return req.query.force === 'true'
}

// Admin identity for the audit row. Auth is enforced upstream by the control-ui
// auth gate; `sub` is the admin UUID. Fall back defensively so a mutation is
// never silently unattributed.
function actorOf(req: Request): string {
  return (req as UiAuthedRequest).adminAuth?.sub ?? 'admin'
}

export function createAdminLlmModelsRouter(gateway: K8sGateway): Router {
  const router = Router()

  // Anti-drift (spec §3-R3.4 / V7): after a committed mutation, re-materialize
  // the `clerum-llm-allowed-models` ConfigMap so runtime consumers see the
  // change without a redeploy. The write is best-effort (outside the PG txn)
  // with a short retry inside the writer; a persistent failure is loud — 503
  // to the operator + metric. The row is already committed, so the next
  // mutation or the boot reconcile converges. Returns true if a 503 was sent.
  async function materializeOrFail(res: Response): Promise<boolean> {
    try {
      await gateway.llmAllowedModelsConfigMap().materialize()
      return false
    } catch (err) {
      llmAllowlistConfigMapWriteFailuresTotal.inc({ phase: 'mutation' })
      console.error(
        '[Admin] llm allowed-models ConfigMap write failed after mutation:',
        err instanceof Error ? err.message : String(err)
      )
      res.status(503).json({
        error: 'configmap_write_failed',
        message:
          'the allowlist was saved but the ConfigMap could not be updated; runtime propagation is delayed — retry or it will reconcile on the next change/boot',
      })
      return true
    }
  }

  // The exact set of namespaces a Host can occupy. Mirrors the canonical host
  // fan-out (`ResourceService.listNamespacesForPlural('hosts')` =
  // `config.hostsNamespace` + the control-api default namespace); every admin
  // write pins Hosts to `config.hostsNamespace` via `enforceNamespace`, so this
  // is the full universe. Passed explicitly (not the `'*'` sentinel) so the
  // impact enumeration LISTs each namespace fail-loud instead of swallowing
  // per-namespace LIST errors — see llmModelImpact.ts.
  const hostNamespaces = Array.from(new Set([config.hostsNamespace, config.namespace]))

  // Live references to a `(provider, model)` pair, enumerated from the real
  // producers (K8s Host LIST + grant SQL). The `?force`/attention seam shares
  // this single module (regla D4).
  const impactSources = modelImpactSourcesFromGateway(gateway, hostNamespaces)

  // Availability-reduction gate (Fase 3), now SERIALIZED (R1-H3 fase 1). A DELETE
  // (always), a PUT that flips `enabled` true→false, or a PUT that RENAMES an
  // enabled pair (its old identity leaves the ConfigMap on re-materialize) yanks
  // the model out of the runtime allowlist ConfigMap. The caller computes the
  // impact over whichever pair leaves — the OLD one on rename.
  //
  // The whole gate runs inside a carrier transaction that HOLDS the per-model-name
  // advisory lock across the impact read AND the mutation, so a concurrent host
  // create/update cannot slip a reference in between (INV-1). Grants are read on
  // the transaction client; Hosts are LISTed LIVE from K8s under the lock. If any
  // Host/grant still references the pair, a `ModelInUseError` rolls the
  // transaction back — nothing is mutated — and the caller answers 409 WITH the
  // impact body. `?force=true` never reaches here (the caller mutates without the
  // lock, deliberately renouncing INV-1 — mini-spec §6).
  async function gatedReduce<T>(
    provider: string,
    model: string,
    mutate: (db: DbClient) => Promise<T>
  ): Promise<T> {
    return withTransaction(async db => {
      // Bound the idle-in-transaction tenancy first: the lock is held across a
      // live K8s LIST, during which the connection is idle-in-transaction.
      await boundCarrierTransactionIdleTimeout(db)
      await advisoryLockModelName(db, model)
      const impact = await computeModelImpact(
        provider,
        model,
        modelImpactSourcesFromGatewayTx(gateway, hostNamespaces, db)
      )
      if (modelImpactHasReferences(impact)) throw new ModelInUseError(impact)
      return mutate(db)
    })
  }

  // Map a caught `ModelInUseError` to the stable 409 body; return true when it was
  // handled so the caller stops. Non-`ModelInUseError` errors are left to the
  // caller's existing `handleServiceError` / rethrow path.
  function sentModelInUse(res: Response, error: unknown): boolean {
    if (!(error instanceof ModelInUseError)) return false
    res.status(409).json({
      error: 'model_in_use',
      message: MODEL_IN_USE_MESSAGE,
      impact: error.impact,
    })
    return true
  }

  // ── Operator attention feed (Fase 5, Pieza C) ───────────────────────────────
  // Persistent alert backing the non-destructive Fase 4 cron: every enabled
  // `stale` catalog model that is STILL referenced by a Host/grant, so the
  // operator can disable it through the impact-gated PUT. Only actionable items
  // appear; an unreferenced stale model — or one already disabled — yields
  // nothing (`listStaleAllowedModels` filters `AND enabled`). Reuses `impactSources`
  // (the same fail-loud enumeration the `?force` gate uses, regla D4): if any
  // Host LIST fails, `computeAttention` propagates → asyncHandler → 500, never a
  // partial feed that hides a live reference. Inherits the `/admin/*` control-ui
  // admin auth gate (app.ts) — no new auth. Extensible: `items[].kind` is an
  // open union with one member today (`stale_model_referenced`).
  router.get(
    '/admin/attention',
    asyncHandler(async (_req: Request, res: Response) => {
      const staleModels = await listStaleAllowedModels()
      const report = await computeAttention(staleModels, impactSources)
      res.status(200).json(report)
    })
  )

  // ── Discovery (F2, spec 09 §2 + §8-F2) ──────────────────────────────────────
  // On-demand catalog sync from the public models.dev catalog into
  // `llm_allowed_models` as disabled `source='discovery'` rows for operator
  // curation. The fixed two-segment `discovery/*` paths cannot be captured by
  // the single-segment `/:id` param route regardless of order, but they are
  // registered before it anyway for clarity. No scheduler yet (F2 is on-demand
  // only; a scheduled trigger is a follow-up). These routes inherit the same
  // control-ui admin auth gate as the rest of `/admin/*` (app.ts).
  //
  // The sync deliberately does NOT re-materialize the ConfigMap: it never
  // mutates a `WHERE enabled` / serialized column of an enabled row (new writes
  // are `enabled=false`), so the allowlist ConfigMap stays byte-identical until an
  // operator enables a discovered model through the normal PUT path.
  router.post(
    '/admin/llm-models/discovery/sync',
    asyncHandler(async (_req: Request, res: Response) => {
      const result = await syncDiscoveredModels()
      res.status(200).json(result)
    })
  )

  router.get(
    '/admin/llm-models/discovery/status',
    asyncHandler(async (_req: Request, res: Response) => {
      const lastRun = await getLastCatalogSyncRun()
      res.status(200).json({ lastRun })
    })
  )

  router.get(
    '/admin/llm-models',
    asyncHandler(async (_req: Request, res: Response) => {
      const rows = await listAllowedModels()
      res.status(200).json({ rows })
    })
  )

  router.get(
    '/admin/llm-models/:id',
    asyncHandler(async (req: Request, res: Response) => {
      if (!isValidId(req.params.id)) {
        res.status(404).json({ error: 'not_found' })
        return
      }
      const model = await getAllowedModel(req.params.id)
      if (!model) {
        res.status(404).json({ error: 'not_found' })
        return
      }
      res.status(200).json(model)
    })
  )

  router.post(
    '/admin/llm-models',
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = createLlmAllowedModelSchema.safeParse(req.body)
      if (!parsed.success) {
        sendZodError(res, parsed.error)
        return
      }
      let model
      try {
        model = await createAllowedModel(parsed.data, actorOf(req))
      } catch (error) {
        if (handleServiceError(res, error)) return
        throw error
      }
      if (await materializeOrFail(res)) return
      res.status(201).json(model)
    })
  )

  router.put(
    '/admin/llm-models/:id',
    asyncHandler(async (req: Request, res: Response) => {
      if (!isValidId(req.params.id)) {
        res.status(404).json({ error: 'not_found' })
        return
      }
      const parsed = updateLlmAllowedModelSchema.safeParse(req.body)
      if (!parsed.success) {
        sendZodError(res, parsed.error)
        return
      }
      // Read the stored row FIRST: needed both to 404 a missing row and to
      // classify whether this write pulls the PUBLISHED `(provider, model)` pair
      // out of the runtime ConfigMap and can strand references. Two mutations do
      // that, both only while the row is currently enabled (an already-disabled
      // pair is not in the ConfigMap, so nothing can be stranded — case 4):
      //   (a) DISABLE — `enabled` true→false; the pair leaves the allowlist.
      //   (b) RENAME  — the identity `(provider, model)` changes while the row
      //       stays enabled; re-materialization regroups from the CURRENT rows
      //       (`listEnabledGroupedByProvider`), so the OLD pair vanishes from the
      //       ConfigMap exactly like a disable, silently invalidating any
      //       Host/grant that referenced it. The impact is computed over the OLD
      //       pair (`existing.provider`/`existing.model`) — that is what would be
      //       stranded — and answered with the same 409+impact body and `?force`
      //       escape as disable/delete.
      // RENAME compares VALUES, not key-presence: the admin UI form resubmits
      // `provider` and `model` on every PUT even when unchanged, so a presence
      // check would false-positive every toggle/metadata edit.
      const existing = await getAllowedModel(req.params.id)
      if (!existing) {
        res.status(404).json({ error: 'not_found' })
        return
      }
      const disables = parsed.data.enabled === false
      const renamed =
        (parsed.data.provider !== undefined && parsed.data.provider !== existing.provider) ||
        (parsed.data.model !== undefined && parsed.data.model !== existing.model)
      const oldPairLeavesConfigMap = existing.enabled === true && (disables || renamed)
      // Serialize the mutation only when the gate actually runs: the OLD pair
      // leaves the ConfigMap AND this is not a `?force` override. A metadata edit
      // that keeps the pair in the ConfigMap strands nothing, so it takes no lock
      // and runs on the pool exactly as before (mini-spec §7, item 3).
      const runGate = oldPairLeavesConfigMap && !isForced(req)
      let model
      try {
        model = runGate
          ? await gatedReduce(existing.provider, existing.model, db =>
              updateAllowedModel(req.params.id, parsed.data, actorOf(req), db)
            )
          : await updateAllowedModel(req.params.id, parsed.data, actorOf(req))
      } catch (error) {
        if (sentModelInUse(res, error)) return
        if (handleServiceError(res, error)) return
        throw error
      }
      if (!model) {
        res.status(404).json({ error: 'not_found' })
        return
      }
      if (await materializeOrFail(res)) return
      res.status(200).json(model)
    })
  )

  router.delete(
    '/admin/llm-models/:id',
    asyncHandler(async (req: Request, res: Response) => {
      if (!isValidId(req.params.id)) {
        res.status(404).json({ error: 'not_found' })
        return
      }
      // Read the stored row first so we know the `(provider, model)` whose impact
      // to compute AND can 404 a missing row before any destructive work. A
      // DELETE always removes the model, so the gate runs unconditionally (unless
      // `?force`). This handler now shares the router's `handleServiceError`
      // path for consistency with POST/PUT.
      const existing = await getAllowedModel(req.params.id)
      if (!existing) {
        res.status(404).json({ error: 'not_found' })
        return
      }
      // A DELETE always removes the pair, so the gate runs unconditionally unless
      // `?force`. When it runs, the impact read + the delete are serialized under
      // the per-model-name advisory lock (INV-1); `?force` deletes on the pool
      // without the lock (renounces INV-1, mini-spec §6).
      let deleted
      try {
        deleted = isForced(req)
          ? await deleteAllowedModel(req.params.id, actorOf(req))
          : await gatedReduce(existing.provider, existing.model, db =>
              deleteAllowedModel(req.params.id, actorOf(req), db)
            )
      } catch (error) {
        if (sentModelInUse(res, error)) return
        if (handleServiceError(res, error)) return
        throw error
      }
      if (!deleted) {
        res.status(404).json({ error: 'not_found' })
        return
      }
      if (await materializeOrFail(res)) return
      res.status(204).end()
    })
  )

  return router
}
