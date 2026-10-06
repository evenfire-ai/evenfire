import type { Request, RequestHandler } from 'express'
import { ipKeyGenerator, rateLimit } from 'express-rate-limit'
import { config } from '../config.js'
import { verifyInternalControlJwt } from '../utils/auth/internalControlToken.js'
import {
  mcpHostRateLimitBucketKey,
  mcpHostVerifiedRateLimitPrincipal,
  verifyMcpHostAccessJwt,
} from '../utils/auth/mcpHostJwtToken.js'
import { extractBearerToken } from '../utils/extractBearerToken.js'
import { CalendarMinuteRateLimitStore } from './calendarMinuteRateLimitStore.js'
import type { UiAuthedRequest } from './controlUIAuth.js'
import { rateLimitMiddleware } from './rateLimitMiddleware.js'

export function pluginWorkloadSdkRequestBucketKey(req: Request): string {
  return (
    mcpHostRateLimitBucketKey(
      'plugin_workload_sdk_request',
      req.mcpHostJwt,
      'plugin_workload_sdk_request:unauthenticated'
    ) ?? 'plugin_workload_sdk_request:unauthenticated'
  )
}

export function pluginWorkloadSdkCredentialBucketKey(req: Request): string | null {
  return mcpHostRateLimitBucketKey('plugin_workload_sdk_credential', req.mcpHostJwt)
}

const preauthPrincipalCache = new WeakMap<Request, string | null>()

function verifiedPluginSdkPreauthPrincipal(req: Request): string | null {
  const cached = preauthPrincipalCache.get(req)
  if (cached !== undefined) return cached
  const principal =
    mcpHostVerifiedRateLimitPrincipal(verifyMcpHostAccessJwt(extractBearerToken(req))) || null
  preauthPrincipalCache.set(req, principal)
  return principal
}

/**
 * Anonymous and invalid credentials stay on the source-IP pre-auth ceiling.
 * A verified Host principal gets a separate allowance so that ceiling cannot
 * silently cap authenticated SDK traffic.
 */
export function pluginSdkPreauthAssignment(principal: string | null): {
  limit: number
  key: string | null
} {
  if (principal) {
    return {
      limit: config.pluginSdkAuthenticatedPreauthRlPerMin,
      key: `plugin_workload_sdk_preauth:${principal}`,
    }
  }
  return { limit: config.pluginSdkPreauthRlPerMin, key: null }
}

/**
 * Bound signature verification per source IP before any limiter that needs a
 * verified principal to pick its bucket. Only requests presenting a bearer
 * token reach the verifier, so only they are counted. The budget equals the
 * verified SDK allowance: invalid credentials still stop at the IP600 ceiling
 * and valid callers behind a flooded IP keep passing until this budget, after
 * which further tokens from that IP are denied without being verified.
 */
export function createPluginWorkloadSdkVerificationBudgetRateLimit(): RequestHandler {
  return rateLimit({
    windowMs: 60_000,
    limit: config.pluginSdkAuthenticatedPreauthRlPerMin,
    skip: req => extractBearerToken(req) === '',
    keyGenerator: req =>
      `plugin_workload_sdk_verification:ip:${ipKeyGenerator(req.ip || 'unknown')}`,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too Many Requests', retryable: true },
  })
}

export function createPluginWorkloadSdkAnonymousPreauthRateLimit(): RequestHandler {
  return rateLimit({
    windowMs: 60_000,
    limit: config.pluginSdkPreauthRlPerMin,
    skip: req => verifiedPluginSdkPreauthPrincipal(req) !== null,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too Many Requests', retryable: true },
  })
}

export function createPluginWorkloadSdkAuthenticatedPreauthRateLimit(): RequestHandler {
  return rateLimit({
    windowMs: 60_000,
    store: new CalendarMinuteRateLimitStore(),
    limit: config.pluginSdkAuthenticatedPreauthRlPerMin,
    skipSuccessfulRequests: false,
    skipFailedRequests: false,
    skip: req => verifiedPluginSdkPreauthPrincipal(req) === null,
    keyGenerator: req => {
      const assignment = pluginSdkPreauthAssignment(verifiedPluginSdkPreauthPrincipal(req))
      return assignment.key ?? 'plugin_workload_sdk_preauth:unauthenticated'
    },
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too Many Requests', retryable: true },
  })
}

