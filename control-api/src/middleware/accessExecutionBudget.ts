import type { Response } from 'express'
import {
  AccessExecutionBudget,
  type AccessExecutionKind,
} from '../services/access/accessExecutionBudget.js'
import { configuredCatalogBudgetOptions } from '../services/access/userAccessPolicy.js'
import { type ExternalAuthedRequest } from './externalSessionAuth.js'

export function attachAccessExecutionBudget(
  req: ExternalAuthedRequest,
  res: Response,
  next: () => void
): void {
  const kind: AccessExecutionKind =
    req.method === 'GET' && req.path.endsWith('/catalog') ? 'catalog' : 'action'
  const budget = AccessExecutionBudget.create(
    kind,
    kind === 'catalog' ? configuredCatalogBudgetOptions : undefined
  )
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
