import { type Request, type Response, Router } from 'express'
import { config } from '../../config.js'
import type { K8sGateway } from '../../k8s.js'
import { mcpHostHttpMetrics } from '../../middleware/mcpHostHttpMetrics.js'
import { requireMcpHostJwt } from '../../middleware/mcpHostJwtAuth.js'
import { rateLimitMiddleware } from '../../middleware/rateLimitMiddleware.js'
import { rateLimitHitsTotal } from '../../observability/metrics.js'
import {
  acknowledgeNotificationDelivery,
  claimNotificationDeliveries,
  failNotificationDelivery,
  resolvePendingWorkflowApprovalDelivery,
} from '../../services/notificationDeliveryQueueService.js'
import { checkAndIncrement } from '../../services/rateLimiterService.js'
import {
  InvalidWorkflowTriggerIntentError,
  allowlistCheck,
  cancelRequest,
  createApprovalRequest,
  getApprovalRecipeBinding,
  getStatus,
  parseWorkflowTriggerIntent,
  triggerGrantCheck,
} from '../../services/userApprovalRequestService.js'
import { confirmMediumLinkSessionFromReader } from '../../services/workflowApprovalMediumLinkSessionService.js'
import {
  type ProviderTargetBindingInput,
  findVerifiedOperationalMediumAccount,
} from '../../services/workflowApprovalMediumOperationalIdentityService.js'
import {
  addSlackTargetAssociation,
  resolveSlackCommunicationChannelTarget,
  userCanAccessSlackCommunicationChannel,
} from '../../services/workflowApprovalMediumSlackVerificationService.js'
import {
  addTeamsTargetAssociation,
  resolveTeamsCommunicationChannelTarget,
} from '../../services/workflowApprovalMediumTeamsVerificationService.js'
import { confirmTelegramProviderEventChallenge } from '../../services/workflowApprovalMediumTelegramProviderEventService.js'
import { userCanAccessTelegramCommunicationChannel } from '../../services/workflowApprovalMediumTelegramVerificationService.js'
import { recordProviderApprovalDecision } from '../../services/workflowApprovalProviderDecisionService.js'
import { verifyTelegramOperationalChannelBinding } from '../../services/workflowApprovalTelegramChannelGateService.js'
import type { TriggerBody } from '../../services/workflows/types.js'
import { createWorkflowTriggerApprovalRequest } from '../../services/workflows/workflowTriggerApprovalService.js'
import {
  WorkflowTriggerHttpError,
  validateMcpHostWorkflowTriggerApprovalRunIntent,
} from '../../services/workflows/workflowTriggerService.js'
import { type McpHostAccessClaims, getMcpHostCallerKey } from '../../utils/auth/mcpHostJwtToken.js'
import {
  requireMcpHostControlScope,
  requireMcpHostControlWorkflowCaller,
} from '../workflows/shared/auth.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PROVIDER_IDENTITY_PART_MAX = 256
const WORKFLOW_TRIGGER_RUN_INTENT_MAX_BYTES = 64 * 1024

type ParsedWorkflowTriggerRunIntent =
  | { ok: true; body: TriggerBody | null }
  | { ok: false; status: number; error: string }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function parseOptionalObjectField(
  record: Record<string, unknown>,
  key: string
): { ok: true; value?: Record<string, unknown> } | { ok: false; error: string } {
  const value = record[key]
  if (value === undefined || value === null) return { ok: true }
  if (!isPlainObject(value)) return { ok: false, error: `${key} must be an object` }
  return { ok: true, value }
}

function parseWorkflowTriggerRunIntent(value: unknown): ParsedWorkflowTriggerRunIntent {
  if (value === undefined || value === null) return { ok: true, body: null }
  if (!isPlainObject(value)) {
    return { ok: false, status: 400, error: 'workflowTriggerRunIntent must be an object' }
  }
  if (JSON.stringify(value).length > WORKFLOW_TRIGGER_RUN_INTENT_MAX_BYTES) {
    return { ok: false, status: 400, error: 'workflowTriggerRunIntent exceeds maximum size' }
  }

  const allowedKeys = new Set(['inputs', 'intermediateParameters', 'outputOverrides'])
  const unknownKey = Object.keys(value).find(key => !allowedKeys.has(key))
  if (unknownKey) {
    return {
      ok: false,
      status: 400,
      error: 'workflowTriggerRunIntent contains unrecognized fields',
    }
  }

  const inputs = parseOptionalObjectField(value, 'inputs')
  if (!inputs.ok) return { ok: false, status: 400, error: inputs.error }
  const intermediateParameters = parseOptionalObjectField(value, 'intermediateParameters')
  if (!intermediateParameters.ok) {
    return { ok: false, status: 400, error: intermediateParameters.error }
  }
  const outputOverrides = parseOptionalObjectField(value, 'outputOverrides')
  if (!outputOverrides.ok) return { ok: false, status: 400, error: outputOverrides.error }

  return {
    ok: true,
    body: {
      ...(inputs.value ? { inputs: inputs.value } : {}),
      ...(intermediateParameters.value
        ? { intermediateParameters: intermediateParameters.value }
        : {}),
      ...(outputOverrides.value ? { outputOverrides: outputOverrides.value } : {}),
    },
  }
}

function isProviderIdentityPartTooLong(value: string | null): boolean {
  return value !== null && value.trim().length > PROVIDER_IDENTITY_PART_MAX
}

function providerChannelIds(query: unknown): string[] {
  if (Array.isArray(query)) {
    return query
      .flatMap(value => String(value).split(','))
      .map(value => value.trim())
      .filter(Boolean)
  }
  if (typeof query === 'string') {
    return query
      .split(',')
      .map(value => value.trim())
      .filter(Boolean)
  }
  return []
}

function singleQueryString(query: unknown): string | null {
  if (Array.isArray(query)) {
    const first = query.find(value => String(value).trim())
    return first === undefined ? null : String(first).trim()
  }
  return typeof query === 'string' && query.trim() ? query.trim() : null
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function requestBodyRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {}
}

