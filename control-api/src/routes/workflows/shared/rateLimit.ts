import type { Request, RequestHandler, Response } from 'express'
import { type RateLimitInfo, ipKeyGenerator, rateLimit } from 'express-rate-limit'
import { createHash } from 'node:crypto'
import { config } from '../../../config.js'
import { CalendarMinuteRateLimitStore } from '../../../middleware/calendarMinuteRateLimitStore.js'
import {
  type RateLimitEnforcerOptions,
  rateLimitMiddleware,
} from '../../../middleware/rateLimitMiddleware.js'
import { rateLimitHitsTotal } from '../../../observability/metrics.js'
import { externalSessionUserIdForRateLimit } from '../../../services/auth/externalSessionAuthentication.js'
import { verifyAdminToken } from '../../../utils/auth/adminAuthToken.js'
import {
  mcpHostVerifiedRateLimitPrincipal,
  verifyMcpHostAccessJwt,
} from '../../../utils/auth/mcpHostJwtToken.js'
import { CONTROL_UI_ADMIN_SESSION_COOKIE, readCookie } from '../../../utils/auth/sessionCookies.js'
import { extractBearerToken } from '../../../utils/extractBearerToken.js'

// Invalid credentials still use the original source-IP abuse budgets, and raised
// administrative capacity applies only after the existing signature check. The
// unauthenticated subscription OAuth callback has no credential to verify: it
// selects its budget by whether a `state` is present (see
// subscriptionOAuthCallbackRateLimits).
const UNVERIFIED_WORKFLOW_GRANT_READ_PER_MINUTE = 60
const UNVERIFIED_WORKFLOW_GRANT_WRITE_PER_MINUTE = 20
const UNVERIFIED_WORKFLOW_ADMIN_READ_PER_MINUTE = 60
const UNVERIFIED_ADMIN_OUTPUTS_READ_PER_MINUTE = 30
const WORKFLOW_TRIGGER_PER_MINUTE = 10
const UNVERIFIED_ADMIN_SUBSCRIPTION_READ_PER_MINUTE = 30
const UNVERIFIED_ADMIN_SUBSCRIPTION_WRITE_PER_MINUTE = 20
const SUBSCRIPTION_CALLBACK_IP_PER_MINUTE = 20

function hasVerifiedAdminCredential(req: Request): boolean {
  return verifiedAdminRateLimitIdentity(adminWorkflowRateLimitCredential(req)) !== null
}

/**
 * Reuse the existing enforcer with two budgets: `isVerified` selects the raised
 * one. For administrative families it is a signature check; for the OAuth
 * callback it only reports that a `state` is present.
 */
function withUnverifiedIpBudget(
  options: RateLimitEnforcerOptions & { getBucketKey: (req: Request) => string | null },
  unverifiedMaxPerMinute: number,
  isVerified: (req: Request) => boolean
): RequestHandler {
  const verified = rateLimitMiddleware(options)
  const unverified = rateLimitMiddleware({ ...options, maxPerMinute: unverifiedMaxPerMinute })
  return (req, res, next) => (isVerified(req) ? verified : unverified)(req, res, next)
}

/**
 * Credential surface matched by requireAdminWorkflowCaller: bearer for automation,
 * HttpOnly session cookie for Control UI browsers.
 */
export function adminWorkflowRateLimitCredential(req: Request): string | null {
  const bearer = extractBearerToken(req)
  if (bearer) return bearer
  const cookie = readCookie(req, CONTROL_UI_ADMIN_SESSION_COOKIE)
  return cookie || null
}

/** Extract the signed administrator subject for direct callers. */
export function verifiedAdminRateLimitSubject(credential: string | null): string | null {
  if (!credential) return null
  const claims = verifyAdminToken(credential)
  return claims?.sub || null
}

function hashedAdminWorkflowCredentialBucket(
  prefix: string,
  getCredential: (req: Request) => string | null = adminWorkflowRateLimitCredential
) {
  return (req: Request): string | null => {
    const credential = getCredential(req)
    const sessionIdentity = verifiedAdminRateLimitIdentity(credential)
    if (sessionIdentity) {
      const hash = createHash('sha256').update(sessionIdentity).digest('hex').slice(0, 32)
      return `${prefix}:${hash}`
    }
    if (!credential) return null
    return `${prefix}:ip:${ipKeyGenerator(req.ip ?? 'unknown')}`
  }
}

/**
 * Skip the edge backstop when no admin credential is present. Anonymous traffic
 * must not share a single IP bucket (Control UI proxy often omits XFF).
 */
