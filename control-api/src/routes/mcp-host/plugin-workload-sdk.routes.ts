import { type NextFunction, type Request, type Response, Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import { config } from '../../config.js'
import { pool } from '../../db.js'
import { asyncHandler } from '../../http/asyncHandler.js'
import { requireMcpHostJwt } from '../../middleware/mcpHostJwtAuth.js'
import { createPluginWorkloadSdkRequestRateLimit } from '../../middleware/pluginWorkloadSdkRateLimits.js'
import { rateLimitMiddleware } from '../../middleware/rateLimitMiddleware.js'
import { pluginWorkloadSdkNotificationAuthDurationSeconds } from '../../observability/metrics.js'
import { enqueuePluginWorkloadSdkNotification } from '../../services/notificationEmitter.js'
import {
  type PluginWorkloadSdkAuthzError,
  authorizeClientNotification,
  authorizeListRecipients,
  authorizePromptBridge,
  reissuePromptBridgeCredentialTicket,
} from '../../services/pluginWorkloadSdkAuthorizer.js'
import { verifyPluginWorkloadSdkCredentialTicket } from '../../services/pluginWorkloadSdkCredentialTicket.js'
import {
  DEFAULT_IDEMPOTENCY_KEY_PATTERN,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MAX_REQUEST_CONTENT_BYTES,
  DEFAULT_MAX_TITLE_BYTES,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_TARGET_REF_LENGTH,
  MAX_USER_REF_LENGTH,
  PLUGIN_WORKLOAD_SDK_PURPOSES,
  type PluginWorkloadSdkErrorCode,
} from '../../services/pluginWorkloadSdkDb.js'
import {
  findGrant,
  getInvocationById,
  getPluginWorkloadSdkAttemptReceipt,
  getPluginWorkloadSdkProviderAttempt,
  hasUsableClientNotificationRecipients,
  hashPromptTargetPolicy,
  isClientNotificationsPolicyReady,
  listInvocations,
  markPluginWorkloadSdkProviderAttemptStatus,
  redeemPluginWorkloadSdkCredentialTicketJti,
  resolveRecipientProfiles,
} from '../../services/pluginWorkloadSdkDb.js'
import {
  PromptBridgeFinalizationError,
  type PromptBridgeFinalizationInput,
  finalizePromptBridge,
} from '../../services/pluginWorkloadSdkFinalization.js'
import { markInvocationStatus } from '../../services/pluginWorkloadSdkInvocationAuditor.js'
import type { McpHostAccessClaims } from '../../utils/auth/mcpHostJwtToken.js'
import { isPlainObject } from '../../utils/isPlainObject.js'

// ─── Plugin Workload SDK — mcp-host gateway routes (plan §2.5, §2.7) ─────
// Registered under the /mcp-host/ prefix so SDK traffic follows the same
// host/control gateway path as every other mcp-host runtime call
// (conformance: spec §19 "mcp-host control-api access uses the gateway").
//
//   POST /mcp-host/plugin-workload-sdk/prompt-bridge/v2
//   GET  /mcp-host/plugin-workload-sdk/capabilities
//   POST /mcp-host/plugin-workload-sdk/client-notification
//   POST /mcp-host/plugin-workload-sdk/prompt-bridge/credential-ticket
//   GET  /mcp-host/plugin-workload-sdk/invocations/:recipeRef

const IDEMPOTENCY_KEY_RE = new RegExp(DEFAULT_IDEMPOTENCY_KEY_PATTERN)
const PURPOSE_SET = new Set<string>(PLUGIN_WORKLOAD_SDK_PURPOSES)
/** Opaque refs must not smuggle raw channel addresses (spec §17). */
const EMAIL_LIKE_RE = /@/
const PHONE_LIKE_RE = /^\+?[0-9][0-9\s().-]{6,}$/
/** Current target-aware/JIT promptBridge wire contract. */
export const PLUGIN_WORKLOAD_SDK_PROMPT_BRIDGE_CONTRACT_VERSION = 2

// Credential-ticket introspection and reissue both perform signature checks,
// database reads, and (for reissue) signing work before the provider call.
// Bound the cost per recipe after JWT authentication, while the authorizer's
// grant rate/quota remains the product-level invocation limit.
const pluginWorkloadSdkCredentialRateLimit = rateLimitMiddleware({
  bucketType: 'plugin_workload_sdk_credential',
  maxPerMinute: 120,
  getBucketKey: req => {
    const claims = req.mcpHostJwt
    if (!claims) return null
    return `plugin_workload_sdk_credential:${claims.recipeNamespace}/${claims.recipeName}`
  },
})

function requirePluginWorkloadSdkScope(req: Request, res: Response, next: NextFunction): void {
  const claims = req.mcpHostJwt
  if (!claims?.workflowControlScopes.includes('plugin-workload-sdk')) {
    res.status(403).json({ error: 'scope_denied', retryable: false })
    return
  }
  next()
}

const AUTHZ_HTTP_STATUS: Record<PluginWorkloadSdkErrorCode, number> = {
  capability_not_declared: 403,
  caller_not_allowed: 403,
  scope_denied: 403,
  target_not_allowed: 403,
  ambiguous_model: 409,
  event_type_not_allowed: 403,
  quota_exceeded: 429,
  provider_policy_denied: 403,
  provider_unavailable: 503,
  payload_too_large: 413,
  idempotency_conflict: 422,
  recipe_binding_mismatch: 400,
  protocol_mismatch: 503,
}

function sendAuthzError(res: Response, error: PluginWorkloadSdkAuthzError): void {
  res.status(AUTHZ_HTTP_STATUS[error.error] ?? 403).json({
    error: error.error,
    message: error.message,
    retryable: error.retryable,
  })
}

/**
 * Binding-match enforcement (same contract as workflow approvals): the body
 * MUST carry recipeNamespace/recipeName and both MUST equal the JWT claims —
 * otherwise a token issued for one recipe could act on another.
 */
function checkRecipeBinding(
  body: Record<string, unknown>,
  claims: McpHostAccessClaims,
  res: Response
): boolean {
  const ns = typeof body.recipeNamespace === 'string' ? body.recipeNamespace.trim() : ''
  const name = typeof body.recipeName === 'string' ? body.recipeName.trim() : ''
  if (!ns || !name) {
    res.status(400).json({ error: 'recipeNamespace and recipeName are required in body' })
    return false
  }
  if (ns !== claims.recipeNamespace || name !== claims.recipeName) {
    res.status(400).json({ error: 'recipe_binding_mismatch' })
    return false
  }
  return true
}

function validateIdempotencyKey(value: unknown, res: Response): string | null {
  if (typeof value !== 'string' || value.length === 0) {
    res.status(400).json({ error: 'idempotencyKey is required' })
    return null
  }
  if (value.length > MAX_IDEMPOTENCY_KEY_LENGTH || !IDEMPOTENCY_KEY_RE.test(value)) {
    res.status(400).json({ error: 'invalid_idempotency_key' })
    return null
  }
  return value
}

function validateCallerRef(value: unknown, res: Response): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    res.status(400).json({ error: 'callerRef is required' })
    return null
  }
  return value.trim()
}