const internalEdgePrincipalCache = new WeakMap<Request, string | null>()

function verifiedInternalSdkEdgePrincipal(req: Request): string | null {
  const cached = internalEdgePrincipalCache.get(req)
  if (cached !== undefined) return cached
  const token = extractBearerToken(req)
  const claims = token && token.length <= 4096 ? verifyInternalControlJwt(token) : null
  // Lossless UTF-16 encoding avoids the reserved source-IP delimiter and URI
  // encoder errors for any string accepted by the existing signed verifier.
  // This is edge attribution, never route authorization.
  const principal = claims
    ? `${claims.iss}:${Buffer.from(claims.sub, 'utf16le').toString('base64url')}`
    : null
  internalEdgePrincipalCache.set(req, principal)
  return principal
}

/** Protect JWT verification without combining verified internal callers behind one IP. */
export function createPluginWorkloadSdkInternalEdgeRateLimit(): RequestHandler {
  return rateLimit({
    windowMs: 60_000,
    store: new CalendarMinuteRateLimitStore(),
    limit: req =>
      verifiedInternalSdkEdgePrincipal(req) !== null ? config.pluginSdkInternalRlPerMin : 600,
    keyGenerator: req => {
      const principal = verifiedInternalSdkEdgePrincipal(req)
      return principal !== null
        ? `plugin_workload_sdk_internal_edge:${principal}`
        : `plugin_workload_sdk_internal_edge:ip:${ipKeyGenerator(req.ip || 'unknown')}`
    },
    skipSuccessfulRequests: false,
    skipFailedRequests: false,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too Many Requests', retryable: true },
  })
}

/**
 * Distributed recipe-scoped guard for all authenticated SDK gateway routes.
 * The pre-auth IP limiter cannot provide caller isolation, while this PG
 * bucket cannot protect JWT verification; both layers are intentional.
 */
export function createPluginWorkloadSdkRequestRateLimit(): RequestHandler {
  return rateLimitMiddleware({
    bucketType: 'plugin_workload_sdk_request',
    // Keep the shared authenticated bucket above the provider-attempt burst
    // budget. Credential-ticket issuance/introspection have their own tighter
    // bucket; status and notification traffic must not starve each other.
    // ENV-tunable platform limit (issue #348): CONTROL_API_PLUGIN_SDK_REQUEST_BUCKET_PER_MIN.
    maxPerMinute: config.pluginSdkRequestBucketRlPerMin,
    getBucketKey: pluginWorkloadSdkRequestBucketKey,
    onBackendUnavailable: 'process-memory',
  })
}

/** WRC revocation is idempotent but still takes advisory locks and writes an audit row. */
export function createPluginWorkloadSdkInternalRateLimit(): RequestHandler {
  return rateLimitMiddleware({
    bucketType: 'plugin_workload_sdk_internal',
    maxPerMinute: config.pluginSdkInternalRlPerMin,
    getBucketKey: req => {
      const claims = req.internalControl
      if (!claims) return 'plugin_workload_sdk_internal:unauthenticated'
      return `plugin_workload_sdk_internal:${claims.iss}:${claims.sub}`
    },
    onBackendUnavailable: 'process-memory',
  })
}

/**
 * Operator grant/quota/audit routes are authenticated, but they still need a
 * principal-scoped distributed abuse budget. Use a sentinel for an unexpected
 * missing claim so a middleware ordering regression cannot silently bypass the
 * limiter.
 */
export function createPluginWorkloadSdkAdminRateLimit(): RequestHandler {
  return rateLimitMiddleware({
    bucketType: 'plugin_workload_sdk_admin',
    maxPerMinute: config.pluginSdkAdminRlPerMin,
    getBucketKey: req => {
      const sub = (req as UiAuthedRequest).adminAuth?.sub
      return `plugin_workload_sdk_admin:${sub || 'unauthenticated'}`
    },
    onBackendUnavailable: 'process-memory',
  })
}