function isDeliveryAuthInputError(err: unknown): err is Error {
  return (
    err instanceof Error &&
    (err.message === 'unsupported_notification_medium' ||
      err.message === 'provider_channel_id_required' ||
      err.message === 'provider_channel_id_limit_exceeded' ||
      err.message === 'provider_user_id_required' ||
      err.message === 'provider_workspace_id_required' ||
      err.message === 'host_ref_required' ||
      err.message === 'recipe_name_required')
  )
}

function statusForProviderEventError(error: string): number {
  switch (error) {
    case 'invalid_code':
    case 'invalid_provider_identity':
    case 'invalid_receiver_identity':
      return 400
    case 'challenge_not_found':
    case 'telegram_target_not_found':
      return 404
    case 'challenge_expired':
    case 'challenge_consumed':
    case 'too_many_attempts':
    case 'ambiguous_code':
    case 'telegram_target_not_ready':
    case 'telegram_identity_already_verified':
      return 409
    default:
      return 400
  }
}

function providerIdentityString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function parseProviderTarget(value: unknown): ProviderTargetBindingInput | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const target = {
    hostRef: providerIdentityString(record, 'hostRef'),
    communicationChannelNamespace: providerIdentityString(record, 'communicationChannelNamespace'),
    communicationChannelName: providerIdentityString(record, 'communicationChannelName'),
    providerBotId: providerIdentityString(record, 'providerBotId'),
    providerBotUsername: providerIdentityString(record, 'providerBotUsername'),
    // Figure D: the reader propagates the provider action channelAlias here
    // (providerTarget.communicationChannelAlias). It is the ONLY providerTarget
    // field a Figure D telegram decision carries, so it MUST be parsed —
    // otherwise the authoritative D1 STRICT binding (resolveChannelRefByAlias)
    // never resolves and every Figure D approval fails medium_identity_not_verified.
    communicationChannelAlias: providerIdentityString(record, 'communicationChannelAlias'),
  }
  if (!Object.values(target).some(Boolean)) return null
  return {
    ...(target.communicationChannelAlias
      ? { communicationChannelAlias: target.communicationChannelAlias }
      : {}),
    ...(target.hostRef ? { hostRef: target.hostRef } : {}),
    ...(target.communicationChannelNamespace
      ? { communicationChannelNamespace: target.communicationChannelNamespace }
      : {}),
    ...(target.communicationChannelName
      ? { communicationChannelName: target.communicationChannelName }
      : {}),
    ...(target.providerBotId ? { providerBotId: target.providerBotId } : {}),
    ...(target.providerBotUsername ? { providerBotUsername: target.providerBotUsername } : {}),
  }
}

function isProviderTargetTooLong(target: ProviderTargetBindingInput | null): boolean {
  return Object.values(target ?? {}).some(
    value => typeof value === 'string' && isProviderIdentityPartTooLong(value)
  )
}

type ProviderIdentityParts = {
  medium: string
  providerUserId: string
  providerWorkspaceId: string | null
  providerChannelId: string | null
  providerChannelType: string | null
  providerEventId: string | null
  providerTarget: ProviderTargetBindingInput | null
}

function parseProviderIdentityFromBody(
  body: unknown,
  options: { requireEventId?: boolean } = {}
): { ok: true; identity: ProviderIdentityParts } | { ok: false; status: number; error: string } {
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  const providerIdentity = record.providerIdentity
  if (!providerIdentity || typeof providerIdentity !== 'object') {
    return { ok: false, status: 400, error: 'providerIdentity is required' }
  }

  const identity = providerIdentity as Record<string, unknown>
  const medium = typeof identity.medium === 'string' ? identity.medium : ''
  const providerUserId = typeof identity.providerUserId === 'string' ? identity.providerUserId : ''
  const providerWorkspaceId =
    typeof identity.providerWorkspaceId === 'string' ? identity.providerWorkspaceId : null
  const providerChannelId =
    typeof identity.providerChannelId === 'string' ? identity.providerChannelId : null
  const providerChannelType =
    typeof identity.providerChannelType === 'string' ? identity.providerChannelType : null
  const providerTarget = parseProviderTarget(identity.providerTarget)
  const providerEventId =
    typeof identity.providerEventId === 'string' ? identity.providerEventId : null

  if (!providerUserId.trim() || (options.requireEventId && !providerEventId?.trim())) {
    return {
      ok: false,
      status: 400,
      error: options.requireEventId
        ? 'provider identity user and event are required'
        : 'provider identity user is required',
    }
  }
  if (
    isProviderIdentityPartTooLong(providerUserId) ||
    isProviderIdentityPartTooLong(providerWorkspaceId) ||
    isProviderIdentityPartTooLong(providerChannelId) ||
    isProviderIdentityPartTooLong(providerChannelType) ||
    isProviderTargetTooLong(providerTarget)
  ) {
    return { ok: false, status: 400, error: 'provider identity exceeds maximum length' }
  }
  if ((medium === 'slack' || medium === 'teams') && !providerWorkspaceId?.trim()) {
    return {
      ok: false,
      status: 400,
      error:
        medium === 'teams'
          ? 'teams tenant identity is required'
          : 'slack workspace identity is required',
    }
  }
  if (!providerChannelId?.trim()) {
    return { ok: false, status: 400, error: 'provider channel identity is required' }
  }

  return {
    ok: true,
    identity: {
      medium,
      providerUserId,
      providerWorkspaceId,
      providerChannelId,
      providerChannelType,
      providerEventId,
      providerTarget,
    },
  }
}

function isWorkflowTriggerApprovalForCaller(
  claims: Pick<McpHostAccessClaims, 'recipeNamespace' | 'recipeName' | 'sub' | 'hostRefs'>,
  expected: { recipeNamespace: string; recipeName: string },
  payload: unknown
): boolean {
  const trigger = parseWorkflowTriggerIntent(payload)
  const callerKey = getMcpHostCallerKey(claims)
  return (
    expected.recipeNamespace === config.sandboxNamespace &&
    trigger?.namespace === expected.recipeNamespace &&
    trigger.name === expected.recipeName &&
    trigger.caller === callerKey
  )
}