function parsePromptBridgeFinalizationBody(
  body: Record<string, unknown>,
  claims: McpHostAccessClaims,
  res: Response
): PromptBridgeFinalizationInput | null {
  const invocationId = typeof body.invocationId === 'string' ? body.invocationId.trim() : ''
  const providerAttemptId =
    typeof body.providerAttemptId === 'string' ? body.providerAttemptId.trim() : ''
  const attemptGeneration = Number.isInteger(body.attemptGeneration)
    ? Number(body.attemptGeneration)
    : 0
  const providerAttemptIndex = Number.isInteger(body.providerAttemptIndex)
    ? Number(body.providerAttemptIndex)
    : 0
  const status = body.status
  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
  const target = isPlainObject(body.target) ? body.target : null
  const targetRef = typeof target?.targetRef === 'string' ? target.targetRef.trim() : ''
  const provider = typeof target?.provider === 'string' ? target.provider.trim() : ''
  const model = typeof target?.model === 'string' ? target.model.trim() : ''
  const credentialSlot =
    typeof target?.credentialSlot === 'string' ? target.credentialSlot.trim() : ''

  if (
    !invocationId ||
    !providerAttemptId ||
    attemptGeneration < 1 ||
    providerAttemptIndex < 1 ||
    providerAttemptIndex > 4 ||
    !['complete', 'failed', 'provider_unavailable'].includes(String(status)) ||
    !reason ||
    reason.length > 128 ||
    !targetRef ||
    !provider ||
    !model
  ) {
    res.status(400).json({
      error:
        'invocationId, attemptGeneration, providerAttemptId, providerAttemptIndex, status, reason and target are required',
    })
    return null
  }

  const rawUsage = body.usage
  let usage: PromptBridgeFinalizationInput['usage']
  if (rawUsage !== undefined) {
    if (!isPlainObject(rawUsage)) {
      res.status(400).json({ error: 'usage must be an object' })
      return null
    }
    const llmSecretName =
      typeof rawUsage.llmSecretName === 'string' ? rawUsage.llmSecretName.trim() : ''
    const callerRef = typeof rawUsage.callerRef === 'string' ? rawUsage.callerRef.trim() : ''
    const attemptCount = Number.isInteger(rawUsage.attemptCount) ? Number(rawUsage.attemptCount) : 0
    const inputTokens = Number.isInteger(rawUsage.inputTokens) ? Number(rawUsage.inputTokens) : -1
    const outputTokens = Number.isInteger(rawUsage.outputTokens)
      ? Number(rawUsage.outputTokens)
      : -1
    if (
      !callerRef ||
      typeof rawUsage.fallbackUsed !== 'boolean' ||
      attemptCount < 1 ||
      attemptCount > 4 ||
      inputTokens < 0 ||
      outputTokens < 0
    ) {
      res.status(400).json({ error: 'usage fields are invalid' })
      return null
    }
    usage = {
      llmSecretName,
      callerRef,
      fallbackUsed: rawUsage.fallbackUsed,
      attemptCount,
      inputTokens,
      outputTokens,
    }
  }

  return {
    invocationId,
    recipeNamespace: claims.recipeNamespace,
    recipeName: claims.recipeName,
    hostRef: claims.hostRefs[0] ?? '',
    attemptGeneration,
    providerAttemptId,
    providerAttemptIndex,
    status: status as PromptBridgeFinalizationInput['status'],
    target: { targetRef, provider, model, credentialSlot },
    reason,
    ...(usage ? { usage } : {}),
  }
}

// ─── promptBridge input validation (plan §2.7) ───────────────────────────

interface ParsedPromptBridgeBody {
  contractVersion?: number
  callerRef: string
  bootstrapProvider: string
  bootstrapModel: string
  model?: string
  provider?: string
  targetRef?: string
  modelPolicyRef?: string
  purpose: string
  idempotencyKey: string
  messages: Array<{ role: string; content: string }>
  metadata?: Record<string, unknown>
  correlationId?: string
}

