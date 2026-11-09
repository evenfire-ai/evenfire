import type { NextFunction, Request, Response } from 'express'
import { ACTION_CONTEXT_VERSION } from '@clerum/action-context-contracts'
import { resolveEffectiveUserAccessPolicy } from '../services/access/userAccessRuntimePolicy.js'

/**
 * M-39 (and X3 for host wake): the internal action-authority routes resolve
 * the user-access policy per request and answer 409 while the action context
 * is off, before any delegation is parsed or checkpointed. The body is outside
 * the checkpoint wire contract on purpose: every client rejects it as an
 * invalid response, which fails closed.
 */
export async function requireActionContextEnabled(
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  let actionContextV2: boolean
  try {
    actionContextV2 = (await resolveEffectiveUserAccessPolicy()).actionContextV2
  } catch (error) {
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
