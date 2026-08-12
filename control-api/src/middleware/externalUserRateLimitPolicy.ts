import type { NextFunction, Request, Response } from 'express'
import { sendPublicApiError } from '../http/publicApiError.js'
import { checkAndIncrement } from '../services/rateLimiterService.js'

type AuthenticatedRequest = Request & { externalAuth?: { userId?: string } }

export type ExternalUserRateLimitOperation =
  | 'session_lifecycle'
  | 'invitation_mutation'
  | 'invitation_sensitive_action'
  | 'invitation_read'
  | 'access_capabilities'

type RateLimitStage = 'pre_auth' | 'authenticated'

type Policy = Readonly<{ bucketType: string; maxPerMinute: number }>

// These reuse the established 10/minute sensitive access envelope; no new
// production limit is selected here.
const POLICIES: Readonly<Record<ExternalUserRateLimitOperation, Policy>> = {
  session_lifecycle: { bucketType: 'external_session_lifecycle', maxPerMinute: 10 },
  invitation_mutation: { bucketType: 'external_invitation_mutation', maxPerMinute: 10 },
  invitation_sensitive_action: {
    bucketType: 'external_invitation_sensitive_action',
    maxPerMinute: 10,
  },
  invitation_read: { bucketType: 'external_invitation_read', maxPerMinute: 10 },
  access_capabilities: { bucketType: 'external_access_capabilities', maxPerMinute: 10 },
}

function boundedIp(req: Request): string {
  const value = req.ip ?? req.socket?.remoteAddress ?? 'unknown'
  return String(value).slice(0, 128)
}

function keyFor(
  operation: ExternalUserRateLimitOperation,
  stage: RateLimitStage,
  req: AuthenticatedRequest
): string {
  const policy = POLICIES[operation]
  if (stage === 'pre_auth') return `${policy.bucketType}:ip:${boundedIp(req)}`
  const userId = req.externalAuth?.userId
  // This middleware is composed after successful authentication. A bounded
  // sentinel preserves the limiter's accounting contract if a route is wired
  // incorrectly instead of silently failing open.
  return `${policy.bucketType}:user:${userId || 'missing'}`
}

function sendLimited(req: Request, res: Response, retryAfterSeconds: number): void {
  res.setHeader('Retry-After', String(retryAfterSeconds))
  sendPublicApiError(
    req,
    res,
    429,
    'rate_limited',
    'Too many security-sensitive requests; retry later.',
    true,
    { retryAfterSeconds }
  )
}

async function enforce(
  operation: ExternalUserRateLimitOperation,
  stage: RateLimitStage,
  req: AuthenticatedRequest,
  res: Response
): Promise<boolean> {
  const policy = POLICIES[operation]
  const result = await checkAndIncrement(keyFor(operation, stage, req), policy.maxPerMinute)
  res.setHeader('X-RateLimit-Limit', String(policy.maxPerMinute))
  res.setHeader('X-RateLimit-Remaining', String(result.remaining))
  res.setHeader('X-RateLimit-Reset', String(Math.floor(result.resetMs / 1000)))
  if (result.allowed) return true
  sendLimited(req, res, Math.max(1, Math.ceil((result.resetMs - Date.now()) / 1000)))
  return false
}

export function preAuthExternalUserRateLimit(operation: ExternalUserRateLimitOperation) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void enforce(operation, 'pre_auth', req as AuthenticatedRequest, res)
      .then(allowed => {
        if (allowed) next()
      })
      .catch(next)
  }
}

export function authenticatedExternalUserRateLimit(operation: ExternalUserRateLimitOperation) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void enforce(operation, 'authenticated', req as AuthenticatedRequest, res)
      .then(allowed => {
        if (allowed) next()
      })
      .catch(next)
  }
}

export async function enforceAuthenticatedExternalUserRateLimit(
  operation: ExternalUserRateLimitOperation,
  req: Request,
  res: Response,
  principal: Readonly<{ userId: string }>
): Promise<boolean> {
  const authenticated = req as AuthenticatedRequest
  authenticated.externalAuth = principal
  return enforce(operation, 'authenticated', authenticated, res)
}

export const externalUserRateLimitPolicy = Object.freeze({ keyFor })