function parsePromptBridgeBody(
  body: Record<string, unknown>,
  res: Response,
  options: {
    requireContractVersion?: boolean
    requireBootstrapBinding?: boolean
  } = {}
): ParsedPromptBridgeBody | null {
  const callerRef = validateCallerRef(body.callerRef, res)
  if (!callerRef) return null

  const contractVersion =
    body.contractVersion === undefined
      ? undefined
      : Number.isInteger(body.contractVersion)
        ? Number(body.contractVersion)
        : 0
  if (
    (options.requireContractVersion &&
      contractVersion !== PLUGIN_WORKLOAD_SDK_PROMPT_BRIDGE_CONTRACT_VERSION) ||
    (!options.requireContractVersion &&
      contractVersion !== undefined &&
      contractVersion !== PLUGIN_WORKLOAD_SDK_PROMPT_BRIDGE_CONTRACT_VERSION)
  ) {
    res.status(409).json({
      error: 'protocol_mismatch',
      message: `promptBridge contractVersion ${PLUGIN_WORKLOAD_SDK_PROMPT_BRIDGE_CONTRACT_VERSION} is required`,
      retryable: true,
    })
    return null
  }

  // These fields are supplied only by the recipe-bound mcp-host.  They carry
  // the public provider/model identity from spec.agent, never credentials.
  const bootstrapProvider =
    typeof body.bootstrapProvider === 'string' ? body.bootstrapProvider.trim() : ''
  const bootstrapModel = typeof body.bootstrapModel === 'string' ? body.bootstrapModel.trim() : ''
  if (options.requireBootstrapBinding && (!bootstrapProvider || !bootstrapModel)) {
    res.status(400).json({ error: 'bootstrap_binding_required' })
    return null
  }

  const idempotencyKey = validateIdempotencyKey(body.idempotencyKey, res)
  if (!idempotencyKey) return null

  if (typeof body.purpose !== 'string' || !PURPOSE_SET.has(body.purpose)) {
    res.status(400).json({ error: 'invalid_purpose' })
    return null
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    res.status(400).json({ error: 'messages must be a non-empty array' })
    return null
  }
  let totalContentBytes = 0
  const messages: Array<{ role: string; content: string }> = []
  for (const entry of body.messages) {
    if (
      !isPlainObject(entry) ||
      typeof entry.role !== 'string' ||
      !['system', 'user', 'assistant'].includes(entry.role) ||
      typeof entry.content !== 'string'
    ) {
      res.status(400).json({ error: 'messages entries must be { role, content }' })
      return null
    }
    totalContentBytes += Buffer.byteLength(entry.content, 'utf8')
    messages.push({ role: entry.role, content: entry.content })
  }
  if (totalContentBytes > DEFAULT_MAX_REQUEST_CONTENT_BYTES) {
    res.status(413).json({ error: 'payload_too_large', retryable: false })
    return null
  }

  // Attachments are not part of the promptBridge JSON contract.
  if (Array.isArray(body.attachments) && body.attachments.length > 0) {
    res.status(400).json({ error: 'attachments_not_supported' })
    return null
  }

  let metadata: Record<string, unknown> | undefined
  if (body.metadata !== undefined) {
    if (!isPlainObject(body.metadata)) {
      res.status(400).json({ error: 'metadata must be an object' })
      return null
    }
    try {
      if (Buffer.byteLength(JSON.stringify(body.metadata), 'utf8') > 16 * 1024) {
        res.status(413).json({ error: 'metadata_too_large', retryable: false })
        return null
      }
      metadata = body.metadata as Record<string, unknown>
    } catch {
      res.status(400).json({ error: 'metadata must be JSON-serializable' })
      return null
    }
  }

  const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : undefined
  const provider =
    typeof body.provider === 'string' && body.provider.trim() ? body.provider.trim() : undefined
  const targetRef =
    typeof body.targetRef === 'string' && body.targetRef.trim() ? body.targetRef.trim() : undefined
  if (targetRef && targetRef.length > MAX_TARGET_REF_LENGTH) {
    res.status(400).json({ error: `targetRef exceeds maximum length of ${MAX_TARGET_REF_LENGTH}` })
    return null
  }
  if (provider && !model && !targetRef) {
    res.status(400).json({ error: 'provider requires model or targetRef' })
    return null
  }
  const modelPolicyRef =
    typeof body.modelPolicyRef === 'string' && body.modelPolicyRef.trim()
      ? body.modelPolicyRef.trim()
      : undefined
  const correlationId =
    typeof body.correlationId === 'string' && body.correlationId.trim()
      ? body.correlationId.trim().slice(0, 256)
      : undefined

  return {
    ...(contractVersion !== undefined ? { contractVersion } : {}),
    callerRef,
    bootstrapProvider,
    bootstrapModel,
    model,
    provider,
    targetRef,
    modelPolicyRef,
    purpose: body.purpose,
    idempotencyKey,
    messages,
    ...(metadata ? { metadata } : {}),
    correlationId,
  }
}

// ─── clientNotifications input validation (plan §2.7) ────────────────────

interface ParsedClientNotificationBody {
  callerRef: string
  eventType: string
  targetRef?: string
  userRef?: string
  idempotencyKey: string
  notification: {
    title: string
    body: string
    data?: Record<string, unknown>
    actionRef?: { type: string; id: string; urlRef?: string }
    deliveryPolicyRef?: string
    correlationId?: string
  }
}

