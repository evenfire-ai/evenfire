import type { NextFunction, Response } from 'express'
import { Router } from 'express'
import { ControlApiError } from '../controlApiClient.js'
import { type AuthedRequest, extractAuthToken, requireAuth } from '../middleware/auth.js'
import {
  confirmWorkflowApprovalMediumChallenge,
  createWorkflowApprovalMediumChallenge,
  createWorkflowApprovalMediumLinkSession,
  disableWorkflowApprovalMedium,
  listApprovalChannelTargets,
  listWorkflowApprovalMediums,
  preferWorkflowApprovalMedium,
} from '../services/workflowApprovalMediumsService.js'

const PROPAGATED_STATUSES = new Set([400, 401, 403, 404, 409, 422])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CODE_RE = /^\d{6}$/

function forwardControlApiError(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof ControlApiError && PROPAGATED_STATUSES.has(error.status)) {
    const body =
      error.body && typeof error.body === 'object' ? error.body : { error: String(error.message) }
    res.status(error.status).json(body)
    return
  }
  next(error)
}

function optionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null
  const normalized = String(value).trim()
  return normalized ? normalized : null
}

export function createWorkflowApprovalMediumsRouter(): Router {
  const router = Router()

  router.post(
    '/workflow-approval-mediums/link-sessions',
    requireAuth,
    async (req: AuthedRequest, res, next) => {
      try {
        const sessionToken = extractAuthToken(req)
        const body = req.body ?? {}
        const medium = String(body.medium || '').trim()
        if (!medium) {
          res.status(400).json({ error: 'medium is required' })
          return
        }
        const result = await createWorkflowApprovalMediumLinkSession(sessionToken, {
          medium,
          providerWorkspaceId: optionalString(body.providerWorkspaceId),
          targetId: optionalString(body.targetId),
        })
        res.status(202).json(result)
      } catch (error) {
        forwardControlApiError(error, res, next)
      }
    }
  )

  router.post(
    '/workflow-approval-mediums/challenges',
    requireAuth,
    async (req: AuthedRequest, res, next) => {
      try {
        const sessionToken = extractAuthToken(req)
        const body = req.body ?? {}
        const medium = String(body.medium || '')
          .trim()
          .toLowerCase()
        const providerUserId = String(body.providerUserId || '').trim()
        const targetId = String(body.targetId || '').trim()
        const providerWorkspaceId = optionalString(body.providerWorkspaceId)
        const providerChannelId = optionalString(body.providerChannelId)

        if (!medium) {
          res.status(400).json({ error: 'medium is required' })
          return
        }
        if (medium === 'telegram' && !targetId) {
          res.status(400).json({ error: 'telegram_target_required' })
          return
        }
        if (
          medium === 'telegram' &&
          targetId &&
          (providerUserId || providerWorkspaceId || providerChannelId)
        ) {
          res.status(400).json({ error: 'telegram_provider_identity_not_allowed' })
          return
        }
        if (!providerUserId && !targetId) {
          res.status(400).json({ error: 'providerUserId is required' })
          return
        }

        const result = await createWorkflowApprovalMediumChallenge(sessionToken, {
          medium,
          ...(providerUserId ? { providerUserId } : {}),
          providerWorkspaceId,
          providerChannelId,
          ...(targetId ? { targetId } : {}),
        })
        res.status(202).json(result)
      } catch (error) {
        forwardControlApiError(error, res, next)
      }
    }
  )

  router.post(
    '/workflow-approval-mediums/challenges/:challengeId/confirm',
    requireAuth,
    async (req: AuthedRequest, res, next) => {
      try {
        const sessionToken = extractAuthToken(req)
        const challengeId = String(req.params.challengeId || '').trim()
        const code = String(req.body?.code || '').trim()

        if (!UUID_RE.test(challengeId)) {
          res.status(400).json({ error: 'Invalid challenge id format' })
          return
        }
        if (!CODE_RE.test(code)) {
          res.status(400).json({ error: 'code must be a 6 digit string' })
          return
        }

        res
          .status(200)
          .json(await confirmWorkflowApprovalMediumChallenge(sessionToken, challengeId, code))
      } catch (error) {
        forwardControlApiError(error, res, next)
      }
    }
  )

  router.get('/workflow-approval-mediums', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      const includeDisabled = String(req.query.includeDisabled || '').trim() === 'true'
      res
        .status(200)
        .json(await listWorkflowApprovalMediums(extractAuthToken(req), { includeDisabled }))
    } catch (error) {
      forwardControlApiError(error, res, next)
    }
  })

  router.get(
    '/workflow-approval-mediums/targets',
    requireAuth,
    async (req: AuthedRequest, res, next) => {
      try {
        res.status(200).json(await listApprovalChannelTargets(extractAuthToken(req)))
      } catch (error) {
        forwardControlApiError(error, res, next)
      }
    }
  )

  router.put(
    '/workflow-approval-mediums/:accountId/preference',
    requireAuth,
    async (req: AuthedRequest, res, next) => {
      try {
        const accountId = String(req.params.accountId || '').trim()
        if (!UUID_RE.test(accountId)) {
          res.status(400).json({ error: 'Invalid account id format' })
          return
        }
        res.status(200).json(await preferWorkflowApprovalMedium(extractAuthToken(req), accountId))
      } catch (error) {
        forwardControlApiError(error, res, next)
      }
    }
  )

  router.delete(
    '/workflow-approval-mediums/:accountId',
    requireAuth,
    async (req: AuthedRequest, res, next) => {
      try {
        const accountId = String(req.params.accountId || '').trim()
        if (!UUID_RE.test(accountId)) {
          res.status(400).json({ error: 'Invalid account id format' })
          return
        }
        await disableWorkflowApprovalMedium(extractAuthToken(req), accountId)
        res.status(204).send()
      } catch (error) {
        forwardControlApiError(error, res, next)
      }
    }
  )

  return router
}
