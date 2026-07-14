import { type Request, type Response, Router } from 'express'
import { z } from 'zod'
import { asyncHandler } from '../../http/asyncHandler.js'
import { type BudgetRef, findCostBudgetsPinningModel } from '../../services/budgets/index.js'
import {
  LlmPriceConflictError,
  createLlmPrice,
  createLlmPriceSchema,
  deleteLlmPrice,
  getLlmPrice,
  listLlmPrices,
  listUnpricedModels,
  updateLlmPrice,
  updateLlmPriceSchema,
} from '../../services/llmPrices.js'

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
  if (error instanceof LlmPriceConflictError) {
    res.status(409).json({ error: 'conflict', message: error.message })
    return true
  }
  return false
}

// Prevention (b) (§6.1): a cost budget that pins this (provider, model) depends
// on the active price to avoid silently under-counting. Block the delete/disable
// with 409 (leaving the price intact) so the admin removes the budget scope first
// rather than quietly breaking enforcement. Returns true if the response was sent.
function blockIfPriceInUse(res: Response, budgets: BudgetRef[]): boolean {
  if (budgets.length === 0) return false
  res.status(409).json({
    error: 'price_in_use_by_budget',
    message:
      'this price is pinned by one or more cost budgets; remove those budgets (or their model scope) before deleting or disabling it',
    budgets,
  })
  return true
}

export function createAdminLlmPricesRouter(): Router {
  const router = Router()

  router.get(
    '/admin/llm-prices',
    asyncHandler(async (_req: Request, res: Response) => {
      const rows = await listLlmPrices()
      res.status(200).json({ rows })
    })
  )

  // Static segment must be registered before `/:id` so it isn't swallowed.
  router.get(
    '/admin/llm-prices/unpriced',
    asyncHandler(async (_req: Request, res: Response) => {
      const rows = await listUnpricedModels()
      res.status(200).json({ rows })
    })
  )

  router.get(
    '/admin/llm-prices/:id',
    asyncHandler(async (req: Request, res: Response) => {
      if (!isValidId(req.params.id)) {
        res.status(404).json({ error: 'not_found' })
        return
      }
      const price = await getLlmPrice(req.params.id)
      if (!price) {
        res.status(404).json({ error: 'not_found' })
        return
      }
      res.status(200).json(price)
    })
  )

  router.post(
    '/admin/llm-prices',
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = createLlmPriceSchema.safeParse(req.body)
      if (!parsed.success) {
        sendZodError(res, parsed.error)
        return
      }
      try {
        const price = await createLlmPrice(parsed.data)
        res.status(201).json(price)
      } catch (error) {
        if (handleServiceError(res, error)) return
        throw error
      }
    })
  )

  router.put(
    '/admin/llm-prices/:id',
    asyncHandler(async (req: Request, res: Response) => {
      if (!isValidId(req.params.id)) {
        res.status(404).json({ error: 'not_found' })
        return
      }
      const parsed = updateLlmPriceSchema.safeParse(req.body)
      if (!parsed.success) {
        sendZodError(res, parsed.error)
        return
      }
      // Prevention (b): a PUT that removes an active price from the cost-budget
      // JOIN must be guarded exactly like a delete. Two ways it can happen:
      //   - enabled:false           → the price stops being active
      //   - re-key provider/model   → the OLD (provider, model) budgets pinned
      //                               no longer resolves to this price
      // A PUT that only changes amounts/currency (or re-sets the same key) keeps
      // the active pair intact and needs no guard. We always check the OLD key
      // (existing.provider/model) — that's what cost budgets pinned.
      const touchesActiveKey =
        parsed.data.enabled === false ||
        parsed.data.provider !== undefined ||
        parsed.data.model !== undefined
      if (touchesActiveKey) {
        const existing = await getLlmPrice(req.params.id)
        if (!existing) {
          res.status(404).json({ error: 'not_found' })
          return
        }
        const disables = parsed.data.enabled === false
        const reKeyed =
          (parsed.data.provider !== undefined && parsed.data.provider !== existing.provider) ||
          (parsed.data.model !== undefined && parsed.data.model !== existing.model)
        // Only an active price is pinned; only block when the price actually
        // stops backing the OLD key (disable or a real key move). A no-op re-set
        // of the same provider/model must NOT 409.
        if (existing.enabled && (disables || reKeyed)) {
          const budgets = await findCostBudgetsPinningModel(existing.provider, existing.model)
          if (blockIfPriceInUse(res, budgets)) return
        }
      }
      try {
        const price = await updateLlmPrice(req.params.id, parsed.data)
        if (!price) {
          res.status(404).json({ error: 'not_found' })
          return
        }
        res.status(200).json(price)
      } catch (error) {
        if (handleServiceError(res, error)) return
        throw error
      }
    })
  )

  router.delete(
    '/admin/llm-prices/:id',
    asyncHandler(async (req: Request, res: Response) => {
      if (!isValidId(req.params.id)) {
        res.status(404).json({ error: 'not_found' })
        return
      }
      // Look up the (provider, model) first so we can block the delete when a
      // cost budget still pins this price (prevention (b)). A missing row 404s.
      const existing = await getLlmPrice(req.params.id)
      if (!existing) {
        res.status(404).json({ error: 'not_found' })
        return
      }
      if (existing.enabled) {
        const budgets = await findCostBudgetsPinningModel(existing.provider, existing.model)
        if (blockIfPriceInUse(res, budgets)) return
      }
      const deleted = await deleteLlmPrice(req.params.id)
      if (!deleted) {
        res.status(404).json({ error: 'not_found' })
        return
      }
      res.status(204).end()
    })
  )

  return router
}
