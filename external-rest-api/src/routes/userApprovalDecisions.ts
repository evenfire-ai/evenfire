import type { NextFunction, Response } from 'express'
import { Router } from 'express'
import { publicCorrelationId, sanitizeControlApiPublicError } from '../http/publicApiError.js'
import { type AuthedRequest, extractAuthToken, requireAuth } from '../middleware/auth.js'
import {
  decideUserApprovalDecision,
  listPendingUserApprovalDecisions,
} from '../services/userApprovalDecisionsService.js'
import {
  WorkflowActionDelegationTransportError,
  workflowActionDelegationForRequest,
} from '../workflowActionDelegation.js'

const PROPAGATED_STATUSES = new Set([400, 403, 404, 409, 410, 422])

function forwardControlApiError(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof WorkflowActionDelegationTransportError) {
    res.status(400).json({ error: 'invalid_action_delegation' })
    return
  }
  const sanitized = sanitizeControlApiPublicError(
    error,
    PROPAGATED_STATUSES,
    publicCorrelationId(res.req)
  )
  if (sanitized) {
    res.status(sanitized.status).json(sanitized.body)
    return
  }
  next(error)
}

export function createUserApprovalDecisionsRouter(): Router {
  const router = Router()

  router.get('/workflow-approvals', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      const sessionToken = extractAuthToken(req)
      const rawLimit = String(req.query?.limit || '').trim()
      const parsedLimit = rawLimit ? Number(rawLimit) : 20
      if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) {
        res.status(400).json({ error: 'limit must be a positive number' })
        return
      }
      res.status(200).json(await listPendingUserApprovalDecisions(sessionToken, parsedLimit))
    } catch (error) {
      forwardControlApiError(error, res, next)
    }
  })

  router.post(
    '/workflow-approvals/:approvalId/decide',
    requireAuth,
    async (req: AuthedRequest, res, next) => {
      try {
        const approvalId = String(req.params.approvalId || '').trim()
        if (!approvalId) {
          res.status(400).json({ error: 'approvalId is required' })
          return
        }

        const { decision, note } = req.body ?? {}
        if (decision !== 'approve' && decision !== 'deny') {
          res.status(400).json({ error: "decision must be 'approve' or 'deny'" })
          return
        }
        if (note && String(note).length > 1000) {
          res.status(400).json({ error: 'note exceeds maximum length of 1000 characters' })
          return
        }

        const sessionToken = extractAuthToken(req)
        const actionDelegation = workflowActionDelegationForRequest(req)
        const result = actionDelegation
          ? await decideUserApprovalDecision(
              sessionToken,
              approvalId,
              decision,
              note,
              actionDelegation
            )
          : await decideUserApprovalDecision(sessionToken, approvalId, decision, note)
        res.status(200).json(result)
      } catch (error) {
        forwardControlApiError(error, res, next)
      }
    }
  )

  return router
}
