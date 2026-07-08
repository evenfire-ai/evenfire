import { type Request, type Response, Router } from 'express'
import { z } from 'zod'
import { asyncHandler } from '../../http/asyncHandler.js'
import {
  BudgetUnpricedModelsError,
  BudgetValidationError,
  createBudget,
  createBudgetSchema,
  deleteBudget,
  getBudget,
  listBudgets,
  setBudgetEnabled,
  toggleBudgetSchema,
  updateBudget,
  updateBudgetSchema,
  withSpend,
} from '../../services/budgets/index.js'

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
  if (error instanceof BudgetUnpricedModelsError) {
    res.status(400).json({ error: 'unpriced_models', message: error.message, models: error.models })
    return true
  }
  if (error instanceof BudgetValidationError) {
    res.status(400).json({ error: 'invalid_request', message: error.message })
    return true
  }
  return false
}

export function createAdminBudgetsRouter(): Router {
  const router = Router()

  // List with live spent/remaining (observation mode progress bars — §4.2, §6.2).
  router.get(
    '/admin/budgets',
    asyncHandler(async (_req: Request, res: Response) => {
      const budgets = await listBudgets()
      // One spend query per budget. Fine for an admin panel (few rows, low
      // frequency); revisit with a single aggregated query if the list grows.
      const rows = await Promise.all(budgets.map(b => withSpend(b)))
      res.status(200).json({ rows })
    })
  )

  router.get(
    '/admin/budgets/:id',
    asyncHandler(async (req: Request, res: Response) => {
      if (!isValidId(req.params.id)) {
        res.status(404).json({ error: 'not_found' })
        return
      }
      const budget = await getBudget(req.params.id)
      if (!budget) {
        res.status(404).json({ error: 'not_found' })
        return
      }
      res.status(200).json(await withSpend(budget))
    })
  )

  router.post(
    '/admin/budgets',
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = createBudgetSchema.safeParse(req.body)
      if (!parsed.success) {
        sendZodError(res, parsed.error)
        return
      }
      try {
        const budget = await createBudget(parsed.data)
        res.status(201).json(budget)
      } catch (error) {
        if (handleServiceError(res, error)) return
        throw error
      }
    })
  )

  router.put(
    '/admin/budgets/:id',
    asyncHandler(async (req: Request, res: Response) => {
      if (!isValidId(req.params.id)) {
        res.status(404).json({ error: 'not_found' })
        return
      }
      const parsed = updateBudgetSchema.safeParse(req.body)
      if (!parsed.success) {
        sendZodError(res, parsed.error)
        return
      }
      try {
        const budget = await updateBudget(req.params.id, parsed.data)
        if (!budget) {
          res.status(404).json({ error: 'not_found' })
          return
        }
        res.status(200).json(budget)
      } catch (error) {
        if (handleServiceError(res, error)) return
        throw error
      }
    })
  )

  // Quick enabled toggle (§4.2 optional PATCH).
  router.patch(
    '/admin/budgets/:id',
    asyncHandler(async (req: Request, res: Response) => {
      if (!isValidId(req.params.id)) {
        res.status(404).json({ error: 'not_found' })
        return
      }
      const parsed = toggleBudgetSchema.safeParse(req.body)
      if (!parsed.success) {
        sendZodError(res, parsed.error)
        return
      }
      const budget = await setBudgetEnabled(req.params.id, parsed.data.enabled)
      if (!budget) {
        res.status(404).json({ error: 'not_found' })
        return
      }
      res.status(200).json(budget)
    })
  )

  router.delete(
    '/admin/budgets/:id',
    asyncHandler(async (req: Request, res: Response) => {
      if (!isValidId(req.params.id)) {
        res.status(404).json({ error: 'not_found' })
        return
      }
      const deleted = await deleteBudget(req.params.id)
      if (!deleted) {
        res.status(404).json({ error: 'not_found' })
        return
      }
      res.status(204).end()
    })
  )

  return router
}
