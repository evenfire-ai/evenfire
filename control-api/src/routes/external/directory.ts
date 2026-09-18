import { Router } from 'express'
import { config } from '../../config.js'
import { sendPublicApiError } from '../../http/publicApiError.js'
import { attachAccessExecutionBudget } from '../../middleware/accessExecutionBudget.js'
import { createExternalClientRateLimiters } from '../../middleware/externalClientIdentity.js'
import {
  type ExternalAuthedRequest,
  requireExternalRoleWithPublicErrors,
  requireExternalTeamParamMatchWithPublicErrors,
  requireValidExternalSessionTokenWithPublicErrors,
} from '../../middleware/externalSessionAuth.js'
import { rateLimitMiddleware } from '../../middleware/rateLimitMiddleware.js'
import {
  DIRECTORY_SEARCH_MAX_QUERY_LENGTH,
  DirectorySearchCursorError,
  searchDirectory,
} from '../../services/directory/index.js'

export function createExternalDirectoryRouter(): Router {
  const router = Router()
  const externalDirectoryRateLimits = createExternalClientRateLimiters(
    'directory',
    config.approvalRlExternalClientIpPerMin,
    config.approvalRlExternalEdgePerMin
  )
  router.use(
    '/external/directory',
    ...externalDirectoryRateLimits,
    requireValidExternalSessionTokenWithPublicErrors,
    attachAccessExecutionBudget
  )

  router.get(
    '/external/directory/search',
    requireExternalTeamParamMatchWithPublicErrors(),
    requireExternalRoleWithPublicErrors(['admin', 'inviter']),
    rateLimitMiddleware({
      bucketType: 'external_directory_search',
      maxPerMinute: 30,
      getBucketKey: req => {
        const external = req as ExternalAuthedRequest
        return `directory-search:${external.externalAuth?.userId || 'unknown'}`
      },
      onLimited: (req, res, retryAfterSeconds) => {
        sendPublicApiError(
          req,
          res,
          429,
          'rate_limited',
          'Too many directory searches; retry later.',
          true,
          { retryAfterSeconds }
        )
      },
    }),
    async (req: ExternalAuthedRequest, res, next) => {
      try {
        const teamId = String(req.query.teamId || '').trim()
        const q = String(req.query.q || '').trim()
        const cursor = typeof req.query.cursor === 'string' ? req.query.cursor.trim() : undefined
        if (!teamId || !q || q.length > DIRECTORY_SEARCH_MAX_QUERY_LENGTH) {
          sendPublicApiError(req, res, 400, 'invalid_request', 'Invalid directory search request.')
          return
        }
        return res.status(200).json(await searchDirectory(teamId, q, cursor))
      } catch (error) {
        if (error instanceof DirectorySearchCursorError) {
          sendPublicApiError(req, res, 400, 'invalid_request', 'Invalid directory search cursor.')
          return
        }
        return next(error)
      }
    }
  )

  return router
}
