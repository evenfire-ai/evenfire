import type { NextFunction, Request, Response } from 'express'
import { ACTION_CONTEXT_VERSION } from '@clerum/action-context-contracts'
import { isAccessExecutionBudgetError } from '../services/access/accessExecutionBudget.js'
import { resolveEffectiveUserAccessPolicy } from '../services/access/userAccessRuntimePolicy.js'
import { requestAccessExecutionBudget } from './accessExecutionBudget.js'

/**
 * M-39 (and X3 for host wake): the internal action-authority routes resolve
 * the user-access policy per request and answer 409 while the action context
 * is off, before any delegation is parsed or checkpointed. The body is outside
 * the checkpoint wire contract on purpose: every client rejects it as an
 * invalid response, which fails closed.
 *
 * The policy read runs under the request's action budget
 * (`attachAccessExecutionBudget` must be mounted first), so the read, the
 * admissions and the checkpoint all end by one deadline. A read the budget
 * ends answers the checkpoint's own retryable 503 `authority_unavailable`.
 */
export async function requireActionContextEnabled(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  let actionContextV2: boolean
  try {
    const budget = requestAccessExecutionBudget(req)
    actionContextV2 = (await resolveEffectiveUserAccessPolicy({ budget })).actionContextV2
  } catch (error) {
    if (isAccessExecutionBudgetError(error)) {
      res.status(503).json({
        version: ACTION_CONTEXT_VERSION,
        status: 'authority_unavailable',
        code: 'authority_unavailable',
        retryable: true,
      })
      return
    }
    next(error)
    return
  }
  if (!actionContextV2) {
    res.status(409).json({
      version: ACTION_CONTEXT_VERSION,
      status: 'conflict',
      code: 'action_context_disabled',
    })
    return
  }
  next()
}
