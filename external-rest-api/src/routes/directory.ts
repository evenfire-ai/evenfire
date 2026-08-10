import { Router } from 'express'
import { sendPublicApiError } from '../http/publicApiError.js'
import { type AuthedRequest, extractAuthToken, requireAuth } from '../middleware/auth.js'
import { searchDirectory } from '../services/directoryService.js'

export function createDirectoryRouter(): Router {
  const router = Router()

  router.get('/directory/search', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      const auth = req.auth!
      const sessionToken = extractAuthToken(req)
      const q = String(req.query.q || '').trim()
      const teamId = String(req.query.teamId || auth.teamId || '').trim()
      const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined
      if (!q) {
        res.status(200).json({ items: [], nextCursor: null })
        return
      }
      if (!teamId) {
        sendPublicApiError(req, res, 400, 'invalid_request', 'teamId is required.')
        return
      }

      res.status(200).json(await searchDirectory(teamId, q, sessionToken, cursor))
    } catch (error) {
      next(error)
    }
  })

  return router
}
