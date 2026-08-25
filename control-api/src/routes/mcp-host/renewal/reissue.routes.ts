import { Router } from 'express'
import { config } from '../../../config.js'
import { mcpHostHttpMetrics } from '../../../middleware/mcpHostHttpMetrics.js'
import { rateLimitMiddleware } from '../../../middleware/rateLimitMiddleware.js'
import { mcpHostJwtReissueTotal } from '../../../observability/metrics.js'
import {
  MCP_HOST_CREDENTIAL_CAPABILITY,
  consumeExpiredRefreshJti,
  getMcpHostExpiredRefreshRateLimitKey,
  issueMcpHostAccessJwt,
  issueMcpHostControlJwt,
  issueMcpHostRefreshJwt,
  verifyExpiredMcpHostRefreshJwtDetailed,
} from '../../../utils/auth/mcpHostJwtToken.js'
import { extractBearerToken } from '../../../utils/extractBearerToken.js'

export function createMcpHostReissueRoutes(): Router {
  const router = Router()

  function bodyString(body: unknown, snakeKey: string, camelKey: string): string | undefined {
    if (!body || typeof body !== 'object') return undefined
    const value = (body as Record<string, unknown>)[snakeKey]
    if (typeof value === 'string') return value
    const camelValue = (body as Record<string, unknown>)[camelKey]
    return typeof camelValue === 'string' ? camelValue : undefined
  }

  router.post(
    '/workflow-auth/reissue',
    mcpHostHttpMetrics('workflow_auth_reissue'),
    rateLimitMiddleware({
      bucketType: 'reissue_jti',
      maxPerMinute: config.approvalRlReissuePerMin,
      getBucketKey: req => {
        const token = extractBearerToken(req)
        if (!token) return null
        const key = getMcpHostExpiredRefreshRateLimitKey(token)
        return key ? `reissue:${key}` : null
      },
    }),
    (req, res, next) => {
      void (async () => {
        type ResultLabel =
          | 'ok'
          | 'invalid_sig'
          | 'invalid_claims'
          | 'expired_beyond_reissue_grace'
          | 'revoked'
          | 'mismatch'
          | 'bad_request'
        let resultLabel: ResultLabel = 'invalid_sig'
        try {
          const token = extractBearerToken(req)
          if (!token) {
            resultLabel = 'bad_request'
            req.log?.info(
              { event: 'auth_denied', reason: 'missing_bearer', route: 'workflow_auth_reissue' },
              'auth denied'
            )
            return res.status(401).json({ error: 'Unauthorized' })
          }

          const verification = await verifyExpiredMcpHostRefreshJwtDetailed(token)
          if (!verification.ok) {
            resultLabel = verification.reason
            req.log?.info(
              {
                event: 'auth_denied',
                reason: verification.reason,
                route: 'workflow_auth_reissue',
              },
              'auth denied'
            )
            return res.status(401).json({ error: 'Unauthorized' })
          }
          const claims = verification.claims

          const body = req.body ?? {}
          let mode: 'workflow' | 'standalone_host'
          let hostRef: string | undefined
          if (claims.recipeNamespace === config.sandboxNamespace) {
            mode = 'workflow'
            const recipeNameInput = bodyString(body, 'recipe_name', 'recipeName')?.trim()
            if (!recipeNameInput) {
              resultLabel = 'bad_request'
              req.log?.info(
                {
                  event: 'auth_denied',
                  reason: 'missing_recipe_name',
                  route: 'workflow_auth_reissue',
                  mode,
                },
                'auth denied'
              )
              return res.status(401).json({ error: 'Unauthorized' })
            }
            if (recipeNameInput !== claims.recipeName) {
              resultLabel = 'mismatch'
              req.log?.info(
                {
                  event: 'auth_denied',
                  reason: 'recipe_name_mismatch',
                  route: 'workflow_auth_reissue',
                  mode,
                },
                'auth denied'
              )
              return res.status(401).json({ error: 'Unauthorized' })
            }
          } else if (claims.recipeNamespace === config.hostsNamespace) {
            mode = 'standalone_host'
            const hostRefInput = bodyString(body, 'host_ref', 'hostRef')?.trim()
            hostRef = claims.hostRefs[0]?.trim()
            if (!hostRefInput) {
              resultLabel = 'bad_request'
              req.log?.info(
                {
                  event: 'auth_denied',
                  reason: 'missing_host_ref',
                  route: 'workflow_auth_reissue',
                  mode,
                },
                'auth denied'
              )
              return res.status(401).json({ error: 'Unauthorized' })
            }
            if (!hostRef || hostRefInput !== hostRef) {
              resultLabel = 'mismatch'
              req.log?.info(
                {
                  event: 'auth_denied',
                  reason: 'host_ref_mismatch',
                  route: 'workflow_auth_reissue',
                  mode,
                },
                'auth denied'
              )
              return res.status(401).json({ error: 'Unauthorized' })
            }
          } else {
            resultLabel = 'mismatch'
            req.log?.info(
              {
                event: 'auth_denied',
                reason: 'unsupported_reissue_namespace',
                route: 'workflow_auth_reissue',
              },
              'auth denied'
            )
            return res.status(401).json({ error: 'Unauthorized' })
          }

          const consumed = await consumeExpiredRefreshJti(claims.jti, claims.exp)
          if (!consumed) {
            resultLabel = 'revoked'
            req.log?.info(
              { event: 'auth_denied', reason: 'jti_race_lost', route: 'workflow_auth_reissue' },
              'auth denied'
            )
            return res.status(401).json({ error: 'Unauthorized' })
          }

          const hccCredential = claims.mcpCapabilities.includes(MCP_HOST_CREDENTIAL_CAPABILITY)
            ? { hostUid: claims.host_uid! }
            : undefined

          // Preserve hostRefs from the incoming (expired) refresh token so
          // the host identity binding survives the recovery re-issue.
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
            { scopes: claims.workflowControlScopes }
          )
          resultLabel = 'ok'

          req.log?.info(
            {
              event: 'workflow_auth_reissued',
              mode,
              hccQualified: hccCredential !== undefined,
            },
            'workflow auth re-issued'
          )

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
          mcpHostJwtReissueTotal.inc({ result: resultLabel }, 1)
        }
      })()
    }
  )

  return router
}
