import type { Request, Response } from 'express'
import { ipKeyGenerator, rateLimit } from 'express-rate-limit'
import { createHash } from 'node:crypto'
import { rateLimitMiddleware } from '../../../middleware/rateLimitMiddleware.js'
import { verifyAdminToken } from '../../../utils/auth/adminAuthToken.js'
import { CONTROL_UI_ADMIN_SESSION_COOKIE, readCookie } from '../../../utils/auth/sessionCookies.js'
import { extractBearerToken } from '../../../utils/extractBearerToken.js'

const WORKFLOW_GRANT_READ_PER_MINUTE = 60
const WORKFLOW_GRANT_WRITE_PER_MINUTE = 20
const WORKFLOW_ADMIN_READ_PER_MINUTE = 60
const ADMIN_OUTPUTS_READ_PER_MINUTE = 30
const WORKFLOW_TRIGGER_PER_MINUTE = 10
const ADMIN_CODEX_READ_PER_MINUTE = 30
const ADMIN_CODEX_WRITE_PER_MINUTE = 20
const CODEX_OAUTH_CALLBACK_PER_MINUTE = 20
const LLM_PROVIDER_ATTEMPT_AUTHORIZE_PER_MINUTE = 60

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

function hashedAdminWorkflowCredentialBucket(prefix: string) {
  return (req: Request): string | null => {
    const credential = adminWorkflowRateLimitCredential(req)
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
export function workflowGrantEdgeRateLimitKey(prefix: string, req: Request): string {
  const sessionIdentity = verifiedAdminRateLimitIdentity(adminWorkflowRateLimitCredential(req))
  if (sessionIdentity) {
    const hash = createHash('sha256').update(sessionIdentity).digest('hex').slice(0, 32)
    return `${prefix}:sub:${hash}`
  }
  return `${prefix}:ip:${ipKeyGenerator(req.ip ?? 'unknown')}`
}

function workflowGrantEdgeRateKey(prefix: string) {
  return (req: Request): string => workflowGrantEdgeRateLimitKey(prefix, req)
}

function workflowGrantEdgeRateLimitHandler(_req: Request, res: Response): void {
  const raw = res.getHeader('Retry-After')
  const retryAfterSeconds =
    typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0
      ? raw
      : typeof raw === 'string' && /^\d+$/.test(raw)
        ? Math.max(1, Number(raw))
        : 60
  res.status(429).json({ error: 'Too Many Requests', retryAfterSeconds })
}

function createWorkflowEdgeRateLimit(prefix: string, limit: number) {
  return rateLimit({
    windowMs: 60_000,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: shouldSkipWorkflowGrantEdgeRateLimit,
    keyGenerator: workflowGrantEdgeRateKey(prefix),
    handler: workflowGrantEdgeRateLimitHandler,
  })
}

/**
 * Fresh stack per call so route factories and tests can scope their stores.
 * Routers that own a rate-limit family instantiate the tuple once and reuse it.
 */
export function workflowGrantReadEdgeRateLimit() {
  return createWorkflowEdgeRateLimit('workflow_grants_read_edge', WORKFLOW_GRANT_READ_PER_MINUTE)
}

export function workflowGrantWriteEdgeRateLimit() {
  return createWorkflowEdgeRateLimit('workflow_grants_write_edge', WORKFLOW_GRANT_WRITE_PER_MINUTE)
}

export function workflowGrantReadRateLimits() {
  return [workflowGrantReadEdgeRateLimit(), workflowGrantReadRateLimit()] as const
}

export function workflowGrantWriteRateLimits() {
  return [workflowGrantWriteEdgeRateLimit(), workflowGrantWriteRateLimit()] as const
}

function workflowAdminReadEdgeRateLimit() {
  return createWorkflowEdgeRateLimit('workflow_admin_read_edge', WORKFLOW_ADMIN_READ_PER_MINUTE)
}

function adminOutputsReadEdgeRateLimit() {
  return createWorkflowEdgeRateLimit('admin_outputs_read_edge', ADMIN_OUTPUTS_READ_PER_MINUTE)
}

export function workflowAdminReadRateLimits() {
  return [workflowAdminReadEdgeRateLimit(), workflowAdminReadRateLimit()] as const
}

export function adminOutputsReadRateLimits() {
  return [adminOutputsReadEdgeRateLimit(), adminOutputsReadRateLimit()] as const
}

function adminCodexReadEdgeRateLimit() {
  return createWorkflowEdgeRateLimit('admin_codex_read_edge', ADMIN_CODEX_READ_PER_MINUTE)
}

function adminCodexWriteEdgeRateLimit() {
  return createWorkflowEdgeRateLimit('admin_codex_write_edge', ADMIN_CODEX_WRITE_PER_MINUTE)
}

function adminCodexReadRateLimit() {
  return rateLimitMiddleware({
    bucketType: 'admin_codex_read',
    maxPerMinute: ADMIN_CODEX_READ_PER_MINUTE,
    getBucketKey: hashedAdminWorkflowCredentialBucket('admin_codex_read'),
  })
}

function adminCodexWriteRateLimit() {
  return rateLimitMiddleware({
    bucketType: 'admin_codex_write',
    maxPerMinute: ADMIN_CODEX_WRITE_PER_MINUTE,
    getBucketKey: hashedAdminWorkflowCredentialBucket('admin_codex_write'),
  })
}

export function adminCodexReadRateLimits() {
  return [adminCodexReadEdgeRateLimit(), adminCodexReadRateLimit()] as const
}

export function adminCodexWriteRateLimits() {
  return [adminCodexWriteEdgeRateLimit(), adminCodexWriteRateLimit()] as const
}

export function codexOAuthCallbackRateLimits() {
  return [
    rateLimit({
      windowMs: 60_000,
      limit: CODEX_OAUTH_CALLBACK_PER_MINUTE,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      keyGenerator: (req: Request) =>
        `codex_oauth_callback:ip:${ipKeyGenerator(req.ip ?? 'unknown')}`,
      handler: workflowGrantEdgeRateLimitHandler,
    }),
    rateLimitMiddleware({
      bucketType: 'codex_oauth_callback',
      maxPerMinute: CODEX_OAUTH_CALLBACK_PER_MINUTE,
      getBucketKey: (req: Request) =>
        `codex_oauth_callback:ip:${ipKeyGenerator(req.ip ?? 'unknown')}`,
    }),
  ] as const
}

export function llmProviderAttemptAuthorizeRateLimits() {
  return [
    rateLimit({
      windowMs: 60_000,
      limit: LLM_PROVIDER_ATTEMPT_AUTHORIZE_PER_MINUTE,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      skip: (req: Request) => !req.mcpHostJwt,
      keyGenerator: (req: Request) => {
        const claims = req.mcpHostJwt
        if (!claims) return `llm_provider_attempt:anon:${ipKeyGenerator(req.ip ?? 'unknown')}`
        return `llm_provider_attempt:${claims.sub}`
      },
      handler: workflowGrantEdgeRateLimitHandler,
    }),
    rateLimitMiddleware({
      bucketType: 'llm_provider_attempt_authorize',
      maxPerMinute: LLM_PROVIDER_ATTEMPT_AUTHORIZE_PER_MINUTE,
      getBucketKey: (req: Request) => {
        const claims = req.mcpHostJwt
        if (!claims) return null
        return `llm_provider_attempt:${claims.sub}`
      },
    }),
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
  return rateLimitMiddleware({
    bucketType: 'workflow_trigger',
    maxPerMinute: WORKFLOW_TRIGGER_PER_MINUTE,
    getBucketKey: adminWorkflowTriggerRateLimitKey,
  })
}

function workflowTriggerRateLimitCredential(req: Request): string | null {
  const bearer = extractBearerToken(req)
  if (bearer) {
    return verifiedAdminRateLimitSubject(bearer) || bearer
  }
  const userSessionToken = String(req.header('x-user-session-token') || '').trim()
  if (userSessionToken) return userSessionToken
  const cookieSubject = verifiedAdminRateLimitSubject(
    readCookie(req, CONTROL_UI_ADMIN_SESSION_COOKIE)
  )
  if (cookieSubject) return cookieSubject
  if (readCookie(req, CONTROL_UI_ADMIN_SESSION_COOKIE)) {
    return `ip:${ipKeyGenerator(req.ip ?? 'unknown')}`
  }
  return null
}

export function workflowTriggerRateLimit() {
  return rateLimitMiddleware({
    bucketType: 'workflow_trigger',
    maxPerMinute: WORKFLOW_TRIGGER_PER_MINUTE,
    getBucketKey: (req: Request) => {
      const credential = workflowTriggerRateLimitCredential(req)
      if (!credential) return null
      const hash = createHash('sha256').update(credential).digest('hex').slice(0, 32)
      return `workflow_trigger:${hash}`
    },
  })
}

function workflowAdminReadRateLimit() {
  return rateLimitMiddleware({
    bucketType: 'workflow_admin_read',
    maxPerMinute: WORKFLOW_ADMIN_READ_PER_MINUTE,
    getBucketKey: hashedAdminWorkflowCredentialBucket('workflow_admin_read'),
  })
}

function adminOutputsReadRateLimit() {
  return rateLimitMiddleware({
    bucketType: 'admin_outputs_read',
    maxPerMinute: ADMIN_OUTPUTS_READ_PER_MINUTE,
    getBucketKey: hashedAdminWorkflowCredentialBucket('admin_outputs_read'),
  })
}

export function workflowGrantReadRateLimit() {
  return rateLimitMiddleware({
    bucketType: 'workflow_grants_read',
    maxPerMinute: WORKFLOW_GRANT_READ_PER_MINUTE,
    getBucketKey: hashedAdminWorkflowCredentialBucket('workflow_grants_read'),
  })
}

export function workflowGrantWriteRateLimit() {
  return rateLimitMiddleware({
    bucketType: 'workflow_grants_write',
    maxPerMinute: WORKFLOW_GRANT_WRITE_PER_MINUTE,
    getBucketKey: hashedAdminWorkflowCredentialBucket('workflow_grants_write'),
  })
}

/** Keep distinct signed sessions in distinct pre-auth quota buckets. */
export function verifiedAdminRateLimitIdentity(input: string | null): string | null {
  if (!input || !verifiedAdminRateLimitSubject(input)) return null
  return input
}