export function shouldSkipWorkflowGrantEdgeRateLimit(req: Request): boolean {
  if (readCookie(req, CONTROL_UI_ADMIN_SESSION_COOKIE)) return false
  if (extractBearerToken(req)) return false
  return true
}

/**
 * Edge backstop key:
 * - Verified admin cookie/bearer → per-session bucket (isolates live sessions)
 * - Unverified credential → IP bucket (rotation cannot mint fresh identities)
 */
export function workflowGrantEdgeRateLimitKey(
  prefix: string,
  req: Request,
  getCredential: (req: Request) => string | null = adminWorkflowRateLimitCredential
): string {
  const sessionIdentity = verifiedAdminRateLimitIdentity(getCredential(req))
  if (sessionIdentity) {
    const hash = createHash('sha256').update(sessionIdentity).digest('hex').slice(0, 32)
    return `${prefix}:sub:${hash}`
  }
  return `${prefix}:ip:${ipKeyGenerator(req.ip ?? 'unknown')}`
}

function workflowGrantEdgeRateKey(prefix: string, getCredential: (req: Request) => string | null) {
  return (req: Request): string => workflowGrantEdgeRateLimitKey(prefix, req, getCredential)
}

function edgeRateLimitDenied(bucketType: string, req: Request, res: Response): void {
  const raw = res.getHeader('Retry-After')
  const retryAfterSeconds =
    typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0
      ? raw
      : typeof raw === 'string' && /^\d+$/.test(raw)
        ? Math.max(1, Number(raw))
        : 60
  const info = (req as Request & { rateLimit?: RateLimitInfo }).rateLimit
  rateLimitHitsTotal.inc({ bucket_type: bucketType, result: 'denied' }, 1)
  req.log?.warn(
    {
      event: 'rate_limit_denied',
      bucketType,
      count: info?.used,
      maxPerMinute: info?.limit,
      source: 'edge-memory',
      method: req.method,
      route: typeof req.route?.path === 'string' ? req.route.path : undefined,
    },
    'rate limit exceeded'
  )
  res.status(429).json({
    error: 'Too Many Requests',
    code: 'rate_limited',
    message: `This request limit has been reached. Try again in ${retryAfterSeconds} seconds.`,
    retryAfterSeconds,
  })
}

function createWorkflowEdgeRateLimit(
  prefix: string,
  limit: number,
  unverifiedLimit: number,
  getCredential: (req: Request) => string | null = adminWorkflowRateLimitCredential
) {
  return rateLimit({
    windowMs: 60_000,
    store: new CalendarMinuteRateLimitStore(),
    limit: req =>
      verifiedAdminRateLimitIdentity(getCredential(req)) !== null ? limit : unverifiedLimit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: req => getCredential(req) === null,
    keyGenerator: workflowGrantEdgeRateKey(prefix, getCredential),
    handler: (req, res) => edgeRateLimitDenied(prefix, req, res),
  })
}

/**
 * Fresh stack per call so route factories and tests can scope their stores.
 * Routers that own a rate-limit family instantiate the tuple once and reuse it.
 */
export function workflowGrantReadEdgeRateLimit() {
  return createWorkflowEdgeRateLimit(
    'workflow_grants_read_edge',
    config.adminWorkflowGrantReadPerMin,
    UNVERIFIED_WORKFLOW_GRANT_READ_PER_MINUTE
  )
}

export function workflowGrantWriteEdgeRateLimit() {
  return createWorkflowEdgeRateLimit(
    'workflow_grants_write_edge',
    config.adminWorkflowGrantWritePerMin,
    UNVERIFIED_WORKFLOW_GRANT_WRITE_PER_MINUTE
  )
}

export function workflowGrantReadRateLimits() {
  return [workflowGrantReadEdgeRateLimit(), workflowGrantReadRateLimit()] as const
}

export function workflowGrantWriteRateLimits() {
  return [workflowGrantWriteEdgeRateLimit(), workflowGrantWriteRateLimit()] as const
}

function workflowAdminReadEdgeRateLimit() {
  return createWorkflowEdgeRateLimit(
    'workflow_admin_read_edge',
    config.adminWorkflowReadPerMin,
    UNVERIFIED_WORKFLOW_ADMIN_READ_PER_MINUTE
  )
}

function adminOutputsReadEdgeRateLimit() {
  return createWorkflowEdgeRateLimit(
    'admin_outputs_read_edge',
    config.adminOutputsReadPerMin,
    UNVERIFIED_ADMIN_OUTPUTS_READ_PER_MINUTE
  )
}

