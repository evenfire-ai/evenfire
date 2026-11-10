import type { NextFunction, Response } from 'express'
import { Router } from 'express'
import { type AuthedRequest, extractAuthToken, requireAuth } from '../middleware/auth.js'
import {
  confirmWorkflowApprovalMediumChallenge,
  createWorkflowApprovalMediumChallenge,
  createWorkflowApprovalMediumLinkSession,
  disableWorkflowApprovalMedium,
  listApprovalChannelTargets,
  listWorkflowApprovalMediums,
  preferWorkflowApprovalMedium,
  updateWorkflowApprovalMediumDisplayName,
} from '../services/workflowApprovalMediumsService.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CODE_RE = /^\d{6}$/
const DISPLAY_NAME_MAX_LENGTH = 120

function optionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null
  const normalized = String(value).trim()
  return normalized ? normalized : null
}

function displayNameFromBody(body: unknown): string | null {
  const value =
    body && typeof body === 'object' && 'displayName' in body
      ? (body as { displayName?: unknown }).displayName
      : undefined
  if (value === undefined) throw new Error('display_name_required')
  if (value === null) return null
  if (typeof value !== 'string') throw new Error('display_name_must_be_string')
  const normalized = value.trim()
  if (normalized.length > DISPLAY_NAME_MAX_LENGTH) throw new Error('display_name_too_long')
  return normalized || null
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
        next(error)
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
        next(error)
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
        next(error)
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
      next(error)
    }
  })

  router.get(
    '/workflow-approval-mediums/targets',
    requireAuth,
    async (req: AuthedRequest, res, next) => {
      try {
        res.status(200).json(await listApprovalChannelTargets(extractAuthToken(req)))
      } catch (error) {
        next(error)
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
        next(error)
      }
    }
  )

  router.patch(
    '/workflow-approval-mediums/:accountId/display-name',
    requireAuth,
    async (req: AuthedRequest, res, next) => {
      try {
        const accountId = String(req.params.accountId || '').trim()
        if (!UUID_RE.test(accountId)) {
          res.status(400).json({ error: 'Invalid account id format' })
          return
        }
        const displayName = displayNameFromBody(req.body ?? {})
        res
          .status(200)
          .json(
            await updateWorkflowApprovalMediumDisplayName(
              extractAuthToken(req),
              accountId,
              displayName
            )
          )
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message === 'display_name_required' ||
            error.message === 'display_name_must_be_string' ||
            error.message === 'display_name_too_long')
        ) {
          res.status(400).json({ error: error.message })
          return
        }
        next(error)
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
        next(error)
      }
    }
  )

  return router
}
