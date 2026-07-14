import { Router } from 'express'
import { config } from '../../../config.js'
import { mcpHostHttpMetrics } from '../../../middleware/mcpHostHttpMetrics.js'
import { rateLimitMiddleware } from '../../../middleware/rateLimitMiddleware.js'
import {
  mcpHostJwtRefreshDurationSeconds,
  mcpHostJwtRefreshTotal,
} from '../../../observability/metrics.js'
import {
  consumeMcpHostRefreshJwt,
  getMcpHostRefreshRateLimitKey,
  issueMcpHostAccessJwt,
  issueMcpHostControlJwt,
  issueMcpHostRefreshJwt,
} from '../../../utils/auth/mcpHostJwtToken.js'
import { extractBearerToken } from '../../../utils/extractBearerToken.js'

export function createMcpHostRefreshRoutes(): Router {
  const router = Router()

  router.post(
    '/workflow-auth/refresh',
    mcpHostHttpMetrics('workflow_auth_refresh'),
    rateLimitMiddleware({
      bucketType: 'refresh_jti',
      maxPerMinute: config.approvalRlRefreshPerMin,
      getBucketKey: req => {
        const token = extractBearerToken(req)
        if (!token) return null
        const key = getMcpHostRefreshRateLimitKey(token)
        return key ? `refresh:${key}` : null
      },
    }),
    (req, res, next) => {
      void (async () => {
        const refreshStart = process.hrtime.bigint()
        let resultLabel: 'success' | 'failed' = 'failed'
        try {
          const token = extractBearerToken(req)
          if (!token) {
            req.log?.info(
              { event: 'auth_denied', reason: 'missing_bearer', route: 'workflow_auth_refresh' },
              'auth denied'
            )
            return res.status(401).json({ error: 'Unauthorized' })
          }

          const claims = await consumeMcpHostRefreshJwt(token)
          if (!claims) {
            req.log?.info(
              {
                event: 'auth_denied',
                reason: 'invalid_refresh_token',
                route: 'workflow_auth_refresh',
              },
              'auth denied'
            )
            return res.status(401).json({ error: 'Unauthorized' })
          }

          // Preserve hostRefs from the incoming refresh token so the host
          // identity binding (1st-party hostRefs[0]) survives rotation.
          const access = issueMcpHostAccessJwt(
            claims.recipeNamespace,
            claims.recipeName,
            claims.hostRefs,
            { workflowControlScopes: claims.workflowControlScopes }
          )
          const refresh = issueMcpHostRefreshJwt(
            claims.recipeNamespace,
            claims.recipeName,
            claims.hostRefs,
            { workflowControlScopes: claims.workflowControlScopes }
          )
          const control = issueMcpHostControlJwt(
            claims.recipeNamespace,
            claims.recipeName,
            claims.hostRefs,
            { scopes: claims.workflowControlScopes }
          )
          resultLabel = 'success'

          return res.status(200).json({
            accessToken: access.token,
            refreshToken: refresh.token,
            mcpHostControlToken: control.token,
            expiresInSeconds: access.expiresInSeconds,
            controlExpiresInSeconds: control.expiresInSeconds,
          })
        } catch (err) {
          next(err)
        } finally {
          mcpHostJwtRefreshTotal.inc({ result: resultLabel }, 1)
          const dur = Number(process.hrtime.bigint() - refreshStart) / 1e9
          mcpHostJwtRefreshDurationSeconds.observe({ result: resultLabel }, dur)
        }
      })()
    }
  )

  return router
}