export function workflowAdminReadRateLimits() {
  return [workflowAdminReadEdgeRateLimit(), workflowAdminReadRateLimit()] as const
}

export function adminOutputsReadRateLimits() {
  return [adminOutputsReadEdgeRateLimit(), adminOutputsReadRateLimit()] as const
}

/** Subscription routes follow their cookie-only parent authentication. */
function adminSubscriptionCredential(req: Request): string | null {
  return readCookie(req, CONTROL_UI_ADMIN_SESSION_COOKIE) || null
}

function hasVerifiedSubscriptionCredential(req: Request): boolean {
  return verifiedAdminRateLimitIdentity(adminSubscriptionCredential(req)) !== null
}

function adminSubscriptionReadEdgeRateLimit() {
  return createWorkflowEdgeRateLimit(
    'admin_subscription_read_edge',
    config.adminSubscriptionReadPerMin,
    UNVERIFIED_ADMIN_SUBSCRIPTION_READ_PER_MINUTE,
    adminSubscriptionCredential
  )
}

function adminSubscriptionWriteEdgeRateLimit() {
  return createWorkflowEdgeRateLimit(
    'admin_subscription_write_edge',
    config.adminSubscriptionWritePerMin,
    UNVERIFIED_ADMIN_SUBSCRIPTION_WRITE_PER_MINUTE,
    adminSubscriptionCredential
  )
}

function adminSubscriptionReadRateLimit() {
  return withUnverifiedIpBudget(
    {
      bucketType: 'admin_subscription_read',
      maxPerMinute: config.adminSubscriptionReadPerMin,
      getBucketKey: hashedAdminWorkflowCredentialBucket(
        'admin_subscription_read',
        adminSubscriptionCredential
      ),
      onBackendUnavailable: 'process-memory',
    },
    UNVERIFIED_ADMIN_SUBSCRIPTION_READ_PER_MINUTE,
    hasVerifiedSubscriptionCredential
  )
}

function adminSubscriptionWriteRateLimit() {
  return withUnverifiedIpBudget(
    {
      bucketType: 'admin_subscription_write',
      maxPerMinute: config.adminSubscriptionWritePerMin,
      getBucketKey: hashedAdminWorkflowCredentialBucket(
        'admin_subscription_write',
        adminSubscriptionCredential
      ),
      onBackendUnavailable: 'process-memory',
    },
    UNVERIFIED_ADMIN_SUBSCRIPTION_WRITE_PER_MINUTE,
    hasVerifiedSubscriptionCredential
  )
}

export function adminSubscriptionReadRateLimits() {
  return [adminSubscriptionReadEdgeRateLimit(), adminSubscriptionReadRateLimit()] as const
}

export function adminSubscriptionWriteRateLimits() {
  return [adminSubscriptionWriteEdgeRateLimit(), adminSubscriptionWriteRateLimit()] as const
}

function subscriptionOAuthCallbackBucketKey(req: Request): string {
  const state = typeof req.query.state === 'string' ? req.query.state.trim() : ''
  if (state) {
    const hash = createHash('sha256').update(state).digest('hex').slice(0, 32)
    return `subscription_oauth_callback:state:${hash}`
  }
  return `subscription_oauth_callback:ip:${ipKeyGenerator(req.ip ?? 'unknown')}`
}

/**
 * Callback limiters, in order:
 * 1. A per-source-IP ceiling across every `state`, edge only, so rotating
 *    `state` values cannot mint unbounded buckets from one address. It adds no
 *    PostgreSQL key: a ledger-backed ceiling would add the write it bounds. The
 *    key must not reuse `subscription_oauth_callback:ip:`, which is the
 *    no-state bucket below.
 * 2. The per-`state` edge limiter (the no-state IP safeguard without one).
 * 3. The PostgreSQL gate shared across replicas.
 */
