import type { Request, RequestHandler } from 'express'
import { config } from '../config.js'
import { mcpHostRateLimitBucketKey } from '../utils/auth/mcpHostJwtToken.js'
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
    maxPerMinute: 120, // not ENV: not part of the plugin abuse surface (issue #348)
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
    maxPerMinute: 120, // not ENV: not part of the plugin abuse surface (issue #348)
    getBucketKey: req => {
      const sub = (req as UiAuthedRequest).adminAuth?.sub
      return `plugin_workload_sdk_admin:${sub || 'unauthenticated'}`
    },
    onBackendUnavailable: 'process-memory',
  })
}
