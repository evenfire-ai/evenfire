import { Router } from 'express'
import {
  requireExternalRole,
  requireExternalTeamParamMatch,
  requireValidExternalSessionToken,
} from '../../middleware/externalSessionAuth.js'
import { searchDirectory } from '../../services/directory/index.js'

export function createExternalDirectoryRouter(): Router {
  const router = Router()
  router.use('/external/directory', requireValidExternalSessionToken)

  router.get(
    '/external/directory/search',
    requireExternalTeamParamMatch(),
    requireExternalRole(['admin', 'inviter']),
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
