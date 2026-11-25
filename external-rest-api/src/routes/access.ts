import { Router } from 'express'
import { controlApiRequest } from '../controlApiClient.js'
import { type AuthedRequest, extractAuthToken, requireAuth } from '../middleware/auth.js'

export function createAccessRouter(): Router {
  const router = Router()
  router.use('/me/access', requireAuth)

  // Control API errors go through next(error) to the edge's public error
  // handler, which relays Control API's status and body (M-10).
  router.get('/me/access/capabilities', async (req: AuthedRequest, res, next) => {
    try {
      const result = await controlApiRequest('GET', '/external/access/capabilities', {
        userSessionToken: extractAuthToken(req),
      })
      res.status(200).json(result)
    } catch (error) {
      next(error)
    }
  })

  return router
}
