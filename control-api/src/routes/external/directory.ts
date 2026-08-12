import { Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import { config } from '../../config.js'
import {
  requireExternalTeamParamMatch,
  requireValidExternalSessionToken,
} from '../../middleware/externalSessionAuth.js'
import { searchDirectory } from '../../services/directory/index.js'

export function createExternalDirectoryRouter(): Router {
  const router = Router()
  const externalDirectoryRateLimit = rateLimit({
    windowMs: 60_000,
    limit: config.approvalRlExternalPerMin,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  })
  router.use('/external/directory', externalDirectoryRateLimit, requireValidExternalSessionToken)

  router.get(
    '/external/directory/search',
    requireExternalTeamParamMatch(),
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
