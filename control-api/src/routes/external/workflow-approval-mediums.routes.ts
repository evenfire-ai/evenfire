import { Router } from 'express'
import { config } from '../../config.js'
import type { K8sGateway } from '../../k8s.js'
import { createExternalClientRateLimiters } from '../../middleware/externalClientIdentity.js'
import {
  type ExternalAuthedRequest,
  requireValidExternalSessionToken,
} from '../../middleware/externalSessionAuth.js'
import { mcpHostHttpMetrics } from '../../middleware/mcpHostHttpMetrics.js'
import {
  confirmMediumChallenge,
  createMediumChallenge,
} from '../../services/workflowApprovalMediumIdentityService.js'
import { createMediumLinkSession } from '../../services/workflowApprovalMediumLinkSessionService.js'
import {
  listVerifiedMediumAccountsWithPreference,
  preferVerifiedMediumAccount,
  updateVerifiedMediumAccountDisplayName,
} from '../../services/workflowApprovalMediumPreferenceService.js'
import {
  attachSlackTargetsToAccounts,
  listSlackApprovalTargets,
  resolveSlackProviderEventTarget,
} from '../../services/workflowApprovalMediumSlackVerificationService.js'
import {
  attachTeamsTargetsToAccounts,
  listTeamsApprovalTargets,
  resolveTeamsProviderEventTarget,
} from '../../services/workflowApprovalMediumTeamsVerificationService.js'
import {
  attachTelegramTargetsToAccounts,
  disableVerifiedMediumAccountWithTelegramAssociations,
  isTelegramProviderEventChallengeForUser,
} from '../../services/workflowApprovalMediumTelegramProviderEventService.js'
import {
  createTelegramProviderEventChallenge,
  listTelegramApprovalTargets,
} from '../../services/workflowApprovalMediumTelegramVerificationService.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DISPLAY_NAME_MAX_LENGTH = 120

function statusForTargetError(error: string): number {
  if (error === 'invalid_target_id') return 400
  if (error === 'telegram_target_not_found') return 404
  if (error === 'telegram_target_not_ready') return 409
  if (error === 'slack_target_not_found') return 404
  if (error === 'slack_target_not_ready') return 409
  if (error === 'teams_target_not_found') return 404
  if (error === 'teams_target_not_ready') return 409
  return 400
}

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