function canCreateApprovalForRecipe(
  claims: Pick<McpHostAccessClaims, 'recipeNamespace' | 'recipeName' | 'sub' | 'hostRefs'>,
  expected: { recipeNamespace: string; recipeName: string },
  payload: unknown
): boolean {
  if (
    claims.recipeNamespace === expected.recipeNamespace &&
    claims.recipeName === expected.recipeName
  ) {
    return true
  }

  return isWorkflowTriggerApprovalForCaller(claims, expected, payload)
}

function canAccessApprovalBinding(
  claims: Pick<McpHostAccessClaims, 'recipeNamespace' | 'recipeName' | 'sub' | 'hostRefs'>,
  binding: {
    recipeNamespace: string
    recipeName: string
    triggerNamespace?: string | null
    triggerName?: string | null
    triggerCaller?: string | null
  }
): boolean {
  if (
    claims.recipeNamespace === binding.recipeNamespace &&
    claims.recipeName === binding.recipeName
  ) {
    return true
  }
  const callerKey = getMcpHostCallerKey(claims)
  return (
    binding.recipeNamespace === config.sandboxNamespace &&
    binding.triggerNamespace === binding.recipeNamespace &&
    binding.triggerName === binding.recipeName &&
    binding.triggerCaller === callerKey
  )
}

function classifyMcpHostCaller(
  callerKey: string
): 'sandbox-workflow-recipe' | 'first-party-mcp-host' {
  return callerKey.startsWith(`${config.sandboxNamespace}/`)
    ? 'sandbox-workflow-recipe'
    : 'first-party-mcp-host'
}

async function enforceMediumResolveRateLimit(
  req: Request,
  res: Response,
  callerKey: string
): Promise<boolean> {
  const bucketType = 'mcp_host_workflow_approval_medium_resolve'
  const bucketKey = `medium-resolve:${callerKey}`
  const result = await checkAndIncrement(bucketKey, config.approvalRlRequestPerMin)
  if (!result.allowed) {
    rateLimitHitsTotal.inc({ bucket_type: bucketType, result: 'denied' }, 1)
    const retryAfterSec = Math.max(1, Math.ceil((result.resetMs - Date.now()) / 1000))
    res.setHeader('Retry-After', String(retryAfterSec))
    res.setHeader('X-RateLimit-Limit', String(config.approvalRlRequestPerMin))
    res.setHeader('X-RateLimit-Remaining', '0')
    res.setHeader('X-RateLimit-Reset', String(Math.floor(result.resetMs / 1000)))
    req.log?.warn(
      {
        event: 'rate_limit_denied',
        bucketType,
        bucketKey,
        count: result.count,
        maxPerMinute: config.approvalRlRequestPerMin,
      },
      'rate limit exceeded'
    )
    res.status(429).json({ error: 'Too Many Requests', retryAfterSeconds: retryAfterSec })
    return false
  }

  rateLimitHitsTotal.inc({ bucket_type: bucketType, result: 'allowed' }, 1)
  res.setHeader('X-RateLimit-Limit', String(config.approvalRlRequestPerMin))
  res.setHeader('X-RateLimit-Remaining', String(result.remaining))
  res.setHeader('X-RateLimit-Reset', String(Math.floor(result.resetMs / 1000)))
  return true
}