export function subscriptionOAuthCallbackRateLimits() {
  const hasState = (req: Request) =>
    typeof req.query.state === 'string' && req.query.state.trim().length > 0
  return [
    rateLimit({
      windowMs: 60_000,
      store: new CalendarMinuteRateLimitStore(),
      limit: config.subscriptionOAuthCallbackPerMin,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      keyGenerator: req =>
        `subscription_oauth_callback_ip_ceiling:ip:${ipKeyGenerator(req.ip ?? 'unknown')}`,
      handler: (req, res) =>
        edgeRateLimitDenied('subscription_oauth_callback_ip_ceiling_edge', req, res),
    }),
    rateLimit({
      windowMs: 60_000,
      store: new CalendarMinuteRateLimitStore(),
      limit: req =>
        hasState(req)
          ? config.subscriptionOAuthCallbackPerMin
          : SUBSCRIPTION_CALLBACK_IP_PER_MINUTE,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      keyGenerator: subscriptionOAuthCallbackBucketKey,
      handler: (req, res) => edgeRateLimitDenied('subscription_oauth_callback_edge', req, res),
    }),
    withUnverifiedIpBudget(
      {
        bucketType: 'subscription_oauth_callback',
        maxPerMinute: config.subscriptionOAuthCallbackPerMin,
        getBucketKey: subscriptionOAuthCallbackBucketKey,
        onBackendUnavailable: 'process-memory',
      },
      SUBSCRIPTION_CALLBACK_IP_PER_MINUTE,
      hasState
    ),
  ] as const
}

/**
 * Authorize limiter key:
 * - Verified mcp-host access JWT → per-recipe `sub`, except standalone
 *   1st-party hosts which share that sentinel and must key by `hostRefs[0]`
 * - Missing or unverified bearer → client IP (rotation cannot mint buckets)
 */
function mcpHostAttemptRateLimitPrincipal(req: Request): string | null {
  const attached = mcpHostVerifiedRateLimitPrincipal(req.mcpHostJwt)
  // Always verify. Gating on bearer truthiness is a user-controlled skip of
  // the security check (CodeQL js/user-controlled-bypass). Empty or forged
  // tokens return null and share the IP bucket.
  const verified = mcpHostVerifiedRateLimitPrincipal(
    verifyMcpHostAccessJwt(extractBearerToken(req))
  )
  return attached ?? verified
}

export function mcpHostAttemptRateLimitKey(req: Request): string {
  const principal = mcpHostAttemptRateLimitPrincipal(req)
  if (principal) return `llm_provider_attempt:${principal}`
  return `llm_provider_attempt:ip:${ipKeyGenerator(req.ip ?? 'unknown')}`
}

export function llmProviderAttemptAuthorizeRateLimits() {
  const hasPrincipal = (req: Request) => mcpHostAttemptRateLimitPrincipal(req) !== null
  return [
    rateLimit({
      windowMs: 60_000,
      store: new CalendarMinuteRateLimitStore(),
      limit: req =>
        hasPrincipal(req)
          ? config.llmProviderAttemptAuthorizePerMin
          : config.llmProviderAttemptAuthorizeAnonymousIpPerMin,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      keyGenerator: mcpHostAttemptRateLimitKey,
      handler: (req, res) => edgeRateLimitDenied('llm_provider_attempt_authorize_edge', req, res),
    }),
    withUnverifiedIpBudget(
      {
        bucketType: 'llm_provider_attempt_authorize',
        maxPerMinute: config.llmProviderAttemptAuthorizePerMin,
        getBucketKey: mcpHostAttemptRateLimitKey,
        onBackendUnavailable: 'process-memory',
      },
      config.llmProviderAttemptAuthorizeAnonymousIpPerMin,
      hasPrincipal
    ),
  ] as const
}

function adminWorkflowTriggerRateLimitKey(req: Request): string | null {
  const value = adminWorkflowRateLimitCredential(req)
  if (!value) return null
  const identity = verifiedAdminRateLimitIdentity(value)
  if (identity) {
    const hash = createHash('sha256').update(identity).digest('hex').slice(0, 32)
    return `workflow_trigger_admin:${hash}`
  }
  return `workflow_trigger_admin:ip:${ipKeyGenerator(req.ip ?? 'unknown')}`
}

export function adminWorkflowTriggerRateLimit() {
  return withUnverifiedIpBudget(
    {
      bucketType: 'workflow_trigger',
      maxPerMinute: config.adminWorkflowTriggerPerMin,
      getBucketKey: adminWorkflowTriggerRateLimitKey,
      onBackendUnavailable: 'process-memory',
    },
    WORKFLOW_TRIGGER_PER_MINUTE,
    hasVerifiedAdminCredential
  )
}

function hashedWorkflowTriggerBucket(credential: string): string {
  const hash = createHash('sha256').update(credential).digest('hex').slice(0, 32)
  return `workflow_trigger:${hash}`
}

function workflowTriggerRateLimitFor(getCredential: (req: Request) => string | null) {
  return rateLimitMiddleware({
    bucketType: 'workflow_trigger',
    maxPerMinute: WORKFLOW_TRIGGER_PER_MINUTE,
    getBucketKey: (req: Request) => {
      const credential = getCredential(req)
      if (!credential) return null
      return hashedWorkflowTriggerBucket(credential)
    },
    onBackendUnavailable: 'process-memory',
  })
}

