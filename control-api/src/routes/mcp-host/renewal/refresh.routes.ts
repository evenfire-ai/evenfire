import { Router } from 'express'
import { config } from '../../../config.js'
import { mcpHostHttpMetrics } from '../../../middleware/mcpHostHttpMetrics.js'
import { rateLimitMiddleware } from '../../../middleware/rateLimitMiddleware.js'
import {
  mcpHostJwtRefreshDurationSeconds,
  mcpHostJwtRefreshTotal,
} from '../../../observability/metrics.js'
import {
  consumeRefreshJti,
  getMcpHostRefreshRateLimitKey,
  issueMcpHostAccessJwt,
  issueMcpHostControlJwt,
  issueMcpHostRefreshJwt,
  verifyMcpHostRefreshJwt,
} from '../../../utils/auth/mcpHostJwtToken.js'
import { extractBearerToken } from '../../../utils/extractBearerToken.js'
import { type RenewalHostGateway, resolveRenewalHostBinding } from './hostBinding.js'

export function createMcpHostRefreshRoutes(gateway: RenewalHostGateway): Router {
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
      onBackendUnavailable: 'process-memory',
    }),
    (req, res, next) => {
      void (async () => {
        const refreshStart = process.hrtime.bigint()
        // Binding labels share their names with the reissue counter so the two
        // can be compared. `race_lost` is refresh-only and is not reissue's
        // `revoked`: here a jti already consumed at verify time lands in `failed`.
        type ResultLabel =
          | 'success'
          | 'failed'
          | 'host_unavailable'
          | 'host_mismatch'
          | 'lineage_without_audience'
          | 'race_lost'
        let resultLabel: ResultLabel = 'failed'
        try {
          const token = extractBearerToken(req)
          if (!token) {
            req.log?.info(
              { event: 'auth_denied', reason: 'missing_bearer', route: 'workflow_auth_refresh' },
              'auth denied'
            )
            return res.status(401).json({ error: 'Unauthorized' })
          }

          // Verify without consuming: the Host lookup below can fail transiently,
          // and a consumed jti cannot be retried.
          const claims = await verifyMcpHostRefreshJwt(token)
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

          const binding = await resolveRenewalHostBinding(gateway, claims)
          if (binding.kind === 'unavailable') {
            resultLabel = 'host_unavailable'
            req.log?.warn(
              { event: 'host_state_unavailable', route: 'workflow_auth_refresh' },
              'host lookup failed; refresh token left unconsumed'
            )
            return res.status(503).json({ error: 'host_state_unavailable' })
          }
          if (binding.kind === 'denied') {
            resultLabel =
              binding.reason === 'hcc_lineage_without_audience'
                ? 'lineage_without_audience'
                : 'host_mismatch'
            req.log?.info(
              { event: 'auth_denied', reason: binding.reason, route: 'workflow_auth_refresh' },
              'auth denied'
            )
            return res.status(401).json({ error: 'Unauthorized' })
          }

          const consumed = await consumeRefreshJti(claims.jti, claims.exp)
          if (!consumed) {
            resultLabel = 'race_lost'
            req.log?.info(
              { event: 'auth_denied', reason: 'jti_race_lost', route: 'workflow_auth_refresh' },
              'auth denied'
            )
            return res.status(401).json({ error: 'Unauthorized' })
          }

          const { hccCredential } = binding

          // Preserve hostRefs from the incoming refresh token so the host
          // identity binding (1st-party hostRefs[0]) survives rotation.
          const access = issueMcpHostAccessJwt(
            claims.recipeNamespace,
            claims.recipeName,
            claims.hostRefs,
            { workflowControlScopes: claims.workflowControlScopes, hccCredential }
          )
          const refresh = issueMcpHostRefreshJwt(
            claims.recipeNamespace,
            claims.recipeName,
            claims.hostRefs,
            { workflowControlScopes: claims.workflowControlScopes, hccCredential }
          )
          const control = issueMcpHostControlJwt(
            claims.recipeNamespace,
            claims.recipeName,
            claims.hostRefs,
            { scopes: claims.workflowControlScopes, hccCredential }
          )
          if (control.scopeStripped) {
            req.log?.warn(
              { event: 'oauth_user_token_scope_stripped', route: 'refresh' },
              'oauth:user-token dropped from a non-HCC control token'
            )
          }
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