export function createUserApprovalRequestsRoutes(gateway: K8sGateway): Router {
  const router = Router()

  router.post(
    '/workflow-approvals/request',
    mcpHostHttpMetrics('user_approval_requests_request'),
    requireMcpHostJwt,
    rateLimitMiddleware({
      bucketType: 'recipe_request',
      maxPerMinute: config.approvalRlRequestPerMin,
      getBucketKey: req => {
        const auth = req.mcpHostJwt
        /* v8 ignore next -- requireMcpHostJwt runs before this rate limiter. */
        if (!auth) return null
        return `recipe:${auth.recipeNamespace}/${auth.recipeName}`
      },
    }),
    (req, res, next) => {
      void (async () => {
        try {
          const auth = req.mcpHostJwt!
          const {
            target,
            payload,
            correlation,
            ttlSeconds,
            recipeNamespace: bodyRecipeNamespace,
            recipeName: bodyRecipeName,
            /* v8 ignore next -- express.json sets req.body to an object for JSON requests. */
          } = req.body ?? {}

          if (
            typeof bodyRecipeNamespace !== 'string' ||
            !bodyRecipeNamespace.trim() ||
            typeof bodyRecipeName !== 'string' ||
            !bodyRecipeName.trim()
          ) {
            return res
              .status(400)
              .json({ error: 'recipeNamespace and recipeName are required in body' })
          }
          const approvalRecipe = {
            recipeNamespace: bodyRecipeNamespace.trim(),
            recipeName: bodyRecipeName.trim(),
          }
          if (!canCreateApprovalForRecipe(auth, approvalRecipe, payload)) {
            req.log?.info(
              {
                event: 'auth_denied',
                reason: 'recipe_binding_mismatch',
                route: 'user_approval_requests_request',
                jti: auth.jti,
                sub: auth.sub,
                recipeNamespace: auth.recipeNamespace,
                recipeName: auth.recipeName,
              },
              'recipe binding mismatch on /request'
            )
            return res.status(400).json({ error: 'recipe_binding_mismatch' })
          }

          const idempotencyKey = String(req.header('idempotency-key') || '').trim()
          const rawTargetUserId = target?.userId
          const rawTargetTeamId = target?.teamId
          const hasTargetUserId =
            rawTargetUserId !== undefined &&
            rawTargetUserId !== null &&
            String(rawTargetUserId).trim() !== ''
          const hasTargetTeamId =
            rawTargetTeamId !== undefined &&
            rawTargetTeamId !== null &&
            String(rawTargetTeamId).trim() !== ''

          if (!idempotencyKey) {
            return res.status(400).json({ error: 'Idempotency-Key header is required' })
          }
          if (idempotencyKey.length > 256) {
            return res
              .status(400)
              .json({ error: 'Idempotency-Key exceeds maximum length of 256 characters' })
          }
          if (!target || hasTargetUserId === hasTargetTeamId) {
            return res
              .status(400)
              .json({ error: 'target must contain exactly one of userId or teamId' })
          }
          if (
            hasTargetUserId &&
            (typeof rawTargetUserId !== 'string' || !UUID_RE.test(rawTargetUserId.trim()))
          ) {
            return res.status(400).json({ error: 'Invalid userId format, expected UUID' })
          }
          if (
            hasTargetTeamId &&
            (typeof rawTargetTeamId !== 'string' || !UUID_RE.test(rawTargetTeamId.trim()))
          ) {
            return res.status(400).json({ error: 'Invalid teamId format, expected UUID' })
          }

          const targetUserId = hasTargetUserId ? rawTargetUserId.trim() : undefined
          const targetTeamId = hasTargetTeamId ? rawTargetTeamId.trim() : undefined

          if (!payload || typeof payload.message !== 'string') {
            return res.status(400).json({ error: 'payload.message is required' })
          }
          if (payload.message.length > 10_000) {
            return res
              .status(400)
              .json({ error: 'payload.message exceeds maximum length of 10000 characters' })
          }
          if (payload.metadata && JSON.stringify(payload.metadata).length > 1024) {
            return res.status(400).json({ error: 'payload.metadata exceeds maximum size of 1KB' })
          }
          if (correlation && JSON.stringify(correlation).length > 1024) {
            return res.status(400).json({ error: 'correlation exceeds maximum size of 1KB' })
          }
          if (ttlSeconds !== undefined) {
            if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
              return res.status(400).json({ error: 'ttlSeconds must be a positive integer' })
            }
            if (ttlSeconds > config.userApprovalRequestMaxTtlSec) {
              return res.status(400).json({
                error: `ttlSeconds exceeds maximum of ${config.userApprovalRequestMaxTtlSec}`,
              })
            }
          }

          const allowedKeys = new Set(['message', 'options', 'metadata'])
          if (Object.keys(payload).some(k => !allowedKeys.has(k))) {
            return res.status(400).json({
              error: 'payload contains unrecognized fields. Allowed: message, options, metadata',
            })
          }
          const parsedRunIntent = parseWorkflowTriggerRunIntent(
            (req.body as Record<string, unknown>)?.workflowTriggerRunIntent
          )
          if (!parsedRunIntent.ok) {
            return res.status(parsedRunIntent.status).json({ error: parsedRunIntent.error })
          }
          const workflowTriggerApprovalForCaller = isWorkflowTriggerApprovalForCaller(
            auth,
            approvalRecipe,
            payload
          )
          if (parsedRunIntent.body && !workflowTriggerApprovalForCaller) {
            return res.status(400).json({
              error: 'workflowTriggerRunIntent requires payload.metadata.workflowTrigger',
            })
          }

          const allowed = await allowlistCheck(
            approvalRecipe.recipeNamespace,
            approvalRecipe.recipeName,
            targetUserId,
            targetTeamId
          )
          if (!allowed) {
            req.log?.info(
              {
                event: 'auth_denied',
                reason: 'allowlist_miss',
                route: 'user_approval_requests_request',
              },
              'auth denied'
            )
            return res.status(403).json({ error: 'Target not in allowlist for this recipe' })
          }

          if (workflowTriggerApprovalForCaller) {
            const triggerGrantAllowed = await triggerGrantCheck(
              approvalRecipe.recipeNamespace,
              approvalRecipe.recipeName,
              targetUserId,
              targetTeamId
            )
            if (!triggerGrantAllowed) {
              req.log?.info(
                {
                  event: 'auth_denied',
                  reason: 'trigger_grant_miss',
                  route: 'user_approval_requests_request',
                },
                'auth denied'
              )
              return res.status(403).json({ error: 'Target not authorized to trigger this recipe' })
            }
          }

          if (workflowTriggerApprovalForCaller && parsedRunIntent.body) {
            const callerKey = getMcpHostCallerKey(auth)
            const triggerIntent = parseWorkflowTriggerIntent(payload)
            const runIntent = await validateMcpHostWorkflowTriggerApprovalRunIntent({
              gateway,
              recipeNamespace: approvalRecipe.recipeNamespace,
              recipeName: approvalRecipe.recipeName,
              callerKey,
              body: parsedRunIntent.body,
              requesterUserId: triggerIntent?.requesterUserId,
              targetUserId,
              targetTeamId,
            })
            const result = await createWorkflowTriggerApprovalRequest({
              recipeNamespace: approvalRecipe.recipeNamespace,
              recipeName: approvalRecipe.recipeName,
              callerKey,
              targetUserId,
              targetTeamId,
              payload,
              idempotencyKey,
              correlation,
              runIntent,
            })

            if (result.kind === 'mismatch') {
              return res.status(422).json({
                error: 'idempotency_key_payload_mismatch',
                approvalRequestId: result.approvalRequestId,
                status: result.status,
                ...(result.reason ? { reason: result.reason } : {}),
              })
            }
            if (result.kind === 'run') {
              return res.status(409).json({
                approvalRequestId: result.row.approval_request_id,
                status: 'consumed',
              })
            }

            req.log?.info(
              {
                event: 'workflow_trigger_approval_request_created',
                recipeNamespace: approvalRecipe.recipeNamespace,
                recipeName: approvalRecipe.recipeName,
                callerKey,
                callerType: classifyMcpHostCaller(callerKey),
                approvalRequestId: result.approvalRequestId,
                targetUserId: targetUserId ?? null,
                targetTeamId: targetTeamId ?? null,
                jti: auth.jti,
                sub: auth.sub,
              },
              'workflow trigger approval request created'
            )

            return res.status(result.existing ? 409 : 200).json({
              approvalRequestId: result.approvalRequestId,
              status: result.status,
              expiresAt: result.expiresAt,
            })
          }

          let result: Awaited<ReturnType<typeof createApprovalRequest>>
          try {
            result = await createApprovalRequest({
              recipeNamespace: approvalRecipe.recipeNamespace,
              recipeName: approvalRecipe.recipeName,
              targetUserId,
              targetTeamId,
              payload,
              idempotencyKey,
              correlation,
              ttlSeconds,
            })
          } catch (err) {
            if (err instanceof InvalidWorkflowTriggerIntentError) {
              return res.status(400).json({ error: 'Invalid payload.metadata.workflowTrigger' })
            }
            throw err
          }

          if ('mismatch' in result) {
            return res.status(422).json({
              error: 'idempotency_key_payload_mismatch',
              approvalRequestId: result.existingId,
              status: result.existingStatus,
            })
          }
          if ('existing' in result) {
            return res.status(409).json({ approvalRequestId: result.id, status: result.status })
          }

          const callerKey = getMcpHostCallerKey(auth)
          req.log?.info(
            {
              event: 'approval_request_created',
              recipeNamespace: approvalRecipe.recipeNamespace,
              recipeName: approvalRecipe.recipeName,
              callerKey,
              callerType: classifyMcpHostCaller(callerKey),
              approvalRequestId: result.id,
              targetUserId: targetUserId ?? null,
              targetTeamId: targetTeamId ?? null,
              jti: auth.jti,
              sub: auth.sub,
            },
            'approval request created'
          )

          return res.status(200).json({
            approvalRequestId: result.id,
            status: result.status,
            expiresAt: result.expiresAt,
          })
        } catch (err) {
          if (err instanceof WorkflowTriggerHttpError) {
            res.status(err.status).json(err.body)
            return
          }
          next(err)
        }
      })()
    }
  )

  router.get(
    '/workflow-approvals/:id/status',
    mcpHostHttpMetrics('user_approval_requests_status'),
    requireMcpHostJwt,
    (req, res, next) => {
      void (async () => {
        try {
          const auth = req.mcpHostJwt!
          /* v8 ignore next -- Express only reaches this route when :id exists. */
          const approvalId = String(req.params?.id || '').trim()
          if (!UUID_RE.test(approvalId)) {
            return res.status(400).json({ error: 'Invalid approval id format' })
          }

          const binding = await getApprovalRecipeBinding(approvalId)
          if (!binding) {
            return res.status(404).json({ error: 'Not found' })
          }
          if (!canAccessApprovalBinding(auth, binding)) {
            req.log?.info(
              {
                event: 'auth_denied',
                reason: 'binding_mismatch',
                route: 'user_approval_requests_status',
                approvalRequestId: approvalId,
                jti: auth.jti,
                sub: auth.sub,
                recipeNamespace: auth.recipeNamespace,
                recipeName: auth.recipeName,
              },
              'recipe binding mismatch on /status'
            )
            return res.status(403).json({ error: 'binding_mismatch' })
          }

          const approval = await getStatus(approvalId, binding.recipeNamespace, binding.recipeName)
          if (!approval) {
            return res.status(404).json({ error: 'Not found' })
          }
          return res.status(200).json({
            status: approval.status,
            expiresAt: approval.expiresAt,
            decisionMaker: approval.decisionMaker,
          })
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  router.post(
    '/workflow-approval-mediums/resolve',
    mcpHostHttpMetrics('mcp_host_workflow_approval_medium_resolve'),
    (req, res, next) => {
      void (async () => {
        try {
          const caller = requireMcpHostControlWorkflowCaller(req, res)
          if (!caller) return
          if (!requireMcpHostControlScope(caller, res, 'workflow:approval:resolve')) return
          const callerKey = getMcpHostCallerKey(caller.claims)
          if (!(await enforceMediumResolveRateLimit(req, res, callerKey))) return

          const parsedIdentity = parseProviderIdentityFromBody(req.body)
          if (!parsedIdentity.ok) {
            return res.status(parsedIdentity.status).json({ error: parsedIdentity.error })
          }
          const {
            medium,
            providerUserId,
            providerWorkspaceId,
            providerChannelId,
            providerChannelType,
            providerTarget,
          } = parsedIdentity.identity

          // Resolve the account by provider identity first. The current channel,
          // bot binding, and user access are enforced below against providerTarget;
          // keeping the account lookup identity-only avoids the legacy NULL channel
          // reference lockout while still failing closed on current authorization.
          const account = await findVerifiedOperationalMediumAccount(
            {
              medium,
              providerUserId,
              providerWorkspaceId,
              providerChannelId: providerChannelId!,
              providerChannelType,
              providerTarget,
            },
            undefined,
            { channelBinding: 'identity-only' }
          )
          if (!account) {
            return res.status(404).json({ error: 'medium_account_not_found' })
          }

          if (medium === 'telegram') {
            const binding = await verifyTelegramOperationalChannelBinding({
              gateway,
              providerChannelId: providerChannelId!,
              providerChannelType,
              providerTarget,
              communicationChannelRef: account.communicationChannelRef,
              accountUserId: account.userId,
              providerUserId,
              requireAccountMatch: false,
            })
            if (!binding.ok) {
              return res.status(403).json({ error: binding.error })
            }
            const hostRef = providerTarget?.hostRef?.trim() || ''
            const channelName = providerTarget?.communicationChannelName?.trim() || ''
            const channelNamespace = providerTarget?.communicationChannelNamespace?.trim() || ''
            if (
              !hostRef ||
              !channelName ||
              !channelNamespace ||
              !(await userCanAccessTelegramCommunicationChannel({
                gateway,
                userId: account.userId,
                hostRef,
                channelName,
                channelNamespace,
              }))
            ) {
              return res.status(403).json({ error: 'communication_channel_access_denied' })
            }
          }
          if (medium === 'slack') {
            const hostRef = providerTarget?.hostRef?.trim() || ''
            const channelName = providerTarget?.communicationChannelName?.trim() || ''
            const channelNamespace = providerTarget?.communicationChannelNamespace?.trim() || ''
            const accountRef = account.communicationChannelRef || ''
            if (
              !hostRef ||
              !channelName ||
              !channelNamespace ||
              accountRef !== `${channelNamespace}/${channelName}` ||
              !(await userCanAccessSlackCommunicationChannel({
                gateway,
                userId: account.userId,
                hostRef,
                channelName,
                channelNamespace,
              }))
            ) {
              return res.status(403).json({ error: 'communication_channel_access_denied' })
            }
          }

          return res.status(200).json({ userId: account.userId })
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  router.get(
    '/workflow-approval-notifications/deliveries',
    mcpHostHttpMetrics('mcp_host_workflow_approval_notification_claim'),
    (req, res, next) => {
      void (async () => {
        try {
          const caller = requireMcpHostControlWorkflowCaller(req, res)
          if (!caller) return
          if (!requireMcpHostControlScope(caller, res, 'workflow:approval:resolve')) return
          const callerKey = getMcpHostCallerKey(caller.claims)
          if (!(await enforceMediumResolveRateLimit(req, res, callerKey))) return

          const deliveries = await claimNotificationDeliveries({
            medium: req.query.medium,
            providerChannelIds: providerChannelIds(req.query.providerChannelId),
            providerWorkspaceId: singleQueryString(req.query.providerWorkspaceId),
            hostRef: callerKey,
            limit: req.query.limit,
          })
          res.status(200).json({ deliveries })
        } catch (err) {
          if (isDeliveryAuthInputError(err)) {
            res.status(400).json({ error: err.message })
            return
          }
          next(err)
        }
      })()
    }
  )

  router.post(
    '/workflow-approval-notifications/deliveries/:id/ack',
    mcpHostHttpMetrics('mcp_host_workflow_approval_notification_ack'),
    (req, res, next) => {
      void (async () => {
        try {
          const caller = requireMcpHostControlWorkflowCaller(req, res)
          if (!caller) return
          if (!requireMcpHostControlScope(caller, res, 'workflow:approval:resolve')) return

          const id = String(req.params.id || '').trim()
          if (!UUID_RE.test(id)) {
            res.status(400).json({ error: 'Invalid delivery id format' })
            return
          }
          const body = requestBodyRecord(req.body)
          const ok = await acknowledgeNotificationDelivery({
            id,
            medium: body.medium,
            providerUserId: body.providerUserId,
            providerChannelId: body.providerChannelId,
            providerWorkspaceId: nullableString(body.providerWorkspaceId),
            hostRef: getMcpHostCallerKey(caller.claims),
          })
          res.status(ok ? 204 : 404).send()
        } catch (err) {
          if (isDeliveryAuthInputError(err)) {
            res.status(400).json({ error: err.message })
            return
          }
          next(err)
        }
      })()
    }
  )

  router.post(
    '/workflow-approval-notifications/deliveries/:id/fail',
    mcpHostHttpMetrics('mcp_host_workflow_approval_notification_fail'),
    (req, res, next) => {
      void (async () => {
        try {
          const caller = requireMcpHostControlWorkflowCaller(req, res)
          if (!caller) return
          if (!requireMcpHostControlScope(caller, res, 'workflow:approval:resolve')) return

          const id = String(req.params.id || '').trim()
          if (!UUID_RE.test(id)) {
            res.status(400).json({ error: 'Invalid delivery id format' })
            return
          }
          const body = requestBodyRecord(req.body)
          const ok = await failNotificationDelivery({
            id,
            medium: body.medium,
            providerUserId: body.providerUserId,
            providerChannelId: body.providerChannelId,
            providerWorkspaceId: nullableString(body.providerWorkspaceId),
            hostRef: getMcpHostCallerKey(caller.claims),
          })
          res.status(ok ? 204 : 404).send()
        } catch (err) {
          if (isDeliveryAuthInputError(err)) {
            res.status(400).json({ error: err.message })
            return
          }
          next(err)
        }
      })()
    }
  )

  router.post(
    '/workflow-approval-mediums/link-sessions/confirm',
    mcpHostHttpMetrics('mcp_host_workflow_approval_medium_link_session_confirm'),
    (req, res, next) => {
      void (async () => {
        try {
          const caller = requireMcpHostControlWorkflowCaller(req, res)
          if (!caller) return
          if (!requireMcpHostControlScope(caller, res, 'workflow:approval:resolve')) return

          const body = requestBodyRecord(req.body)
          const medium = String(body.medium || '')
            .trim()
            .toLowerCase()
          const communicationChannelRef = nullableString(body.communicationChannelRef)
          let validatedSlackTarget: Awaited<
            ReturnType<typeof resolveSlackCommunicationChannelTarget>
          > | null = null
          let validatedTeamsTarget: Awaited<
            ReturnType<typeof resolveTeamsCommunicationChannelTarget>
          > | null = null
          const result = await confirmMediumLinkSessionFromReader({
            nonce: String(body.nonce || '').trim(),
            identity: {
              medium,
              providerUserId: String(body.providerUserId || '').trim(),
              providerWorkspaceId: nullableString(body.providerWorkspaceId),
              providerChannelId: nullableString(body.providerChannelId),
              communicationChannelRef,
            },
            validateSession:
              medium === 'slack' || medium === 'teams'
                ? async (userId, identity) => {
                    if (!communicationChannelRef) {
                      return { ok: false, error: 'communication_channel_ref_required' }
                    }
                    const [channelNamespace, channelName] = communicationChannelRef.split('/')
                    if (!channelNamespace || !channelName) {
                      return { ok: false, error: 'invalid_communication_channel_ref' }
                    }
                    try {
                      const target =
                        medium === 'teams'
                          ? await resolveTeamsCommunicationChannelTarget({
                              gateway,
                              userId,
                              channelNamespace,
                              channelName,
                            })
                          : await resolveSlackCommunicationChannelTarget({
                              gateway,
                              userId,
                              channelNamespace,
                              channelName,
                            })
                      if (medium === 'teams') {
                        validatedTeamsTarget = target as Awaited<
                          ReturnType<typeof resolveTeamsCommunicationChannelTarget>
                        >
                      } else {
                        validatedSlackTarget = target as Awaited<
                          ReturnType<typeof resolveSlackCommunicationChannelTarget>
                        >
                      }
                      if (
                        identity.providerWorkspaceId !== nullableString(body.providerWorkspaceId)
                      ) {
                        return { ok: false, error: 'link_session_workspace_mismatch' }
                      }
                      return { ok: true }
                    } catch (err) {
                      return {
                        ok: false,
                        error:
                          err instanceof Error
                            ? err.message
                            : medium === 'teams'
                              ? 'teams_target_not_found'
                              : 'slack_target_not_found',
                      }
                    }
                  }
                : undefined,
          })
          if (!result.ok) {
            const status =
              result.error === 'link_session_not_found'
                ? 404
                : result.error === 'link_session_expired' ||
                    result.error === 'link_session_consumed' ||
                    result.error === 'medium_identity_already_bound' ||
                    result.error === 'link_session_workspace_mismatch' ||
                    result.error === 'link_session_channel_mismatch'
                  ? 409
                  : result.error === 'slack_target_not_found'
                    ? 404
                    : result.error === 'slack_target_not_ready'
                      ? 409
                      : result.error === 'teams_target_not_found'
                        ? 404
                        : result.error === 'teams_target_not_ready'
                          ? 409
                          : 400
            return res.status(status).json({ ok: false, error: result.error })
          }
          if (medium === 'slack' && communicationChannelRef) {
            const [channelNamespace, channelName] = communicationChannelRef.split('/')
            const account = result.account as
              | {
                  userId?: string
                  providerUserId?: string
                  providerWorkspaceId?: string | null
                  providerChannelId?: string | null
                }
              | undefined
            if (
              channelNamespace &&
              channelName &&
              account?.userId &&
              account.providerUserId &&
              account.providerWorkspaceId &&
              account.providerChannelId
            ) {
              const target =
                validatedSlackTarget ??
                (await resolveSlackCommunicationChannelTarget({
                  gateway,
                  userId: account.userId,
                  channelNamespace,
                  channelName,
                }))
              await addSlackTargetAssociation(gateway, target, {
                userId: account.userId,
                providerUserId: account.providerUserId,
                providerWorkspaceId: account.providerWorkspaceId,
                providerChannelId: account.providerChannelId,
                providerChannelType: nullableString(body.providerChannelType),
                providerChannelTitle: nullableString(body.providerChannelTitle),
              })
            }
          }
          if (medium === 'teams' && communicationChannelRef) {
            const [channelNamespace, channelName] = communicationChannelRef.split('/')
            const account = result.account as
              | {
                  userId?: string
                  providerUserId?: string
                  providerWorkspaceId?: string | null
                  providerChannelId?: string | null
                }
              | undefined
            if (
              channelNamespace &&
              channelName &&
              account?.userId &&
              account.providerUserId &&
              account.providerWorkspaceId &&
              account.providerChannelId
            ) {
              const target =
                validatedTeamsTarget ??
                (await resolveTeamsCommunicationChannelTarget({
                  gateway,
                  userId: account.userId,
                  channelNamespace,
                  channelName,
                }))
              await addTeamsTargetAssociation(gateway, target, {
                userId: account.userId,
                providerUserId: account.providerUserId,
                providerWorkspaceId: account.providerWorkspaceId,
                providerChannelId: account.providerChannelId,
                providerChannelType: nullableString(body.providerChannelType),
                providerChannelTitle: nullableString(body.providerChannelTitle),
                providerTeamId: nullableString(body.providerTeamId),
                providerTeamsChannelId: nullableString(body.providerTeamsChannelId),
                serviceUrl: nullableString(body.serviceUrl),
                ...(typeof result.replyInThreads === 'boolean'
                  ? { replyInThreads: result.replyInThreads }
                  : {}),
              })
            }
          }
          return res.status(200).json({
            ok: true,
            account: result.account,
            replyInThreads: result.replyInThreads,
          })
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  router.post(
    '/workflow-approval-mediums/telegram/challenges/confirm-provider-event',
    mcpHostHttpMetrics('mcp_host_workflow_approval_medium_telegram_confirm'),
    (req, res, next) => {
      void (async () => {
        try {
          const caller = requireMcpHostControlWorkflowCaller(req, res)
          if (!caller) return
          if (!requireMcpHostControlScope(caller, res, 'workflow:approval:resolve')) return
          const callerKey = getMcpHostCallerKey(caller.claims)
          if (!(await enforceMediumResolveRateLimit(req, res, callerKey))) return

          const body = requestBodyRecord(req.body)
          const code = String(body.code || '').trim()
          const providerUserId = String(body.providerUserId || '').trim()
          const providerChannelId = String(body.providerChannelId || '').trim()
          const providerChannelType = String(body.providerChannelType || '').trim()
          const providerChannelTitle = nullableString(body.providerChannelTitle)
          const providerChannelHandle = nullableString(body.providerChannelHandle)
          if (!/^\d{6}$/.test(code)) {
            return res.status(400).json({ error: 'invalid_code' })
          }
          const result = await confirmTelegramProviderEventChallenge({
            gateway,
            code,
            providerUserId,
            providerChannelId,
            providerChannelType,
            providerChannelTitle,
            providerChannelHandle,
            providerTarget: body.providerTarget,
            providerTargets: body.providerTargets,
          })
          if (!result.ok) {
            return res
              .status(statusForProviderEventError(result.error))
              .json({ error: result.error })
          }
          return res.status(200).json({
            ok: true,
            accountId: result.accountId,
            userEmail: result.userEmail,
          })
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  router.post(
    '/workflow-approvals/pending/resolve',
    mcpHostHttpMetrics('mcp_host_workflow_approval_pending_resolve'),
    (req, res, next) => {
      void (async () => {
        try {
          const caller = requireMcpHostControlWorkflowCaller(req, res)
          if (!caller) return
          if (!requireMcpHostControlScope(caller, res, 'workflow:approval:resolve')) return
          const callerKey = getMcpHostCallerKey(caller.claims)
          if (!(await enforceMediumResolveRateLimit(req, res, callerKey))) return

          const parsedIdentity = parseProviderIdentityFromBody(req.body)
          if (!parsedIdentity.ok) {
            return res.status(parsedIdentity.status).json({ error: parsedIdentity.error })
          }
          const body =
            req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {}
          const recipeName = typeof body.recipeName === 'string' ? body.recipeName.trim() : ''
          const result = await resolvePendingWorkflowApprovalDelivery({
            medium: parsedIdentity.identity.medium,
            providerUserId: parsedIdentity.identity.providerUserId,
            providerWorkspaceId: parsedIdentity.identity.providerWorkspaceId,
            providerChannelId: parsedIdentity.identity.providerChannelId,
            hostRef: callerKey,
            recipeName,
          })
          if (result.status === 'not_found') {
            return res.status(404).json({ error: 'pending_workflow_approval_not_found' })
          }
          if (result.status === 'ambiguous') {
            return res.status(409).json({ error: 'pending_workflow_approval_ambiguous' })
          }
          return res.status(200).json({ approvalRequestId: result.approvalRequestId })
        } catch (err) {
          if (
            err instanceof Error &&
            (err.message === 'unsupported_notification_medium' ||
              err.message === 'provider_channel_id_required' ||
              err.message === 'provider_user_id_required' ||
              err.message === 'provider_workspace_id_required' ||
              err.message === 'host_ref_required' ||
              err.message === 'recipe_name_required')
          ) {
            return res.status(400).json({ error: err.message })
          }
          next(err)
        }
      })()
    }
  )

  router.post(
    '/workflow-approvals/:id/provider-decision',
    mcpHostHttpMetrics('mcp_host_workflow_approval_provider_decision'),
    rateLimitMiddleware({
      bucketType: 'recipe_request',
      maxPerMinute: config.approvalRlRequestPerMin,
      getBucketKey: req => {
        const approvalId = String(req.params?.id || '').trim()
        return approvalId ? `provider-decision:${approvalId}` : null
      },
    }),
    (req, res, next) => {
      void (async () => {
        try {
          const caller = requireMcpHostControlWorkflowCaller(req, res)
          if (!caller) return
          if (!requireMcpHostControlScope(caller, res, 'workflow:approval:decide')) return

          const approvalId = String(req.params?.id || '').trim()
          if (!UUID_RE.test(approvalId)) {
            return res.status(400).json({ error: 'Invalid approval id format' })
          }

          const { decision, note } = req.body ?? {}
          if (decision !== 'approve' && decision !== 'deny') {
            return res.status(400).json({ error: "decision must be 'approve' or 'deny'" })
          }
          const parsedIdentity = parseProviderIdentityFromBody(req.body, { requireEventId: true })
          if (!parsedIdentity.ok) {
            return res.status(parsedIdentity.status).json({ error: parsedIdentity.error })
          }
          if (note && String(note).length > 1000) {
            return res.status(400).json({ error: 'note exceeds maximum length of 1000 characters' })
          }
          const {
            medium,
            providerUserId,
            providerWorkspaceId,
            providerChannelId,
            providerChannelType,
            providerEventId,
            providerTarget,
          } = parsedIdentity.identity

          const result = await recordProviderApprovalDecision({
            approvalRequestId: approvalId,
            decision,
            caller: caller.claims,
            mediumIdentity: {
              medium,
              providerUserId,
              providerWorkspaceId,
              providerChannelId,
              providerChannelType,
              providerTarget,
            },
            gateway,
            providerEventId: providerEventId ?? '',
            note: note ? String(note) : null,
          })

          if (!result.ok) {
            return res.status(result.status).json({ error: result.error })
          }

          return res.status(200).json({
            success: true,
            duplicate: result.duplicate,
            ...(result.status ? { status: result.status } : {}),
            ...(result.run ? { run: result.run } : {}),
          })
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  router.post(
    '/workflow-approvals/:id/cancel',
    mcpHostHttpMetrics('user_approval_requests_cancel'),
    requireMcpHostJwt,
    (req, res, next) => {
      void (async () => {
        try {
          const auth = req.mcpHostJwt!
          const callerKey = getMcpHostCallerKey(auth)
          /* v8 ignore next -- Express only reaches this route when :id exists. */
          const approvalId = String(req.params?.id || '').trim()
          if (!UUID_RE.test(approvalId)) {
            return res.status(400).json({ error: 'Invalid approval id format' })
          }

          const binding = await getApprovalRecipeBinding(approvalId)
          if (!binding) {
            return res.status(404).json({ error: 'not_found' })
          }
          if (!canAccessApprovalBinding(auth, binding)) {
            req.log?.info(
              {
                event: 'auth_denied',
                reason: 'binding_mismatch',
                route: 'user_approval_requests_cancel',
                approvalRequestId: approvalId,
                jti: auth.jti,
                sub: auth.sub,
                recipeNamespace: auth.recipeNamespace,
                recipeName: auth.recipeName,
              },
              'recipe binding mismatch on /cancel'
            )
            return res.status(403).json({ error: 'binding_mismatch' })
          }

          const result = await cancelRequest(
            approvalId,
            binding.recipeNamespace,
            binding.recipeName,
            {
              cancelledBy: callerKey,
              correlationId: req.correlationId ?? null,
            }
          )
          if (!result.ok) {
            const status = result.error === 'not_found' ? 404 : 409
            return res.status(status).json({ error: result.error })
          }

          req.log?.info(
            {
              event: 'approval_request_cancelled',
              approvalRequestId: approvalId,
              cancelledBy: callerKey,
              jti: auth.jti,
              sub: auth.sub,
              recipeNamespace: auth.recipeNamespace,
              recipeName: auth.recipeName,
            },
            'approval request cancelled'
          )
          return res.status(200).json({ status: 'cancelled' })
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  return router
}
