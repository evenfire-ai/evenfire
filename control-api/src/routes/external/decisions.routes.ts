import { NextFunction, Request, Response, Router } from 'express'
import { config } from '../../config.js'
import { requireApprovalDecisionAccess } from '../../middleware/approvalDecisionAccess.js'
import { createExternalClientRateLimiters } from '../../middleware/externalClientIdentity.js'
import { requireValidExternalSessionToken } from '../../middleware/externalSessionAuth.js'
import type { ExternalAuthedRequest } from '../../middleware/externalSessionAuth.js'
import { mcpHostHttpMetrics } from '../../middleware/mcpHostHttpMetrics.js'
import { rateLimitMiddleware } from '../../middleware/rateLimitMiddleware.js'
import {
  ApprovalConsumeError,
  ApprovalTriggerRunIdempotencyConflictError,
  listPendingApprovalsForUser,
  recordDecision,
} from '../../services/userApprovalRequestService.js'
import { mapDbRun } from '../../services/workflows/workflowRunReadService.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function requireValidApprovalIdParam(req: Request, res: Response, next: NextFunction): void {
  const approvalId = String(req.params?.id || '').trim()
  if (!UUID_RE.test(approvalId)) {
    res.status(400).json({ error: 'Invalid approval id format' })
    return
  }
  next()
}

/**
 * Derive client IP from the request — trusts the first hop only. Express
 * `req.ip` handles X-Forwarded-For when `trust proxy` is configured; if not
 * configured (dev), falls back to `req.socket.remoteAddress`. We store this
 * verbatim for audit — callers with a real proxy chain must configure
 * `app.set('trust proxy', ...)` to avoid storing the proxy IP.
 */
function clientIp(req: Request): string | null {
  const ip = req.ip ?? req.socket?.remoteAddress ?? null
  return ip ? String(ip).slice(0, 128) : null
}

function userAgent(req: Request): string | null {
  const ua = req.header('user-agent')
  return ua ? ua.slice(0, 512) : null
}

export function createExternalUserApprovalDecisionsRouter(): Router {
  const router = Router()
  const externalApprovalEdgeRateLimits = createExternalClientRateLimiters(
    'workflow-approvals',
    config.approvalRlExternalClientIpPerMin,
    config.approvalRlExternalEdgePerMin
  )

  router.get(
    '/external/workflow-approvals/pending',
    ...externalApprovalEdgeRateLimits,
    mcpHostHttpMetrics('external_user_approval_requests_pending'),
    requireValidExternalSessionToken,
    rateLimitMiddleware({
      bucketType: 'external_user',
      maxPerMinute: config.approvalRlExternalPerMin,
      getBucketKey: req => {
        const extReq = req as ExternalAuthedRequest
        const uid = extReq.externalAuth?.userId
        return uid ? `user:${uid}` : null
      },
    }),
    (req, res, next) => {
      void (async () => {
        try {
          const extReq = req as ExternalAuthedRequest
          const claims = extReq.externalAuth
          if (!claims) {
            return res.status(401).json({ error: 'Unauthorized' })
          }

          const rawLimit = String(req.query?.limit || '').trim()
          const parsedLimit = rawLimit ? Number(rawLimit) : 20
          if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) {
            return res.status(400).json({ error: 'limit must be a positive number' })
          }

          const items = await listPendingApprovalsForUser(claims.userId, parsedLimit)
          return res.status(200).json({ items })
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  router.post(
    '/external/workflow-approvals/:id/decide',
    ...externalApprovalEdgeRateLimits,
    mcpHostHttpMetrics('external_user_approval_requests_decide'),
    requireValidExternalSessionToken,
    requireValidApprovalIdParam,
    rateLimitMiddleware({
      bucketType: 'external_user',
      maxPerMinute: config.approvalRlExternalPerMin,
      getBucketKey: req => {
        const extReq = req as ExternalAuthedRequest
        const uid = extReq.externalAuth?.userId
        return uid ? `user:${uid}` : null
      },
    }),
    requireApprovalDecisionAccess(),
    (req, res, next) => {
      void (async () => {
        try {
          const extReq = req as ExternalAuthedRequest
          const claims = extReq.externalAuth
          const approval = extReq.approval!

          const { decision, note } = req.body ?? {}
          if (!decision || (decision !== 'approve' && decision !== 'deny')) {
            return res.status(400).json({ error: "decision must be 'approve' or 'deny'" })
          }

          if (note && String(note).length > 1000) {
            return res.status(400).json({ error: 'note exceeds maximum length of 1000 characters' })
          }

          const result = await recordDecision(
            approval.id,
            decision,
            {
              userId: claims!.userId,
              ...(approval.target_team_id ? { teamId: approval.target_team_id } : {}),
            },
            note,
            {
              clientIp: clientIp(req),
              userAgent: userAgent(req),
              correlationId: req.correlationId ?? null,
            }
          )

          if (!result.ok) {
            const status = result.error === 'not_found' ? 404 : 409
            return res.status(status).json({ error: result.error })
          }

          return res.status(200).json({
            ok: true,
            ...(result.workflowRun ? { run: mapDbRun(result.workflowRun.row) } : {}),
          })
        } catch (err) {
          if (err instanceof ApprovalConsumeError) {
            const status =
              err.code === 'approval_expired' || err.code === 'approval_status_not_consumable'
                ? 409
                : err.code === 'approval_request_not_found'
                  ? 404
                  : 403
            return res.status(status).json({
              error: err.code,
              ...(err.approvalStatus ? { approvalStatus: err.approvalStatus } : {}),
            })
          }
          if (err instanceof ApprovalTriggerRunIdempotencyConflictError) {
            return res.status(409).json({ error: 'idempotency_key_payload_mismatch' })
          }
          next(err)
        }
      })()
    }
  )

  return router
}
