import { NextFunction, Response } from 'express'
import { pool } from '../db.js'
import { findMembership } from '../services/directory/membership.js'
import { allowlistCheck } from '../services/userApprovalRequestService.js'
import type { ApprovalStatus } from '../services/userApprovalRequestService.js'
import type { ExternalAuthedRequest } from './externalSessionAuth.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type ApprovalRow = {
  id: string
  status: ApprovalStatus
  target_user_id: string | null
  target_team_id: string | null
  recipe_namespace: string
  recipe_name: string
}

export function requireApprovalDecisionAccess() {
  return async (req: ExternalAuthedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const claims = req.externalAuth
      if (!claims) {
        res.status(401).json({ error: 'Unauthorized' })
        return
      }

      const approvalId = String(req.params?.id || '').trim()
      if (!approvalId) {
        res.status(400).json({ error: 'Missing approval id' })
        return
      }
      if (!UUID_RE.test(approvalId)) {
        res.status(400).json({ error: 'Invalid approval id format' })
        return
      }

      const result = await pool.query(
        `SELECT id, status, target_user_id, target_team_id, recipe_namespace, recipe_name, expires_at
           FROM workflow_approval_requests
          WHERE id = $1`,
        [approvalId]
      )

      if ((result.rowCount ?? 0) === 0) {
        res.status(404).json({ error: 'Not found' })
        return
      }

      const approval = result.rows[0] as ApprovalRow & { expires_at: Date | string }

      if (approval.status === 'pending' && new Date(approval.expires_at) < new Date()) {
        res.status(409).json({ error: 'expired', status: 'expired' })
        return
      }

      if (approval.status !== 'pending') {
        res.status(409).json({ error: 'Not pending', status: approval.status })
        return
      }

      // Defensive allowlist re-check: even though the request was created only
      // after a prior allowlist check, the allowlist may have been edited since
      // then. Re-verify before allowing a decision.
      const allowed = await allowlistCheck(
        approval.recipe_namespace,
        approval.recipe_name,
        approval.target_user_id ?? undefined,
        approval.target_team_id ?? undefined
      )
      if (!allowed) {
        res.status(403).json({ error: 'Target no longer in allowlist' })
        return
      }

      const targetUserId = approval.target_user_id
      const targetTeamId = approval.target_team_id

      if (targetUserId && claims.userId === targetUserId) {
        req.approval = approval
        next()
        return
      }

      if (targetTeamId) {
        const membership = await findMembership(claims.userId, targetTeamId)
        if (membership) {
          req.approval = approval
          next()
          return
        }
      }

      res.status(403).json({ error: 'Forbidden' })
    } catch (err) {
      next(err)
    }
  }
}

declare global {
  namespace Express {
    interface Request {
      approval?: ApprovalRow
    }
  }
}
