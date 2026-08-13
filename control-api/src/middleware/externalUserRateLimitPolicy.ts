import type { NextFunction, Request, Response } from 'express'
import { sendPublicApiError } from '../http/publicApiError.js'

type AuthenticatedRequest = Request & { externalAuth?: { userId?: string } }

export type ExternalUserRateLimitOperation =
  | 'session_lifecycle'
  | 'invitation_mutation'
  | 'invitation_sensitive_action'
  | 'invitation_read'
  | 'access_capabilities'
  | 'oauth_grant_read'
  | 'oauth_grant_mutation'
  | 'member_read'
  | 'member_mutation'
  | 'shared_filesystem_read'
  | 'workflow_approval_medium_read'
  | 'workflow_approval_medium_mutation'
  | 'notification_preference_read'
  | 'notification_preference_mutation'
  | 'authentication_attempt'
  | 'session_verify'
  | 'rpc_token'

export type ExternalUserRateLimitStage = 'pre_auth' | 'authenticated'

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
  oauth_grant_read: { bucketType: 'external_oauth_grant_read', maxPerMinute: 30 },
  oauth_grant_mutation: { bucketType: 'external_oauth_grant_mutation', maxPerMinute: 10 },
  member_read: { bucketType: 'external_member_read', maxPerMinute: 30 },
  member_mutation: { bucketType: 'external_member_mutation', maxPerMinute: 10 },
  shared_filesystem_read: {
    bucketType: 'external_shared_filesystem_read',
    maxPerMinute: 30,
  },
  workflow_approval_medium_read: {
    bucketType: 'external_workflow_approval_medium_read',
    maxPerMinute: 30,
  },
  workflow_approval_medium_mutation: {
    bucketType: 'external_workflow_approval_medium_mutation',
    maxPerMinute: 10,
  },
  notification_preference_read: {
    bucketType: 'external_notification_preference_read',
    maxPerMinute: 30,
  },
  notification_preference_mutation: {
    bucketType: 'external_notification_preference_mutation',
    maxPerMinute: 10,
  },
  authentication_attempt: {
    bucketType: 'external_authentication_attempt',
    maxPerMinute: 5,
  },
  session_verify: { bucketType: 'external_session_verify', maxPerMinute: 10 },
  rpc_token: { bucketType: 'external_rpc_token', maxPerMinute: 10 },
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
  stage: ExternalUserRateLimitStage,
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

/**
 * Typed policy selection for explicit route composition. The route passes
 * these options to the one canonical rateLimitMiddleware enforcement path.
 */
export function externalUserRateLimitOptions(
  operation: ExternalUserRateLimitOperation,
  stage: ExternalUserRateLimitStage
) {
  const policy = POLICIES[operation]
  return {
    bucketType: policy.bucketType,
    maxPerMinute: policy.maxPerMinute,
    getBucketKey: (req: Request) => keyFor(operation, stage, req as AuthenticatedRequest),
    onLimited: sendLimited,
  }
}

/** Compose before an authenticated-stage limiter to fail closed on bad wiring. */
export function requireAuthenticatedExternalUserRateLimitContext(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  if (!req.externalAuth?.userId) {
    sendPublicApiError(req, res, 401, 'invalid_session', 'The session is not valid.')
    return
  }
  next()
}

export const externalUserRateLimitPolicy = Object.freeze({ keyFor })
