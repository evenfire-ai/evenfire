import type { Response } from 'express'
import { AccessExecutionBudget } from '../services/access/accessExecutionBudget.js'
import { type ExternalAuthedRequest } from './externalSessionAuth.js'

export function attachAccessExecutionBudget(
  req: ExternalAuthedRequest,
  res: Response,
  next: () => void
): void {
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