function validateOpaqueRef(
  value: string,
  field: string,
  maxLength: number,
  res: Response
): boolean {
  if (value.length > maxLength) {
    res.status(400).json({ error: `${field} exceeds maximum length of ${maxLength}` })
    return false
  }
  if (EMAIL_LIKE_RE.test(value) || PHONE_LIKE_RE.test(value)) {
    res.status(400).json({
      error: `${field} must be an opaque reference, not a raw channel address`,
    })
    return false
  }
  return true
}

function parseClientNotificationBody(
  body: Record<string, unknown>,
  res: Response
): ParsedClientNotificationBody | null {
  const callerRef = validateCallerRef(body.callerRef, res)
  if (!callerRef) return null

  const idempotencyKey = validateIdempotencyKey(body.idempotencyKey, res)
  if (!idempotencyKey) return null

  if (typeof body.eventType !== 'string' || !body.eventType.trim()) {
    res.status(400).json({ error: 'eventType is required' })
    return null
  }
  const eventType = body.eventType.trim()
  if (eventType.length > 128) {
    res.status(400).json({ error: 'eventType exceeds maximum length of 128' })
    return null
  }

  const target = isPlainObject(body.target) ? body.target : undefined
  const targetRef =
    target && typeof target.targetRef === 'string' && target.targetRef.trim()
      ? target.targetRef.trim()
      : undefined
  const userRef =
    typeof body.userRef === 'string' && body.userRef.trim() ? body.userRef.trim() : undefined
  if ((targetRef === undefined) === (userRef === undefined)) {
    res.status(400).json({ error: 'exactly one of target.targetRef or userRef is required' })
    return null
  }
  if (targetRef && !validateOpaqueRef(targetRef, 'target.targetRef', MAX_TARGET_REF_LENGTH, res)) {
    return null
  }
  if (userRef && !validateOpaqueRef(userRef, 'userRef', MAX_USER_REF_LENGTH, res)) {
    return null
  }

  if (!isPlainObject(body.notification)) {
    res.status(400).json({ error: 'notification is required' })
    return null
  }
  const notification = body.notification
  if (typeof notification.title !== 'string' || !notification.title.trim()) {
    res.status(400).json({ error: 'notification.title is required' })
    return null
  }
  if (Buffer.byteLength(notification.title, 'utf8') > DEFAULT_MAX_TITLE_BYTES) {
    res.status(413).json({ error: 'payload_too_large', retryable: false })
    return null
  }
  if (typeof notification.body !== 'string') {
    res.status(400).json({ error: 'notification.body is required' })
    return null
  }
  if (Buffer.byteLength(notification.body, 'utf8') > DEFAULT_MAX_BODY_BYTES) {
    res.status(413).json({ error: 'payload_too_large', retryable: false })
    return null
  }

  const actionRefRaw = isPlainObject(notification.actionRef) ? notification.actionRef : undefined
  if (notification.actionRef !== undefined && !actionRefRaw) {
    res.status(400).json({ error: 'notification.actionRef must be { type, id, urlRef? }' })
    return null
  }
  // A present actionRef object MUST carry string `type` and `id`. Without this
  // guard, a malformed object (e.g. { type: 42, id: null }) would be silently
  // coerced to `undefined` below and the request would succeed while dropping
  // the actionRef with no feedback to the caller.
  if (
    actionRefRaw &&
    (typeof actionRefRaw.type !== 'string' || typeof actionRefRaw.id !== 'string')
  ) {
    res.status(400).json({ error: 'notification.actionRef must have string type and id' })
    return null
  }
  const actionRef =
    actionRefRaw && typeof actionRefRaw.type === 'string' && typeof actionRefRaw.id === 'string'
      ? {
          type: actionRefRaw.type,
          id: actionRefRaw.id,
          ...(typeof actionRefRaw.urlRef === 'string' ? { urlRef: actionRefRaw.urlRef } : {}),
        }
      : undefined

  return {
    callerRef,
    eventType,
    targetRef,
    userRef,
    idempotencyKey,
    notification: {
      title: notification.title,
      body: notification.body,
      data: isPlainObject(notification.data) ? notification.data : undefined,
      actionRef,
      deliveryPolicyRef:
        typeof notification.deliveryPolicyRef === 'string'
          ? notification.deliveryPolicyRef
          : undefined,
      correlationId:
        typeof notification.correlationId === 'string'
          ? notification.correlationId.slice(0, 256)
          : undefined,
    },
  }
}

// ─── Router ──────────────────────────────────────────────────────────────

