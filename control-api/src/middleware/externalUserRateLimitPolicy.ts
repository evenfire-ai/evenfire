import type { NextFunction, Request, Response } from 'express'
import { sendPublicApiError } from '../http/publicApiError.js'
import { rateLimitMiddleware } from './rateLimitMiddleware.js'

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
  const forwardedClientIp =
    req.internalService?.name === 'external-rest-api'
      ? String(req.header('x-evenfire-client-ip') || '').trim()
      : ''
  const value = forwardedClientIp || req.ip || req.socket?.remoteAddress || 'unknown'
  return String(value).slice(0, 128)
}

function keyFor(
  operation: ExternalUserRateLimitOperation,
  stage: RateLimitStage,
  req: AuthenticatedRequest
): string {
  const policy = POLICIES[operation]
  if (stage === 'pre_auth') return `${policy.bucketType}:ip:${boundedIp(req)}`
  // Post-auth routes are composed after live authentication. The sentinel is
  // deliberately counted if wiring is wrong rather than silently failing open.
  return `${policy.bucketType}:user:${req.externalAuth?.userId || 'missing'}`
}

function sendLimited(req: Request, res: Response, retryAfterSeconds: number): void {
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

function policyMiddleware(operation: ExternalUserRateLimitOperation, stage: RateLimitStage) {
  const policy = POLICIES[operation]
  return rateLimitMiddleware({
    bucketType: policy.bucketType,
    maxPerMinute: policy.maxPerMinute,
    getBucketKey: req => keyFor(operation, stage, req as AuthenticatedRequest),
    onLimited: sendLimited,
  })
}

/** Typed policy selection only; rateLimitMiddleware performs every bucket operation. */
export function preAuthExternalUserRateLimit(operation: ExternalUserRateLimitOperation) {
  return policyMiddleware(operation, 'pre_auth')
}

/** Compose this only after trusted live authentication has populated externalAuth. */
export function authenticatedExternalUserRateLimit(operation: ExternalUserRateLimitOperation) {
  return [
    (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
      if (!req.externalAuth?.userId) {
        sendPublicApiError(req, res, 401, 'invalid_session', 'The session is not valid.')
        return
      }
      next()
    },
    policyMiddleware(operation, 'authenticated'),
  ] as const
}

export const externalUserRateLimitPolicy = Object.freeze({ keyFor })
