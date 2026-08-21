import type { Request, Response } from 'express'
import { ipKeyGenerator, rateLimit } from 'express-rate-limit'
import { createHash } from 'node:crypto'
import { rateLimitMiddleware } from '../../../middleware/rateLimitMiddleware.js'
import { CONTROL_UI_ADMIN_SESSION_COOKIE, readCookie } from '../../../utils/auth/sessionCookies.js'
import { extractBearerToken } from '../../../utils/extractBearerToken.js'

const WORKFLOW_GRANT_READ_PER_MINUTE = 60
const WORKFLOW_GRANT_WRITE_PER_MINUTE = 20

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

function hashedAdminWorkflowCredentialBucket(prefix: string) {
  return (req: Request): string | null => {
    const credential = adminWorkflowRateLimitCredential(req)
    if (!credential) return null
    const hash = createHash('sha256').update(credential).digest('hex').slice(0, 32)
    return `${prefix}:${hash}`
  }
}

/**
 * Ingress-style edge key: IP-only so unverified bearer rotation cannot evade the
 * backstop. Per-credential quotas remain on the PG limiter downstream.
 */
export function workflowGrantEdgeRateLimitKey(prefix: string, req: Request): string {
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

/**
 * CodeQL-visible edge backstop for admin workflow grant reads. The PG-backed
 * workflowGrantReadRateLimit() remains the cross-replica source of truth.
 */
export function workflowGrantReadEdgeRateLimit() {
  return rateLimit({
    windowMs: 60_000,
    limit: WORKFLOW_GRANT_READ_PER_MINUTE,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: workflowGrantEdgeRateKey('workflow_grants_read_edge'),
    handler: workflowGrantEdgeRateLimitHandler,
  })
}

/** CodeQL-visible edge backstop paired with workflowGrantWriteRateLimit(). */
export function workflowGrantWriteEdgeRateLimit() {
  return rateLimit({
    windowMs: 60_000,
    limit: WORKFLOW_GRANT_WRITE_PER_MINUTE,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: workflowGrantEdgeRateKey('workflow_grants_write_edge'),
    handler: workflowGrantEdgeRateLimitHandler,
  })
}

export function workflowGrantReadRateLimits() {
  return [workflowGrantReadEdgeRateLimit(), workflowGrantReadRateLimit()] as const
}

export function workflowGrantWriteRateLimits() {
  return [workflowGrantWriteEdgeRateLimit(), workflowGrantWriteRateLimit()] as const
}

export function workflowTriggerRateLimit() {
  return rateLimitMiddleware({
    bucketType: 'workflow_trigger',
    maxPerMinute: 10,
    getBucketKey: (req: Request) => {
      const bearer = extractBearerToken(req)
      const userSessionToken = req.header('x-user-session-token')
      const token = bearer || userSessionToken
      if (!token) return null
      const hash = createHash('sha256').update(token).digest('hex').slice(0, 32)
      return `workflow_trigger:${hash}`
    },
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