async function handlePromptBridgeAuthorization(
  req: Request,
  res: Response,
  options: {
    requireContractVersion: boolean
    requireBootstrapBinding: boolean
  }
): Promise<void> {
  const claims = req.mcpHostJwt!
  const body = isPlainObject(req.body) ? req.body : {}
  if (!checkRecipeBinding(body, claims, res)) return
  const parsed = parsePromptBridgeBody(body, res, options)
  if (!parsed) return

  const result = await authorizePromptBridge({
    claims,
    callerRef: parsed.callerRef,
    bootstrapProvider: parsed.bootstrapProvider,
    bootstrapModel: parsed.bootstrapModel,
    model: parsed.model,
    provider: parsed.provider,
    targetRef: parsed.targetRef,
    modelPolicyRef: parsed.modelPolicyRef,
    purpose: parsed.purpose,
    idempotencyKey: parsed.idempotencyKey,
    payload: {
      messages: parsed.messages,
      model: parsed.model ?? null,
      provider: parsed.provider ?? null,
      targetRef: parsed.targetRef ?? null,
      modelPolicyRef: parsed.modelPolicyRef ?? null,
      purpose: parsed.purpose,
      ...(parsed.metadata ? { metadata: parsed.metadata } : {}),
    },
    correlationId: parsed.correlationId,
  })
  if (!result.ok) {
    sendAuthzError(res, result)
    return
  }

  res.status(result.value.replay ? 200 : 201).json({
    ...(options.requireContractVersion
      ? { contractVersion: PLUGIN_WORKLOAD_SDK_PROMPT_BRIDGE_CONTRACT_VERSION }
      : {}),
    invocationId: result.value.invocationId,
    replay: result.value.replay,
    providerCallRequired: result.value.providerCallRequired,
    status: result.value.status,
    model: result.value.model,
    modelPolicy: result.value.modelPolicy,
    selectedTarget: result.value.selectedTarget,
    authorizedTargets: result.value.authorizedTargets,
    attemptGeneration: result.value.attemptGeneration,
    policyRevision: result.value.policyRevision,
    policyHash: result.value.policyHash,
    maxOutputTokens: result.value.maxOutputTokens,
  })
}

