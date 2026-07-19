import { type Request, type Response, Router } from 'express'
import { z } from 'zod'
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
  updateAllowedModel,
  updateLlmAllowedModelSchema,
} from '../../services/llmAllowedModels.js'
import { getLastCatalogSyncRun, syncDiscoveredModels } from '../../services/llmCatalogSync.js'

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
      let model
      try {
        model = await updateAllowedModel(req.params.id, parsed.data, actorOf(req))
      } catch (error) {
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
      const deleted = await deleteAllowedModel(req.params.id, actorOf(req))
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
