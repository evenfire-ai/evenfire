import { Router } from 'express'
import { config } from '../../config.js'
import { sendPublicApiError } from '../../http/publicApiError.js'
import { attachAccessExecutionBudget } from '../../middleware/accessExecutionBudget.js'
import { createExternalClientRateLimiters } from '../../middleware/externalClientIdentity.js'
import {
  type ExternalAuthedRequest,
  requireExternalTeamParamMatchWithPublicErrors,
  requireValidExternalSessionTokenWithPublicErrors,
} from '../../middleware/externalSessionAuth.js'
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
