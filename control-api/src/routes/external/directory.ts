import { Router } from 'express'
import type { ExternalAuthedRequest } from '../../middleware/externalSessionAuth.js'
import {
  requireExternalTeamParamMatch,
  requireValidExternalSessionToken,
} from '../../middleware/externalSessionAuth.js'
import { rateLimitMiddleware } from '../../middleware/rateLimitMiddleware.js'
import { searchDirectory } from '../../services/directory/index.js'

const DIRECTORY_SEARCH_MAX_QUERY_LENGTH = 128
const DIRECTORY_SEARCH_MAX_PER_MINUTE = 30

export function createExternalDirectoryRouter(): Router {
  const router = Router()
  router.use('/external/directory', requireValidExternalSessionToken)

  router.get(
    '/external/directory/search',
    requireExternalTeamParamMatch('teamId', 'query'),
    (req, res, next) => {
      const q = String(req.query.q || '').trim()
      if (q.length > DIRECTORY_SEARCH_MAX_QUERY_LENGTH) {
        return res.status(400).json({
          error: 'directory_query_too_long',
          maxLength: DIRECTORY_SEARCH_MAX_QUERY_LENGTH,
        })
      }
      next()
    },
    rateLimitMiddleware({
      bucketType: 'external_directory_search',
      maxPerMinute: DIRECTORY_SEARCH_MAX_PER_MINUTE,
      getBucketKey: req => {
        const externalReq = req as ExternalAuthedRequest
        const userId = externalReq.externalAuth?.userId?.trim()
        const teamId = String(req.query.teamId || '').trim()
        return userId && teamId ? `external-directory-search:${userId}:${teamId}` : null
      },
    }),
    async (req, res, next) => {
      try {
        const teamId = String(req.query.teamId || '').trim()
        const q = String(req.query.q || '').trim()
        if (!teamId) return res.status(400).json({ error: 'teamId is required' })
        return res.status(200).json({ items: await searchDirectory(teamId, q) })
      } catch (error) {
        return next(error)
      }
    }
  )

  return router
}
