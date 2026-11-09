import type { Request, Response } from 'express'
import { AccessExecutionBudget } from '../services/access/accessExecutionBudget.js'

declare global {
  namespace Express {
    interface Request {
      /**
       * The one action budget of this request, attached by
       * `attachAccessExecutionBudget` before any authority step. Every step
       * (the policy read, the admissions, the checkpoint) runs under it, so
       * the whole authority prefix ends by its deadline.
       */
      accessExecutionBudget?: AccessExecutionBudget
    }
  }
}

export function attachAccessExecutionBudget(req: Request, res: Response, next: () => void): void {
  const budget = AccessExecutionBudget.create('action')
  req.accessExecutionBudget = budget
  let settled = false
  const detach = () => {
    req.removeListener('aborted', onAborted)
    res.removeListener('finish', onFinished)
    res.removeListener('close', onClosed)
  }
  const onAborted = () => budget.cancel()
  const onFinished = () => {
    if (settled) return
    settled = true
    detach()
    budget.close()
  }
  const onClosed = () => {
    if (settled) return
    settled = true
    if (!res.writableEnded) budget.cancel()
    detach()
    budget.close()
  }
  req.once('aborted', onAborted)
  res.once('finish', onFinished)
  res.once('close', onClosed)
  next()
}

/**
 * The request's action budget. A route that reaches an authority step without
 * `attachAccessExecutionBudget` mounted before it is a wiring defect, so this
 * throws instead of creating a budget the deadline would not cover.
 */
export function requestAccessExecutionBudget(req: Request): AccessExecutionBudget {
  const budget = req.accessExecutionBudget
  if (!budget) throw new Error('access_execution_budget_not_attached')
  return budget
}