export function createMcpHostPluginWorkloadSdkRoutes(): Router {
  const router = Router()

  // This router contains no unauthenticated endpoint. Apply the boundary
  // protections once, scoped to the SDK prefix, so newly added SDK routes
  // cannot accidentally omit either the pre-auth flood guard or the
  // recipe-scoped PG limiter (the outer app bounds JSON bodies).
  router.use(
    '/mcp-host/plugin-workload-sdk',
    rateLimit({
      windowMs: 60_000,
      // ENV-tunable pre-auth flood guard (issue #348):
      // CONTROL_API_PLUGIN_SDK_PREAUTH_PER_MIN.
      limit: config.pluginSdkPreauthRlPerMin,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: { error: 'Too Many Requests', retryable: true },
    }),
    requireMcpHostJwt,
    requirePluginWorkloadSdkScope,
    createPluginWorkloadSdkRequestRateLimit()
  )

  router.post(
    // JIT fallback-ticket contract for mcp-host:
    // - call only after the prior provider attempt has failed;
    // - provide invocationId + next targetRef, never a credential identity;
    // - redeem the returned ticket once, immediately before WRC reads the slot.
    // The server derives caller and allowed suffix from the persisted
    // invocation, verifies current policy, and emits a new one-shot jti.
    '/mcp-host/plugin-workload-sdk/prompt-bridge/credential-ticket',
    pluginWorkloadSdkCredentialRateLimit,
    asyncHandler(async (req, res) => {
      const claims = req.mcpHostJwt!
      const body = isPlainObject(req.body) ? req.body : {}
      if (!checkRecipeBinding(body, claims, res)) return
      const invocationId = typeof body.invocationId === 'string' ? body.invocationId.trim() : ''
      const targetRef = typeof body.targetRef === 'string' ? body.targetRef.trim() : ''
      const attemptGeneration = Number.isInteger(body.attemptGeneration)
        ? Number(body.attemptGeneration)
        : 0
      if (
        !invocationId ||
        !targetRef ||
        targetRef.length > MAX_TARGET_REF_LENGTH ||
        attemptGeneration < 1
      ) {
        res
          .status(400)
          .json({ error: 'invocationId, targetRef and attemptGeneration are required' })
        return
      }
      const result = await reissuePromptBridgeCredentialTicket({
        claims,
        invocationId,
        targetRef,
        attemptGeneration,
      })
      if (!result.ok) {
        sendAuthzError(res, result)
        return
      }
      res.status(201).json(result.value)
    })
  )

  // v2 is the only supported target-aware/JIT contract. There is no runtime
  // compatibility lane: old hosts must fail clearly and be upgraded rather
  // than bypassing target policy and per-attempt credential fencing.
  router.post(
    '/mcp-host/plugin-workload-sdk/prompt-bridge/v2',
    asyncHandler(async (req, res) =>
      handlePromptBridgeAuthorization(req, res, {
        requireContractVersion: true,
        requireBootstrapBinding: true,
      })
    )
  )

  router.get(
    '/mcp-host/plugin-workload-sdk/capabilities',
    asyncHandler(async (_req, res) => {
      const claims = _req.mcpHostJwt!
      const grant = await findGrant(claims.recipeNamespace, claims.recipeName, 'promptBridge')
      const clientNotificationsGrant = await findGrant(
        claims.recipeNamespace,
        claims.recipeName,
        'clientNotifications'
      )
      const v2Ready = Boolean(
        grant &&
        grant.policyState === 'active' &&
        grant.policyRevision >= 1 &&
        grant.policyReviewProvenancePresent !== false &&
        grant.promptTargets.length > 0 &&
        grant.defaultTargetRef !== null &&
        grant.promptTargets[0]?.targetRef === grant.defaultTargetRef
      )
      const clientNotificationsReady = Boolean(
        clientNotificationsGrant &&
        isClientNotificationsPolicyReady(clientNotificationsGrant) &&
        (await hasUsableClientNotificationRecipients(clientNotificationsGrant))
      )
      const primaryTarget = grant?.promptTargets[0] ?? null
      res.status(200).json({
        contractVersion: PLUGIN_WORKLOAD_SDK_PROMPT_BRIDGE_CONTRACT_VERSION,
        supportedContractVersions: [2, 3],
        targetAwarePromptBridge: true,
        attemptLedger: true,
        credentialTickets: true,
        policyState: grant?.policyState ?? 'missing',
        policyRevision: grant?.policyRevision ?? 0,
        policyHash: v2Ready && grant ? hashPromptTargetPolicy(grant) : null,
        defaultTargetRef: grant?.defaultTargetRef ?? null,
        defaultProvider: primaryTarget?.provider ?? null,
        defaultModel: primaryTarget?.model ?? null,
        defaultConnectionRef: primaryTarget?.connectionRef ?? null,
        v2Ready,
        clientNotificationsPolicyState: clientNotificationsGrant?.policyState ?? 'missing',
        clientNotificationsReady,
      })
    })
  )

  router.post(
    '/mcp-host/plugin-workload-sdk/client-notification',
    asyncHandler(async (req, res) => {
      const claims = req.mcpHostJwt!
      const body = isPlainObject(req.body) ? req.body : {}
      if (!checkRecipeBinding(body, claims, res)) return
      const parsed = parseClientNotificationBody(body, res)
      if (!parsed) return

      const authStartedAt = process.hrtime.bigint()
      const result = await authorizeClientNotification({
        claims,
        callerRef: parsed.callerRef,
        eventType: parsed.eventType,
        targetRef: parsed.targetRef,
        userRef: parsed.userRef,
        idempotencyKey: parsed.idempotencyKey,
        payload: {
          eventType: parsed.eventType,
          target: parsed.targetRef ?? null,
          userRef: parsed.userRef ?? null,
          notification: {
            title: parsed.notification.title,
            body: parsed.notification.body,
            data: parsed.notification.data ?? null,
            actionRef: parsed.notification.actionRef ?? null,
            deliveryPolicyRef: parsed.notification.deliveryPolicyRef ?? null,
          },
        },
        correlationId: parsed.notification.correlationId,
      })
      pluginWorkloadSdkNotificationAuthDurationSeconds.observe(
        { recipe: `${claims.recipeNamespace}/${claims.recipeName}` },
        Number(process.hrtime.bigint() - authStartedAt) / 1e9
      )
      if (!result.ok) {
        sendAuthzError(res, result)
        return
      }

      // Plan §4.2: the authorized intent is already persisted in the audit
      // trail; delivery enqueue is best-effort. If the Notification Service
      // path is down the caller still sees 'accepted' and delivery retries
      // ride on the queue once it recovers. Always attempt enqueue — even on
      // idempotency replay — because dedupe_key ON CONFLICT DO NOTHING makes
      // the insert safe and repairs a missing delivery row after cleanup.
      try {
        await enqueuePluginWorkloadSdkNotification(pool, {
          notificationId: result.value.notificationId,
          recipeNamespace: claims.recipeNamespace,
          recipeName: claims.recipeName,
          callerRef: parsed.callerRef,
          eventType: parsed.eventType,
          userRef: parsed.userRef,
          targetRef: parsed.targetRef,
          title: parsed.notification.title,
          body: parsed.notification.body,
          data: parsed.notification.data,
          actionRef: parsed.notification.actionRef,
          deliveryPolicyRef: parsed.notification.deliveryPolicyRef,
        })
      } catch (err) {
        req.log?.warn(
          { event: 'plugin_workload_sdk_notification_enqueue_failed', err },
          'plugin workload sdk notification enqueue failed (intent stays audited)'
        )
      }

      res.status(result.value.replay ? 200 : 201).json({
        notificationId: result.value.notificationId,
        replay: result.value.replay,
        status: result.value.status,
        eventType: parsed.eventType,
        target: { targetRef: parsed.targetRef, userRef: parsed.userRef },
      })
    })
  )

  // Recipient listing (read-only): returns the clientNotifications grant's
  // allowedUserRefs resolved to display labels so a recipe's sandbox UI can
  // render a recipient picker from the authoritative source. POST carries the
  // recipe binding in the body (same checkRecipeBinding contract as the send
  // path); it consumes no quota and writes no audit row.
  router.post(
    '/mcp-host/plugin-workload-sdk/client-notification/recipients',
    asyncHandler(async (req, res) => {
      const claims = req.mcpHostJwt!
      const body = isPlainObject(req.body) ? req.body : {}
      if (!checkRecipeBinding(body, claims, res)) return
      const callerRef = validateCallerRef(body.callerRef, res)
      if (!callerRef) return

      const result = await authorizeListRecipients({ claims, callerRef })
      if (!result.ok) {
        sendAuthzError(res, result)
        return
      }

      const recipients = await resolveRecipientProfiles(result.value.allowedUserRefs)
      res.status(200).json({ recipients })
    })
  )

  // TOCTOU guard for cross-provider credential resolution. The mcp-host must
  // re-check a short-lived signed target ticket immediately before reading its
  // credential slot. This endpoint returns no target data and never redeems a
  // secret; it only attests that the ticket still matches the current policy.
  router.post(
    '/mcp-host/plugin-workload-sdk/credential-ticket/introspect',
    pluginWorkloadSdkCredentialRateLimit,
    asyncHandler(async (req, res) => {
      const claims = req.mcpHostJwt!
      const body = isPlainObject(req.body) ? req.body : {}
      const ticket = typeof body.credentialTicket === 'string' ? body.credentialTicket : ''
      const invocationId = typeof body.invocationId === 'string' ? body.invocationId : ''
      const targetRef = typeof body.targetRef === 'string' ? body.targetRef : ''
      const providedAttemptGeneration = Number.isInteger(body.attemptGeneration)
        ? Number(body.attemptGeneration)
        : null
      const attemptGeneration = providedAttemptGeneration ?? 0
      const providerAttemptId =
        typeof body.providerAttemptId === 'string' ? body.providerAttemptId.trim() : ''
      const providerAttemptIndex = Number.isInteger(body.providerAttemptIndex)
        ? Number(body.providerAttemptIndex)
        : 0
      const redeem = body.redeem === true
      if (
        !ticket ||
        !invocationId ||
        !targetRef ||
        !providerAttemptId ||
        attemptGeneration < 1 ||
        providerAttemptIndex < 1
      ) {
        res.status(400).json({
          error:
            'credentialTicket, invocationId, targetRef, providerAttemptId and attemptGeneration are required',
        })
        return
      }
      const ticketClaims = verifyPluginWorkloadSdkCredentialTicket(ticket)
      if (
        !ticketClaims ||
        ticketClaims.recipeNamespace !== claims.recipeNamespace ||
        ticketClaims.recipeName !== claims.recipeName ||
        ticketClaims.sub !== `${claims.recipeNamespace}/${claims.recipeName}` ||
        ticketClaims.invocationId !== invocationId ||
        ticketClaims.targetRef !== targetRef ||
        ticketClaims.attemptGeneration !== attemptGeneration ||
        ticketClaims.providerAttemptId !== providerAttemptId ||
        ticketClaims.providerAttemptIndex !== providerAttemptIndex
      ) {
        res.status(403).json({ error: 'provider_policy_denied', retryable: false })
        return
      }
      const invocation = await getInvocationById(invocationId)
      if (
        !invocation ||
        invocation.recipeNamespace !== claims.recipeNamespace ||
        invocation.recipeName !== claims.recipeName ||
        invocation.method !== 'promptBridge' ||
        invocation.status !== 'in_progress' ||
        invocation.attemptGeneration !== attemptGeneration ||
        invocation.authorizationDecision !== 'authorized' ||
        !invocation.promptAuthorization ||
        !invocation.promptAuthorization.authorizedTargetRefs.includes(targetRef) ||
        invocation.promptAuthorization.policyRevision !== ticketClaims.policyRevision ||
        invocation.promptAuthorization.policyHash !== ticketClaims.policyHash
      ) {
        res.status(403).json({ error: 'provider_policy_denied', retryable: false })
        return
      }
      const receipt = await getPluginWorkloadSdkAttemptReceipt(invocationId, attemptGeneration)
      const providerAttempt = await getPluginWorkloadSdkProviderAttempt(providerAttemptId)
      if (
        !receipt ||
        receipt.recipeNamespace !== claims.recipeNamespace ||
        receipt.recipeName !== claims.recipeName ||
        receipt.method !== 'promptBridge' ||
        receipt.status !== 'in_progress' ||
        receipt.attemptGeneration !== attemptGeneration ||
        !providerAttempt ||
        providerAttempt.invocationId !== invocationId ||
        providerAttempt.attemptGeneration !== attemptGeneration ||
        providerAttempt.targetRef !== targetRef ||
        providerAttempt.status !== 'in_progress'
      ) {
        res.status(403).json({ error: 'provider_policy_denied', retryable: false })
        return
      }
      const grant = await findGrant(claims.recipeNamespace, claims.recipeName, 'promptBridge')
      const target = grant?.promptTargets.find(candidate => candidate.targetRef === targetRef)
      if (
        !grant ||
        grant.policyState !== 'active' ||
        !target ||
        grant.policyRevision !== ticketClaims.policyRevision ||
        hashPromptTargetPolicy(grant) !== ticketClaims.policyHash ||
        target.provider !== ticketClaims.provider ||
        target.model !== ticketClaims.model ||
        target.credentialSlot !== ticketClaims.credentialSlot
      ) {
        res.status(403).json({ error: 'provider_policy_denied', retryable: false })
        return
      }
      if (redeem) {
        const redeemed = await redeemPluginWorkloadSdkCredentialTicketJti({
          jti: ticketClaims.jti,
          recipeNamespace: claims.recipeNamespace,
          recipeName: claims.recipeName,
          invocationId,
          targetRef,
          attemptGeneration,
          providerAttemptId,
        })
        if (!redeemed) {
          res.status(403).json({ error: 'provider_policy_denied', retryable: false })
          return
        }
      }
      res.status(200).json({ active: true })
    })
  )

  // Invocation status reporting (plan §2.4 lifecycle): the mcp-host SDK
  // server reports promptBridge outcomes so the audit trail tracks
  // in_progress → complete | failed | provider_unavailable.
  router.post(
    '/mcp-host/plugin-workload-sdk/invocations/:id/status',
    asyncHandler(async (req, res) => {
      const claims = req.mcpHostJwt!
      const body = isPlainObject(req.body) ? req.body : {}
      if (!checkRecipeBinding(body, claims, res)) return

      const status = typeof body.status === 'string' ? body.status : ''
      const providedAttemptGeneration = Number.isInteger(body.attemptGeneration)
        ? Number(body.attemptGeneration)
        : null
      if (!['complete', 'failed', 'provider_unavailable'].includes(status)) {
        res
          .status(400)
          .json({ error: 'status must be one of: complete, failed, provider_unavailable' })
        return
      }
      const invocation = await getInvocationById(req.params.id)
      if (!invocation) {
        res.status(404).json({ error: 'invocation not found' })
        return
      }
      // Cross-recipe isolation: 403 without leaking row data.
      if (
        invocation.recipeNamespace !== claims.recipeNamespace ||
        invocation.recipeName !== claims.recipeName
      ) {
        res.status(403).json({ error: 'binding_mismatch' })
        return
      }

      const attemptGeneration = providedAttemptGeneration ?? invocation.attemptGeneration
      if (providedAttemptGeneration === null) {
        res.status(400).json({ error: 'attemptGeneration is required for contract v2' })
        return
      }
      if (attemptGeneration < 1) {
        res.status(400).json({ error: 'attemptGeneration is required' })
        return
      }

      const updated = await markInvocationStatus(
        invocation.id,
        status as 'complete' | 'failed' | 'provider_unavailable',
        {
          recipeNamespace: claims.recipeNamespace,
          recipeName: claims.recipeName,
          expectedCurrentStatus: 'in_progress',
          expectedAttemptGeneration: attemptGeneration,
        }
      )
      if (!updated) {
        res.status(409).json({ error: 'stale_attempt', retryable: false })
        return
      }
      res.status(200).json({ id: invocation.id, status })
    })
  )

  // Finalization is the SDK-only promptBridge accounting boundary. It binds
  // the provider receipt, logical invocation, and exact/unknown spend outcome
  // in one idempotent transaction; callers must not separately report status
  // and usage for this lane.
  router.post(
    '/mcp-host/plugin-workload-sdk/invocations/:id/finalize',
    asyncHandler(async (req, res) => {
      const claims = req.mcpHostJwt!
      const body = isPlainObject(req.body) ? req.body : {}
      if (!checkRecipeBinding(body, claims, res)) return
      const parsed = parsePromptBridgeFinalizationBody(body, claims, res)
      if (!parsed) return
      if (parsed.invocationId !== req.params.id) {
        res.status(400).json({ error: 'invocation id does not match path' })
        return
      }
      try {
        const result = await finalizePromptBridge(parsed)
        res.status(result.idempotent ? 200 : 201).json(result)
      } catch (error) {
        if (error instanceof PromptBridgeFinalizationError) {
          const errorCode =
            error.code === 'conflict'
              ? 'idempotency_conflict'
              : error.code === 'binding_mismatch'
                ? 'provider_policy_denied'
                : error.code === 'stale_attempt'
                  ? 'provider_unavailable'
                  : error.code === 'not_found'
                    ? 'invalid_request'
                    : error.code
          res.status(error.httpStatus).json({
            error: errorCode,
            message: error.message,
            retryable: false,
          })
          return
        }
        throw error
      }
    })
  )

  router.post(
    '/mcp-host/plugin-workload-sdk/provider-attempts/:id/status',
    asyncHandler(async (req, res) => {
      const claims = req.mcpHostJwt!
      const body = isPlainObject(req.body) ? req.body : {}
      if (!checkRecipeBinding(body, claims, res)) return
      const invocationId = typeof body.invocationId === 'string' ? body.invocationId.trim() : ''
      const attemptGeneration = Number.isInteger(body.attemptGeneration)
        ? Number(body.attemptGeneration)
        : 0
      const providerAttemptIndex = Number.isInteger(body.providerAttemptIndex)
        ? Number(body.providerAttemptIndex)
        : 0
      const status = body.status
      if (
        !invocationId ||
        attemptGeneration < 1 ||
        providerAttemptIndex < 1 ||
        !['complete', 'failed', 'provider_unavailable', 'skipped'].includes(String(status))
      ) {
        res.status(400).json({
          error: 'invocationId, attemptGeneration, providerAttemptIndex and status are required',
        })
        return
      }
      const attempt = await getPluginWorkloadSdkProviderAttempt(req.params.id)
      if (
        !attempt ||
        attempt.invocationId !== invocationId ||
        attempt.recipeNamespace !== claims.recipeNamespace ||
        attempt.recipeName !== claims.recipeName ||
        attempt.attemptGeneration !== attemptGeneration ||
        attempt.attemptIndex !== providerAttemptIndex
      ) {
        res.status(403).json({ error: 'provider_policy_denied', retryable: false })
        return
      }
      const updated = await markPluginWorkloadSdkProviderAttemptStatus({
        id: attempt.id,
        invocationId,
        recipeNamespace: claims.recipeNamespace,
        recipeName: claims.recipeName,
        attemptGeneration,
        status: status as 'complete' | 'failed' | 'provider_unavailable' | 'skipped',
      })
      if (!updated) {
        res.status(409).json({ error: 'stale_attempt', retryable: false })
        return
      }
      res.status(200).json({ id: attempt.id, status })
    })
  )

  router.get(
    '/mcp-host/plugin-workload-sdk/invocations/:recipeRef',
    asyncHandler(async (req, res) => {
      const claims = req.mcpHostJwt!
      // Cross-recipe isolation: the path recipeRef must match the JWT's
      // recipe binding (same 403 contract as approval /:id/status). Accepts
      // the bare recipeName or the fully-qualified '<namespace>/<name>'
      // form (URL-encoded slash) so callers can pin both binding halves.
      const recipeRef = req.params.recipeRef
      const qualifiedRef = `${claims.recipeNamespace}/${claims.recipeName}`
      if (recipeRef !== claims.recipeName && recipeRef !== qualifiedRef) {
        res.status(403).json({ error: 'binding_mismatch' })
        return
      }
      const items = await listInvocations({
        recipeNamespace: claims.recipeNamespace,
        recipeName: claims.recipeName,
        limit: 100,
      })
      res.status(200).json({ items })
    })
  )

  return router
}
