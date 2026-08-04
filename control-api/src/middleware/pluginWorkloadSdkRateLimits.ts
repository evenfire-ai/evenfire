import type { RequestHandler } from 'express'
import { rateLimit } from 'express-rate-limit'
import { rateLimitMiddleware } from './rateLimitMiddleware.js'

/**
 * High-ceiling IP guard placed before mcp-host/internal JWT verification.
 * Business quotas and the authenticated recipe limiter remain separate: this
 * layer only bounds unauthenticated crypto work (the outer app owns the JSON
 * body-size/parser boundary).
 */
export function createPluginWorkloadSdkPreAuthRateLimit(): RequestHandler {
  return rateLimit({
    windowMs: 60_000,
    limit: 600,
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
    maxPerMinute: 600,
    getBucketKey: req => {
      const claims = req.mcpHostJwt
      if (!claims) return 'plugin_workload_sdk_request:unauthenticated'
      return `plugin_workload_sdk_request:${claims.recipeNamespace}/${claims.recipeName}`
    },
  })
}

/** WRC revocation is idempotent but still takes advisory locks and writes an audit row. */
export function createPluginWorkloadSdkInternalRateLimit(): RequestHandler {
  return rateLimitMiddleware({
    bucketType: 'plugin_workload_sdk_internal',
    maxPerMinute: 120,
    getBucketKey: req => {
      const claims = req.internalControl
      if (!claims) return 'plugin_workload_sdk_internal:unauthenticated'
      return `plugin_workload_sdk_internal:${claims.iss}:${claims.sub}`
    },
  })
}
