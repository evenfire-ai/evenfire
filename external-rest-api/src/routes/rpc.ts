import { Router } from 'express'
import { type AuthedRequest, extractAuthToken, requireAuth } from '../middleware/auth.js'
import { issueRpcAccessToken } from '../services/rpcService.js'

export function createRpcRouter(): Router {
  const router = Router()

  router.post('/rpc/token', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      const sessionToken = extractAuthToken(req)
      if (!sessionToken) {
        res.status(401).json({ error: 'Unauthorized' })
        return
      }
      const result = await issueRpcAccessToken(sessionToken, req.body?.scopes, req.body?.hostRefs)
      if ('error' in result) {
        // Relay control-api's specific reason (e.g. desktop_requires_team) so the
        // desktop app can act on it instead of surfacing an opaque "no access".
        res.status(403).json({ error: result.error })
        return
      }

      res.status(200).json(result)
    } catch (error) {
      next(error)
    }
  })

  return router
}