export function createExternalWorkflowApprovalMediumsRouter(gateway: K8sGateway): Router {
  const router = Router()
  const externalWorkflowApprovalEdgeRateLimits = createExternalClientRateLimiters(
    'workflow-approval-mediums',
    config.approvalRlExternalClientIpPerMin,
    config.approvalRlExternalEdgePerMin
  )

  router.post(
    '/external/workflow-approval-mediums/challenges',
    ...externalWorkflowApprovalEdgeRateLimits,
    mcpHostHttpMetrics('external_workflow_approval_medium_challenge'),
    requireValidExternalSessionToken,
    (req, res, next) => {
      void (async () => {
        try {
          const extReq = req as ExternalAuthedRequest
          const claims = extReq.externalAuth
          if (!claims) return res.status(401).json({ error: 'Unauthorized' })

          const body = req.body ?? {}
          const medium = String(body.medium || '')
            .trim()
            .toLowerCase()
          const targetId = String(body.targetId || '').trim()
          const providerUserId = optionalString(body.providerUserId)
          const providerWorkspaceId = optionalString(body.providerWorkspaceId)
          const providerChannelId = optionalString(body.providerChannelId)
          if (targetId) {
            if (medium !== 'telegram') {
              return res.status(400).json({ error: 'unsupported_medium_target' })
            }
            if (providerUserId || providerWorkspaceId || providerChannelId) {
              return res.status(400).json({ error: 'telegram_provider_identity_not_allowed' })
            }
            const result = await createTelegramProviderEventChallenge({
              gateway,
              userId: claims.userId,
              targetId,
            })
            return res.status(202).json({
              challengeId: result.challengeId,
              expiresAt: result.expiresAt,
              code: result.code,
              target: result.target,
              delivery: { channel: 'telegram-provider-event' },
            })
          }
          if (medium === 'telegram') {
            return res.status(400).json({ error: 'telegram_target_required' })
          }
          if (medium === 'slack') {
            return res.status(400).json({ error: 'slack_target_required' })
          }
          if (medium === 'teams') {
            return res.status(400).json({ error: 'teams_target_required' })
          }
          const result = await createMediumChallenge({
            userId: claims.userId,
            identity: {
              medium,
              providerUserId: providerUserId ?? '',
              providerWorkspaceId,
              providerChannelId,
            },
          })
          return res.status(202).json({
            challengeId: result.id,
            expiresAt: result.expiresAt,
            delivery: { channel: 'first-party-email' },
          })
        } catch (err) {
          if (err instanceof Error && err.message === 'unsupported_medium') {
            return res.status(400).json({ error: 'unsupported_medium' })
          }
          if (err instanceof Error && err.message === 'invalid_provider_user_id') {
            return res.status(400).json({ error: 'invalid_provider_user_id' })
          }
          if (err instanceof Error && err.message.startsWith('telegram_target')) {
            return res.status(statusForTargetError(err.message)).json({ error: err.message })
          }
          if (err instanceof Error && err.message === 'slack_target_required') {
            return res.status(400).json({ error: err.message })
          }
          if (err instanceof Error && err.message === 'teams_target_required') {
            return res.status(400).json({ error: err.message })
          }
          if (err instanceof Error && err.message === 'invalid_target_id') {
            return res.status(400).json({ error: 'invalid_target_id' })
          }
          next(err)
        }
      })()
    }
  )

  router.post(
    '/external/workflow-approval-mediums/link-sessions',
    ...externalWorkflowApprovalEdgeRateLimits,
    mcpHostHttpMetrics('external_workflow_approval_medium_link_session'),
    requireValidExternalSessionToken,
    (req, res, next) => {
      void (async () => {
        try {
          const extReq = req as ExternalAuthedRequest
          const claims = extReq.externalAuth
          if (!claims) return res.status(401).json({ error: 'Unauthorized' })

          const body = req.body ?? {}
          const medium = String(body.medium || '')
            .trim()
            .toLowerCase()
          const targetId = String(body.targetId || '').trim()
          if (medium === 'slack' && targetId) {
            const target = await resolveSlackProviderEventTarget({
              gateway,
              userId: claims.userId,
              targetId,
            })
            const result = await createMediumLinkSession({
              userId: claims.userId,
              medium,
              providerWorkspaceId: target.providerWorkspaceId,
              communicationChannelRef: `${target.channelNamespace}/${target.channelName}`,
            })
            return res.status(202).json({
              linkSessionId: result.id,
              nonce: result.nonce,
              expiresAt: result.expiresAt,
              deepLinkUrl: result.deepLinkUrl,
              target,
            })
          }
          if (medium === 'teams' && targetId) {
            const target = await resolveTeamsProviderEventTarget({
              gateway,
              userId: claims.userId,
              targetId,
            })
            const result = await createMediumLinkSession({
              userId: claims.userId,
              medium,
              providerWorkspaceId: target.providerWorkspaceId,
              communicationChannelRef: `${target.channelNamespace}/${target.channelName}`,
              replyInThreads: body.replyInThreads,
            })
            return res.status(202).json({
              linkSessionId: result.id,
              nonce: result.nonce,
              expiresAt: result.expiresAt,
              deepLinkUrl: result.deepLinkUrl,
              target,
            })
          }
          const result = await createMediumLinkSession({
            userId: claims.userId,
            medium,
            providerWorkspaceId: body.providerWorkspaceId,
          })
          return res.status(202).json({
            linkSessionId: result.id,
            nonce: result.nonce,
            expiresAt: result.expiresAt,
            deepLinkUrl: result.deepLinkUrl,
          })
        } catch (err) {
          if (
            err instanceof Error &&
            (err.message === 'unsupported_medium' ||
              err.message === 'telegram_target_required' ||
              err.message === 'slack_workspace_id_required' ||
              err.message === 'teams_tenant_id_required' ||
              err.message === 'invalid_provider_workspace_id' ||
              err.message === 'reply_in_threads_must_be_boolean' ||
              err.message === 'invalid_target_id' ||
              err.message.startsWith('slack_target') ||
              err.message.startsWith('teams_target'))
          ) {
            return res.status(statusForTargetError(err.message)).json({ error: err.message })
          }
          next(err)
        }
      })()
    }
  )

  router.post(
    '/external/workflow-approval-mediums/challenges/:id/confirm',
    ...externalWorkflowApprovalEdgeRateLimits,
    mcpHostHttpMetrics('external_workflow_approval_medium_confirm'),
    requireValidExternalSessionToken,
    (req, res, next) => {
      void (async () => {
        try {
          const extReq = req as ExternalAuthedRequest
          const claims = extReq.externalAuth
          const challengeId = String(req.params.id || '').trim()
          if (!claims) return res.status(401).json({ error: 'Unauthorized' })
          if (!UUID_RE.test(challengeId)) {
            return res.status(400).json({ error: 'Invalid challenge id format' })
          }

          const code = String(req.body?.code || '').trim()
          if (
            await isTelegramProviderEventChallengeForUser({ challengeId, userId: claims.userId })
          ) {
            return res.status(409).json({ error: 'provider_event_confirmation_required' })
          }
          const result = await confirmMediumChallenge({
            challengeId,
            userId: claims.userId,
            code,
          })
          if (!result.ok) {
            const status =
              result.error === 'challenge_not_found'
                ? 404
                : result.error === 'challenge_expired' ||
                    result.error === 'challenge_consumed' ||
                    result.error === 'too_many_attempts'
                  ? 409
                  : 400
            return res.status(status).json({ error: result.error })
          }
          return res.status(200).json({ ok: true, accountId: result.accountId })
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  router.get(
    '/external/workflow-approval-mediums',
    ...externalWorkflowApprovalEdgeRateLimits,
    mcpHostHttpMetrics('external_workflow_approval_medium_list'),
    requireValidExternalSessionToken,
    (req, res, next) => {
      void (async () => {
        try {
          const extReq = req as ExternalAuthedRequest
          const claims = extReq.externalAuth
          if (!claims) return res.status(401).json({ error: 'Unauthorized' })
          const includeDisabled = String(req.query.includeDisabled || '').trim() === 'true'
          const baseItems = await listVerifiedMediumAccountsWithPreference(claims.userId, {
            includeDisabled,
          })
          const telegramAttached = await attachTelegramTargetsToAccounts(
            gateway,
            claims.userId,
            baseItems
          )
          const slackAttached = await attachSlackTargetsToAccounts(
            gateway,
            claims.userId,
            telegramAttached
          )
          const items = await attachTeamsTargetsToAccounts(gateway, claims.userId, slackAttached)
          return res.status(200).json({ items })
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  router.get(
    '/external/workflow-approval-mediums/targets',
    ...externalWorkflowApprovalEdgeRateLimits,
    mcpHostHttpMetrics('external_workflow_approval_medium_targets'),
    requireValidExternalSessionToken,
    (req, res, next) => {
      void (async () => {
        try {
          const extReq = req as ExternalAuthedRequest
          const claims = extReq.externalAuth
          if (!claims) return res.status(401).json({ error: 'Unauthorized' })
          const [telegramTargets, slackTargets, teamsTargets] = await Promise.all([
            listTelegramApprovalTargets({
              gateway,
              userId: claims.userId,
            }),
            listSlackApprovalTargets({
              gateway,
              userId: claims.userId,
            }),
            listTeamsApprovalTargets({
              gateway,
              userId: claims.userId,
            }),
          ])
          return res.status(200).json({
            items: [...telegramTargets.items, ...slackTargets.items, ...teamsTargets.items],
          })
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  router.put(
    '/external/workflow-approval-mediums/:id/preference',
    ...externalWorkflowApprovalEdgeRateLimits,
    mcpHostHttpMetrics('external_workflow_approval_medium_preference'),
    requireValidExternalSessionToken,
    (req, res, next) => {
      void (async () => {
        try {
          const extReq = req as ExternalAuthedRequest
          const claims = extReq.externalAuth
          const accountId = String(req.params.id || '').trim()
          if (!claims) return res.status(401).json({ error: 'Unauthorized' })
          if (!UUID_RE.test(accountId)) {
            return res.status(400).json({ error: 'Invalid account id format' })
          }
          const account = await preferVerifiedMediumAccount({ userId: claims.userId, accountId })
          if (!account) return res.status(404).json({ error: 'medium_account_not_found' })
          return res.status(200).json({ ok: true, account })
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  router.patch(
    '/external/workflow-approval-mediums/:id/display-name',
    ...externalWorkflowApprovalEdgeRateLimits,
    mcpHostHttpMetrics('external_workflow_approval_medium_display_name'),
    requireValidExternalSessionToken,
    (req, res, next) => {
      void (async () => {
        try {
          const extReq = req as ExternalAuthedRequest
          const claims = extReq.externalAuth
          const accountId = String(req.params.id || '').trim()
          if (!claims) return res.status(401).json({ error: 'Unauthorized' })
          if (!UUID_RE.test(accountId)) {
            return res.status(400).json({ error: 'Invalid account id format' })
          }
          const displayName = displayNameFromBody(req.body ?? {})
          const account = await updateVerifiedMediumAccountDisplayName({
            userId: claims.userId,
            accountId,
            displayName,
          })
          if (!account) return res.status(404).json({ error: 'medium_account_not_found' })
          return res.status(200).json({ ok: true, account })
        } catch (err) {
          if (
            err instanceof Error &&
            (err.message === 'display_name_required' ||
              err.message === 'display_name_must_be_string' ||
              err.message === 'display_name_too_long')
          ) {
            return res.status(400).json({ error: err.message })
          }
          next(err)
        }
      })()
    }
  )

  router.delete(
    '/external/workflow-approval-mediums/:id',
    ...externalWorkflowApprovalEdgeRateLimits,
    mcpHostHttpMetrics('external_workflow_approval_medium_delete'),
    requireValidExternalSessionToken,
    (req, res, next) => {
      void (async () => {
        try {
          const extReq = req as ExternalAuthedRequest
          const claims = extReq.externalAuth
          const accountId = String(req.params.id || '').trim()
          if (!claims) return res.status(401).json({ error: 'Unauthorized' })
          if (!UUID_RE.test(accountId)) {
            return res.status(400).json({ error: 'Invalid account id format' })
          }
          const disabled = await disableVerifiedMediumAccountWithTelegramAssociations({
            gateway,
            userId: claims.userId,
            accountId,
          })
          return res.status(disabled ? 204 : 404).send()
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  return router
}