function unverifiedTriggerIpCredential(req: Request): string {
  return `ip:${ipKeyGenerator(req.ip ?? 'unknown')}`
}

/** Stable per-account key. Raw tokens rotate and must not mint new buckets. */
function verifiedUserSessionRateLimitSubject(token: string): string | null {
  const userId = externalSessionUserIdForRateLimit(token)
  return userId ? `user:${userId}` : null
}

/**
 * External trigger lane: prefer the canonical authenticated session identity
 * staged before this limiter for either V1 or V2. A raw unverified session
 * header falls back to IP so rotation cannot evade the cap.
 */
export function workflowTriggerRateLimitCredential(req: Request): string | null {
  const stagedUserId = (req as Request & { externalAuth?: { userId?: string } }).externalAuth
    ?.userId
  if (stagedUserId) return `user:${stagedUserId}`

  const userSessionToken = String(req.header('x-user-session-token') || '').trim()
  if (userSessionToken) {
    return (
      verifiedUserSessionRateLimitSubject(userSessionToken) || unverifiedTriggerIpCredential(req)
    )
  }

  const cookie = readCookie(req, CONTROL_UI_ADMIN_SESSION_COOKIE)
  const cookieSubject = verifiedAdminRateLimitSubject(cookie)
  if (cookieSubject) return cookieSubject
  if (cookie) {
    return unverifiedTriggerIpCredential(req)
  }

  const bearer = extractBearerToken(req)
  if (bearer) {
    return verifiedAdminRateLimitSubject(bearer) || bearer
  }
  return null
}

/** mcp-host trigger lane: the authenticated principal is the bearer only. */
export function mcpHostWorkflowTriggerRateLimitCredential(req: Request): string | null {
  return extractBearerToken(req)
}

export function workflowTriggerRateLimit() {
  return workflowTriggerRateLimitFor(workflowTriggerRateLimitCredential)
}

export function mcpHostWorkflowTriggerRateLimit() {
  return workflowTriggerRateLimitFor(mcpHostWorkflowTriggerRateLimitCredential)
}

function workflowAdminReadRateLimit() {
  return withUnverifiedIpBudget(
    {
      bucketType: 'workflow_admin_read',
      maxPerMinute: config.adminWorkflowReadPerMin,
      getBucketKey: hashedAdminWorkflowCredentialBucket('workflow_admin_read'),
      onBackendUnavailable: 'process-memory',
    },
    UNVERIFIED_WORKFLOW_ADMIN_READ_PER_MINUTE,
    hasVerifiedAdminCredential
  )
}

function adminOutputsReadRateLimit() {
  return withUnverifiedIpBudget(
    {
      bucketType: 'admin_outputs_read',
      maxPerMinute: config.adminOutputsReadPerMin,
      getBucketKey: hashedAdminWorkflowCredentialBucket('admin_outputs_read'),
      onBackendUnavailable: 'process-memory',
    },
    UNVERIFIED_ADMIN_OUTPUTS_READ_PER_MINUTE,
    hasVerifiedAdminCredential
  )
}

export function workflowGrantReadRateLimit() {
  return withUnverifiedIpBudget(
    {
      bucketType: 'workflow_grants_read',
      maxPerMinute: config.adminWorkflowGrantReadPerMin,
      getBucketKey: hashedAdminWorkflowCredentialBucket('workflow_grants_read'),
      onBackendUnavailable: 'process-memory',
    },
    UNVERIFIED_WORKFLOW_GRANT_READ_PER_MINUTE,
    hasVerifiedAdminCredential
  )
}

export function workflowGrantWriteRateLimit() {
  return withUnverifiedIpBudget(
    {
      bucketType: 'workflow_grants_write',
      maxPerMinute: config.adminWorkflowGrantWritePerMin,
      getBucketKey: hashedAdminWorkflowCredentialBucket('workflow_grants_write'),
      onBackendUnavailable: 'process-memory',
    },
    UNVERIFIED_WORKFLOW_GRANT_WRITE_PER_MINUTE,
    hasVerifiedAdminCredential
  )
}

/** Keep distinct signed sessions in distinct pre-auth quota buckets. */
export function verifiedAdminRateLimitIdentity(input: string | null): string | null {
  if (!input || !verifiedAdminRateLimitSubject(input)) return null
  return input
}
