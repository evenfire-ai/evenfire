import { Router } from 'express'
import { type AuthedRequest, extractAuthToken, requireAuth } from '../middleware/auth.js'
import { searchDirectory } from '../services/directoryService.js'

export function createDirectoryRouter(): Router {
  const router = Router()

  router.get('/directory/search', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      const auth = req.auth!
      const sessionToken = extractAuthToken(req)
      const q = String(req.query.q || '').trim()
      if (!q) {
        res.status(200).json({ items: [] })
        return
      }

      res.status(200).json(await searchDirectory(auth.teamId, q, sessionToken))
    } catch (error) {
      next(error)
    }
  })

  return router
}
